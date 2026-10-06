import {
	bytesToBase64,
	calculateAccountsHash,
	consensusIdenticalAggregation,
	cre,
	encodeForwarderReport,
	prepareSolanaReportRequest,
	solanaAccountMeta,
	solanaAccountMetasToJson,
	type HTTPPayload,
	type NodeRuntime,
	type Runtime,
	type TeeRuntime,
} from '@chainlink/cre-sdk'
import { PublicKey } from '@solana/web3.js'
import { z } from 'zod'
import { ReviewReason, VERDICT, policyHash, txHash } from '../../../packages/shared/src/index'
import { base64ToBytes, buildPayload, decideDestination, parseGuardConfig, parseReview, planReview, SQUADS_PROGRAM, type AccountSnapshot, type Decision, type Policy } from './review-logic'
import { normalizeSnapshot, selectQuorum, type SnapshotAccount } from './rpc-quorum'

// Wysiwys review workflow. HTTP trigger with identifiers only -> 2-of-3 RPC reads of the Review, the
// stored Squads transaction, the GuardConfig and the destination -> tx_hash check -> decode -> private
// policy and Scorechain screening inside the TEE -> 117-byte report through the Keystone forwarder to
// the guard's on_report. Contract: docs/specs/guard-cre-interface.md.

const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
export const configSchema = z
	.object({
		chainSelector: z.string().regex(/^\d+$/),
		guardProgram: address,
		forwarderProgram: address,
		forwarderState: address,
		decoderVersion: z.string().min(1),
		approvalSeconds: z.number().int().positive(),
		maxSlotLag: z.number().int().nonnegative().max(128),
		computeLimit: z.number().int().positive().max(300_000),
		screening: z.boolean(),
		authorizedKeys: z.array(z.string()),
	})
	.strict()
export type Config = z.infer<typeof configSchema>

const requestSchema = z.object({ multisig: address, txIndex: z.string().regex(/^\d{1,20}$/) }).strict()
const RPC_SECRETS = ['QUICKNODE_SOLANA_DEVNET_RPC_URL', 'HELIUS_SOLANA_DEVNET_RPC_URL', 'ALCHEMY_SOLANA_DEVNET_RPC_URL'] as const
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'

const u64le = (n: bigint) => {
	const b = new Uint8Array(8)
	new DataView(b.buffer).setBigUint64(0, n, true)
	return b
}
const utf8 = (s: string) => new TextEncoder().encode(s)
const pda = (seeds: Uint8Array[], program: string) => PublicKey.findProgramAddressSync(seeds, new PublicKey(program))[0]

function rpc(node: NodeRuntime<Config>, endpoint: string, method: string, params: unknown[]): unknown {
	const response = new cre.capabilities.HTTPClient()
		.sendRequest(node, {
			url: endpoint,
			method: 'POST',
			timeout: '5s',
			multiHeaders: { 'Content-Type': { values: ['application/json'] } },
			body: bytesToBase64(utf8(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))),
			cacheSettings: { store: false },
		})
		.result()
	if (response.statusCode !== 200) throw new Error('HTTP failure')
	return JSON.parse(new TextDecoder().decode(response.body))
}

/** Per node: every provider must be on devnet; agreed account contents from 2 of 3. */
function readAccounts(node: NodeRuntime<Config>, endpoints: string[], addresses: string[]): string {
	const slots = endpoints.map((endpoint) => {
		try {
			const genesis = (rpc(node, endpoint, 'getGenesisHash', []) as { result?: unknown }).result
			if (genesis !== DEVNET_GENESIS) return null
			const slot = (rpc(node, endpoint, 'getSlot', [{ commitment: 'finalized' }]) as { result?: unknown }).result
			return typeof slot === 'number' && Number.isSafeInteger(slot) ? slot : null
		} catch {
			return null
		}
	})
	const valid = slots.filter((s): s is number => s !== null).sort((a, b) => a - b)
	if (valid.length < 2) throw new Error('RPC_NO_QUORUM')
	const floor = Math.max(0, valid[Math.floor((valid.length - 1) / 2)]! - node.config.maxSlotLag)
	const observations = endpoints.map((endpoint, i) => {
		if (slots[i] === null) return null
		try {
			const raw = rpc(node, endpoint, 'getMultipleAccounts', [addresses, { commitment: 'finalized', encoding: 'base64', minContextSlot: floor }])
			return normalizeSnapshot(raw, addresses, floor)
		} catch {
			return null
		}
	})
	return selectQuorum(observations)
}

function readAgreed(don: Runtime<Config>, endpoints: string[], addresses: string[]): Array<AccountSnapshot | null> {
	const agreed = don.runInNodeMode(readAccounts, consensusIdenticalAggregation<string>())(endpoints, addresses).result()
	return (JSON.parse(agreed) as SnapshotAccount[]).map((a) => (a ? { address: a.address, owner: a.owner, data: base64ToBytes(a.data) } : null))
}

/** Scorechain sanctions screening of the recipient wallet, from inside the enclave. */
function screen(runtime: TeeRuntime<Config>, wallet: string): 'SANCTIONED' | 'NO_SANCTIONS_MATCH' {
	const apiKey = runtime.getSecret({ id: 'SCORECHAIN_SANCTIONS_API_KEY' }).result().value
	const response = new cre.capabilities.HTTPClient()
		.sendRequest(runtime, {
			url: `https://sanctions.api.scorechain.com/v1/addresses/${encodeURIComponent(wallet)}`,
			method: 'GET',
			multiHeaders: { 'x-api-key': { values: [apiKey] } },
			cacheSettings: { store: false },
		})
		.result()
	if (response.statusCode !== 200) throw new Error(`SCREENING_UNAVAILABLE (HTTP ${response.statusCode})`)
	const parsed: unknown = JSON.parse(new TextDecoder().decode(response.body))
	const records = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ isSanctioned?: unknown }>
	if (!records.length || records.some((r) => typeof r?.isSanctioned !== 'boolean')) throw new Error('SCREENING_UNRECOGNIZED')
	return records.some((r) => r.isSanctioned === true) ? 'SANCTIONED' : 'NO_SANCTIONS_MATCH'
}

export function onReview(runtime: TeeRuntime<Config>, payload: HTTPPayload): string {
	const config = configSchema.parse(runtime.config)
	const req = requestSchema.parse(JSON.parse(new TextDecoder().decode(payload.input)))
	const txIndex = BigInt(req.txIndex)
	const ms = new PublicKey(req.multisig).toBytes()
	const reviewPda = pda([utf8('review'), ms, u64le(txIndex)], config.guardProgram).toBase58()
	const configPda = pda([utf8('config'), ms], config.guardProgram).toBase58()
	const vaultTxPda = pda([utf8('multisig'), ms, utf8('transaction'), u64le(txIndex)], SQUADS_PROGRAM).toBase58()
	const vault = pda([utf8('multisig'), ms, utf8('vault'), Uint8Array.of(0)], SQUADS_PROGRAM).toBase58()

	// Chain reads and the write run on the DON; RPC credentials are operational, not confidential.
	const don = runtime.usingTheDons()
	const endpoints = RPC_SECRETS.map((id) => don.getSecret({ id }).result().value)
	const [reviewAcc, vaultTxAcc, configAcc] = readAgreed(don, endpoints, [reviewPda, vaultTxPda, configPda])
	if (!reviewAcc || !vaultTxAcc || !configAcc) throw new Error('review, stored transaction or guard config not found')
	const review = parseReview(reviewAcc, config.guardProgram)
	const guard = parseGuardConfig(configAcc, config.guardProgram)
	if (review.multisig !== req.multisig || guard.multisig !== req.multisig) throw new Error('accounts belong to another multisig')
	if (review.status !== 'pending') return JSON.stringify({ review: reviewPda, skipped: `review is already ${review.status}` })
	if (guard.forwarderProgram !== config.forwarderProgram || guard.forwarderState !== config.forwarderState) {
		throw new Error('guard config names another forwarder')
	}

	// Private policy, decrypted only inside the enclave; its commitment must equal the guard's.
	const policy = JSON.parse(runtime.getSecret({ id: 'POLICY_DOCUMENT' }).result().value) as Policy
	const commitment = policyHash(policy, config.decoderVersion)
	if (!commitment.every((b, i) => b === guard.policyHash[i])) throw new Error('POLICY_STALE: policy document does not match the guard config')

	let decision: Decision
	const recomputed = txHash(new PublicKey(vaultTxPda).toBytes(), vaultTxAcc.data)
	if (!recomputed.every((b, i) => b === review.txHash[i])) {
		decision = { verdict: VERDICT.REJECT, reason: ReviewReason.TX_HASH_MISMATCH, actionKind: 0, destinationHash: new Uint8Array(32), summary: 'stored transaction changed since review was requested' }
	} else {
		const plan = planReview(vaultTxAcc, vault, policy)
		decision = plan.kind === 'decided' ? plan.decision : decideDestination(plan.action, readAgreed(don, endpoints, [plan.destination])[0] ?? null, policy)
	}
	if (decision.verdict === VERDICT.APPROVE && config.screening && screen(runtime, decision.wallet!) === 'SANCTIONED') {
		decision = { verdict: VERDICT.REJECT, reason: ReviewReason.SCREENING_REJECTED, actionKind: 0, destinationHash: new Uint8Array(32), summary: 'recipient failed sanctions screening' }
	}

	const issuedAt = BigInt(Math.floor(don.now().getTime() / 1000))
	if (issuedAt > review.createdAt + guard.reviewDeadlineSecs) throw new Error('review deadline passed; the guard would refuse this report')
	const approval = BigInt(config.approvalSeconds) < guard.maxReviewLifetime ? BigInt(config.approvalSeconds) : guard.maxReviewLifetime
	const reportPayload = buildPayload(decision, review.txHash, guard.policyHash, issuedAt, approval)

	// Report: [forwarder state, forwarder authority, GuardConfig, Review]; the capability forwards [2..] to on_report.
	const authority = pda([utf8('forwarder'), new PublicKey(config.forwarderState).toBytes(), new PublicKey(config.guardProgram).toBytes()], config.forwarderProgram)
	const accounts = [
		solanaAccountMeta(config.forwarderState, false),
		solanaAccountMeta(authority.toBase58(), false),
		solanaAccountMeta(configPda, false),
		solanaAccountMeta(reviewPda, true),
	]
	const report = don
		.report(prepareSolanaReportRequest(encodeForwarderReport({ accountHash: calculateAccountsHash(accounts), payload: reportPayload })))
		.result()
	const write = new cre.capabilities.SolanaClient(BigInt(config.chainSelector))
		.writeReport(don, {
			receiver: bytesToBase64(new PublicKey(config.guardProgram).toBytes()),
			remainingAccounts: solanaAccountMetasToJson(accounts),
			computeConfig: { computeLimit: config.computeLimit },
			report,
		})
		.result()

	const signature = write.txSignature?.length ? bs58(write.txSignature) : null
	return JSON.stringify({
		review: reviewPda,
		verdict: decision.verdict === VERDICT.APPROVE ? 'approve' : 'reject',
		reason: decision.reason,
		summary: decision.summary,
		txStatus: write.txStatus,
		receiverStatus: write.receiverContractExecutionStatus ?? null,
		txSignature: signature,
		error: write.errorMessage || null,
	})
}

/** Base58 for a transaction signature (64 bytes). */
function bs58(bytes: Uint8Array): string {
	const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
	let n = 0n
	for (const b of bytes) n = n * 256n + BigInt(b)
	let out = ''
	while (n > 0n) {
		out = alphabet[Number(n % 58n)] + out
		n /= 58n
	}
	for (const b of bytes) {
		if (b !== 0) break
		out = '1' + out
	}
	return out
}

export function initWorkflow(config: Config) {
	return [
		cre.handlerInTee(new cre.capabilities.HTTPCapability().trigger({ authorizedKeys: config.authorizedKeys as never }), onReview, [
			{ tee: 'nitro', regions: ['us-west-2'] },
		]),
	]
}
