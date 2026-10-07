import {
	bytesToBase64,
	calculateAccountsHash,
	ConsensusAggregationByFields,
	consensusIdenticalAggregation,
	median,
	SolanaTxStatus,
	SolanaReceiverContractExecutionStatus,
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
import { ReviewReason, VERDICT, txHash } from '../../../packages/shared/src/index'
import { base64ToBytes, buildPayload, decideDestination, parseGuardConfig, parseReview, planReview, selectPolicy, SQUADS_PROGRAM, type AccountSnapshot, type Decision, type Policy } from './review-logic'
import { normalizeSnapshot, selectQuorum, type SnapshotAccount } from './rpc-quorum'

// Wysiwys review workflow. HTTP trigger with identifiers only -> 2-of-3 RPC reads of the Review, the
// stored Squads transaction, the GuardConfig and the destination -> tx_hash check -> decode -> private
// policy and Scorechain screening inside the TEE -> 117-byte report through the Keystone forwarder to
// the guard's on_report. Contract: docs/specs/guard-cre-interface.md.
// execution "don" runs the same review as a plain DON handler (live DON without Confidential Workflows
// enrollment): the policy and screening key are Vault DON secrets visible to node operators at run time.

const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
const commonConfig = {
		chainSelector: z.string().regex(/^\d+$/),
		guardProgram: address,
		decoderVersion: z.string().min(1),
		approvalSeconds: z.number().int().positive(),
		maxSlotLag: z.number().int().nonnegative().max(128),
		screening: z.boolean(),
		execution: z.enum(['tee', 'don']).default('tee'),
		authorizedKeys: z.array(z.object({ type: z.literal('KEY_TYPE_ECDSA_EVM'), publicKey: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).strict()),
}
export const configSchema = z.union([
	z.object({ ...commonConfig, mode: z.literal('report').default('report'),
		forwarderProgram: address, forwarderState: address, computeLimit: z.number().int().positive().max(300_000) }).strict(),
	z.object({ ...commonConfig, mode: z.literal('local-simulation') }).strict(),
])
export type Config = z.infer<typeof configSchema>

const requestSchema = z.object({ multisig: address, txIndex: z.string().regex(/^\d{1,20}$/)
	.refine(s => BigInt(s) > 0n && BigInt(s) <= 18446744073709551615n, 'txIndex must be a positive u64') }).strict()
const RPC_SECRETS = ['QUICKNODE_SOLANA_DEVNET_RPC_URL', 'HELIUS_SOLANA_DEVNET_RPC_URL', 'ALCHEMY_SOLANA_DEVNET_RPC_URL'] as const
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
const PROVIDERS = ['quicknode', 'helius', 'alchemy'] as const

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
	if (response.statusCode !== 200) throw new Error(`HTTP ${response.statusCode}`)
	const parsed: unknown = JSON.parse(new TextDecoder().decode(response.body))
	if (!parsed || typeof parsed !== 'object' || 'error' in parsed || !('result' in parsed) ||
		(parsed as { jsonrpc?: unknown }).jsonrpc !== '2.0' || (parsed as { id?: unknown }).id !== 1) {
		throw new Error('invalid JSON-RPC response')
	}
	return parsed
}

/** Require the three configured source domains, not three URLs to a single provider. No URL secrets in errors. */
function validateProviders(endpoints: string[]) {
	const hosts = endpoints.map(url => /^https:\/\/([a-z0-9.-]+)(?::443)?(?:[/?][^\s#]*)?$/i.exec(url)?.[1]?.toLowerCase())
	if (hosts.length !== 3 || !hosts[0]?.endsWith('.quiknode.pro') || hosts[1] !== 'devnet.helius-rpc.com' ||
		hosts[2] !== 'solana-devnet.g.alchemy.com' || new Set(hosts).size !== 3) throw new Error('RPC_PROVIDER_CONFIGURATION')
}

type ReadContext = { minContextSlot: number; eligible: string }
/** One node's health observation: the slot floor plus a 0/1 vote per provider. */
type Health = { minContextSlot: number; quicknode: number; helius: number; alchemy: number }

/**
 * Health observations vary by node (a rate-limited provider can fail on some nodes only), so every
 * field is a median: the slot floor, and per provider a majority vote of the nodes' 0/1 health flags.
 */
export const HEALTH_AGGREGATION = ConsensusAggregationByFields<Health>({
	minContextSlot: median, quicknode: median, helius: median, alchemy: median,
})

/** Providers the DON agreed are healthy, as the eligibility mask the account reads use. */
export function eligibleFrom(health: Health): string {
	return [health.quicknode, health.helius, health.alchemy].map((v) => (v >= 0.5 ? '1' : '0')).join('')
}

function readHealth(node: NodeRuntime<Config>, endpoints: string[]): Health {
	const slots = endpoints.map((endpoint, i) => {
		try {
			const genesis = (rpc(node, endpoint, 'getGenesisHash', []) as { result?: unknown }).result
			if (genesis !== DEVNET_GENESIS) throw new Error('not devnet')
			const slot = (rpc(node, endpoint, 'getSlot', [{ commitment: 'finalized' }]) as { result?: unknown }).result
			if (typeof slot !== 'number' || !Number.isSafeInteger(slot) || slot < 0) throw new Error('bad slot')
			return slot
		} catch (e) {
			node.log(`provider ${PROVIDERS[i]}: health check failed`)
			return null
		}
	})
	const valid = slots.filter((s): s is number => s !== null).sort((a, b) => a - b)
	if (valid.length < 2) throw new Error('RPC_NO_QUORUM')
	const floor = Math.max(0, valid[Math.floor((valid.length - 1) / 2)]! - node.config.maxSlotLag)
	const vote = (i: number) => (slots[i] === null ? 0 : 1)
	return { minContextSlot: floor, quicknode: vote(0), helius: vote(1), alchemy: vote(2) }
}

/** Both reads reuse the DON-agreed floor and eligible-provider set; at most 13 HTTP calls total. */
function readAccounts(node: NodeRuntime<Config>, endpoints: string[], addresses: string[], context: ReadContext): string {
	const floor = context.minContextSlot
	if (!Number.isSafeInteger(floor) || floor < 0 || !/^[01]{3}$/.test(context.eligible) ||
		context.eligible.split('').filter(v => v === '1').length < 2) throw new Error('RPC_NO_QUORUM')
	const observations = endpoints.map((endpoint, i) => {
		if (context.eligible[i] !== '1') return null
		try {
			const raw = rpc(node, endpoint, 'getMultipleAccounts', [addresses, { commitment: 'finalized', encoding: 'base64', minContextSlot: floor }])
			return normalizeSnapshot(raw, addresses, floor)
		} catch (e) {
			node.log(`provider ${PROVIDERS[i]}: account read failed`)
			return null
		}
	})
	const distinct = new Set(observations.filter((o) => o !== null)).size
	node.log(`account read: ${observations.filter((o) => o !== null).length}/3 providers answered, ${distinct} distinct snapshot(s)`)
	return selectQuorum(observations)
}

function readAgreed(don: Runtime<Config>, endpoints: string[], addresses: string[], context: ReadContext): Array<AccountSnapshot | null> {
	const agreed = don.runInNodeMode(readAccounts, consensusIdenticalAggregation<string>())(endpoints, addresses, context).result()
	return (JSON.parse(agreed) as SnapshotAccount[]).map((a) => (a ? { address: a.address, owner: a.owner, data: base64ToBytes(a.data) } : null))
}

type ScreeningResult = 'SANCTIONED' | 'NO_SANCTIONS_MATCH'

/** Scorechain sanctions screening of the recipient wallet: inside the enclave, or on each node in DON execution. */
function screenWallet(runtime: TeeRuntime<Config> | NodeRuntime<Config>, apiKey: string, wallet: string): ScreeningResult {
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

/** Confidential execution: the policy and the screening call stay inside the enclave. */
export function onReview(runtime: TeeRuntime<Config>, payload: HTTPPayload): string {
	return runReview(runtime, runtime.usingTheDons(), payload, (wallet) =>
		screenWallet(runtime, runtime.getSecret({ id: 'SCORECHAIN_SANCTIONS_API_KEY' }).result().value, wallet))
}

/** DON execution: same review; screening runs on every node and needs identical answers. */
export function onReviewDon(runtime: Runtime<Config>, payload: HTTPPayload): string {
	return runReview(runtime, runtime, payload, (wallet) => {
		const apiKey = runtime.getSecret({ id: 'SCORECHAIN_SANCTIONS_API_KEY' }).result().value
		return runtime.runInNodeMode(screenWallet, consensusIdenticalAggregation<ScreeningResult>())(apiKey, wallet).result()
	})
}

type ReviewHost = Pick<Runtime<Config>, 'config' | 'getSecret' | 'log'>

/** The POLICY_DOCUMENT secret as JSON (one document or a registry array); never echoed. */
function parseSecretJson(secret: string): unknown {
	try {
		return JSON.parse(secret)
	} catch {
		throw new Error('POLICY_INVALID: the policy secret is not valid JSON')
	}
}

function runReview(runtime: ReviewHost, don: Runtime<Config>, payload: HTTPPayload, screen: (wallet: string) => ScreeningResult): string {
	const config = configSchema.parse(runtime.config)
	const req = requestSchema.parse(JSON.parse(new TextDecoder().decode(payload.input)))
	const txIndex = BigInt(req.txIndex)
	const ms = new PublicKey(req.multisig).toBytes()
	const reviewPda = pda([utf8('review'), ms, u64le(txIndex)], config.guardProgram).toBase58()
	const configPda = pda([utf8('config'), ms], config.guardProgram).toBase58()
	const vaultTxPda = pda([utf8('multisig'), ms, utf8('transaction'), u64le(txIndex)], SQUADS_PROGRAM).toBase58()
	const vault = pda([utf8('multisig'), ms, utf8('vault'), Uint8Array.of(0)], SQUADS_PROGRAM).toBase58()

	// Chain reads and the write run on the DON; RPC credentials are operational, not confidential.
	const endpoints = RPC_SECRETS.map((id) => don.getSecret({ id }).result().value)
	validateProviders(endpoints)
	const health = don.runInNodeMode(readHealth, HEALTH_AGGREGATION)(endpoints).result()
	const context: ReadContext = { minContextSlot: Math.floor(health.minContextSlot), eligible: eligibleFrom(health) }
	const [reviewAcc, vaultTxAcc, configAcc] = readAgreed(don, endpoints, [reviewPda, vaultTxPda, configPda], context)
	if (!reviewAcc || !vaultTxAcc || !configAcc) throw new Error('review, stored transaction or guard config not found')
	const review = parseReview(reviewAcc, config.guardProgram)
	const guard = parseGuardConfig(configAcc, config.guardProgram)
	if (review.multisig !== req.multisig || guard.multisig !== req.multisig) throw new Error('accounts belong to another multisig')
	if (review.txIndex !== txIndex || review.vaultTransaction !== vaultTxPda) throw new Error('review identifiers do not match')
	if (review.status !== 'pending' && config.mode === 'report') return JSON.stringify({ review: reviewPda, skipped: `review is already ${review.status}` })
	if (config.mode === 'report' && (guard.forwarderProgram !== config.forwarderProgram || guard.forwarderState !== config.forwarderState)) {
		throw new Error('guard config names another forwarder')
	}

	// Private policy (decrypted inside the enclave in TEE execution): the registry entry the guard committed to.
	const policy = selectPolicy(parseSecretJson(runtime.getSecret({ id: 'POLICY_DOCUMENT' }).result().value), guard.policyHash, config.decoderVersion)

	let decision: Decision
	const recomputed = txHash(new PublicKey(vaultTxPda).toBytes(), vaultTxAcc.data)
	if (!recomputed.every((b, i) => b === review.txHash[i])) {
		decision = { verdict: VERDICT.REJECT, reason: ReviewReason.TX_HASH_MISMATCH, actionKind: 0, destinationHash: new Uint8Array(32), summary: 'stored transaction changed since review was requested' }
	} else {
		const plan = planReview(vaultTxAcc, vault, policy)
		decision = plan.kind === 'decided' ? plan.decision : decideDestination(plan.action, readAgreed(don, endpoints, [plan.destination], context)[0] ?? null, policy)
	}
	// Screening is part of the policy; the workflow config can only switch it off (local runs).
	if (decision.verdict === VERDICT.APPROVE && config.screening && policy.screening && screen(decision.wallet!) === 'SANCTIONED') {
		decision = { verdict: VERDICT.REJECT, reason: ReviewReason.SCREENING_REJECTED, actionKind: 0, destinationHash: new Uint8Array(32), summary: 'recipient failed sanctions screening' }
	}

	const issuedAt = BigInt(Math.floor(don.now().getTime() / 1000))
	const withinDeadline = issuedAt <= review.createdAt + guard.reviewDeadlineSecs
	if (config.mode === 'local-simulation') {
		runtime.log('Wysiwys local-simulation: review evaluated; no report generated or submitted')
		return JSON.stringify({ mode: 'local-simulation', review: reviewPda,
			verdict: decision.verdict === VERDICT.APPROVE ? 'approve' : 'reject', reason: decision.reason,
			reviewStatus: review.status, withinDeadline, reportSubmitted: false })
	}
	if (!withinDeadline) throw new Error('review deadline passed; the guard would refuse this report')
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
			// JSON form: receiver as 0x-hex (account keys stay base64).
			receiver: `0x${Array.from(new PublicKey(config.guardProgram).toBytes(), (b) => b.toString(16).padStart(2, '0')).join('')}`,
			remainingAccounts: solanaAccountMetasToJson(accounts),
			computeConfig: { computeLimit: config.computeLimit },
			report,
		})
		.result()

	// Fail on any evidence of failure. The live DON reply can omit the optional receiver status and
	// signature; that is not failure (the guard's Review account is the record), only unconfirmed here.
	const sig = write.txSignature?.length ? write.txSignature : undefined
	runtime.log(`write reply: txStatus=${write.txStatus} receiver=${write.receiverContractExecutionStatus ?? 'none'} signature=${sig?.length ?? 0}B error=${write.errorMessage ? 'yes' : 'no'}`)
	if (write.txStatus !== SolanaTxStatus.SUCCESS || write.errorMessage ||
		(write.receiverContractExecutionStatus !== undefined && write.receiverContractExecutionStatus !== SolanaReceiverContractExecutionStatus.SUCCESS) ||
		(sig !== undefined && (sig.length !== 64 || !sig.some(b => b !== 0)))) {
		throw new Error('REPORT_DELIVERY_FAILED: transaction, receiver execution or signature reported a failure')
	}
	const confirmed = sig !== undefined && write.receiverContractExecutionStatus === SolanaReceiverContractExecutionStatus.SUCCESS
	return JSON.stringify({
		review: reviewPda,
		verdict: decision.verdict === VERDICT.APPROVE ? 'approve' : 'reject',
		reason: decision.reason,
		summary: decision.summary,
		delivery: confirmed ? 'confirmed' : 'unconfirmed',
		txStatus: write.txStatus,
		receiverStatus: write.receiverContractExecutionStatus ?? null,
		txSignature: sig ? bs58(sig) : null,
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
	const trigger = new cre.capabilities.HTTPCapability().trigger({ authorizedKeys: config.authorizedKeys })
	if (config.execution === 'don') return [cre.handler(trigger, onReviewDon)]
	return [
		cre.handlerInTee(trigger, onReview, [
			{ tee: 'nitro', regions: ['us-west-2'] },
		]),
	]
}
