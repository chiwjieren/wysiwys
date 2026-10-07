import { PublicKey } from '@solana/web3.js'
import { decodeVaultTransaction, type DecodedAction } from '../../../packages/decoder/src/index'
import {
	ACTION_KIND, ReviewReason, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, VERDICT, destinationHash, encodeReportPayload,
	type PolicyInstruction, type PolicyV1,
} from '../../../packages/shared/src/index'
import idl from '../../../packages/shared/idl/wysiwys_guard.json'

// Pure, deterministic review decision (no clocks, network or randomness), shared by the CRE
// workflow and its tests. Contract: docs/specs/guard-cre-interface.md. Mirrors the stand-in
// reviewer in scripts/lib/local-review.ts.

export type AccountSnapshot = { address: string; owner: string; data: Uint8Array }
/** Policy v1, validated by parsePolicy (packages/shared). Every field is enforced here or in the workflow. */
export type Policy = PolicyV1
/** wallet: the approved recipient wallet, screened before the report is written (approvals only). */
export type Decision = { verdict: 1 | 2; reason: number; actionKind: 0 | 1 | 2; destinationHash: Uint8Array; summary: string; wallet?: string }

export const SQUADS_PROGRAM = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf'
/** Decoded payment kinds a policy can allow, with their policy instruction name and program. */
const ALLOWED_PAYMENTS: Partial<Record<DecodedAction['kind'], { instruction: PolicyInstruction; program: string }>> = {
	'system.transfer': { instruction: 'system:transfer', program: SYSTEM_PROGRAM_ID },
	'token.transferChecked': { instruction: 'spl-token:transferChecked', program: TOKEN_PROGRAM_ID },
}
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const ZERO32 = new Uint8Array(32)
const STATUSES = ['pending', 'approved', 'rejected', 'executed'] as const

const discriminator = (name: string): Uint8Array => {
	const d = (idl as { accounts: { name: string; discriminator: number[] }[] }).accounts.find((a) => a.name === name)
	if (!d) throw new Error(`IDL has no account ${name}`)
	return Uint8Array.from(d.discriminator)
}
const REVIEW_DISC = discriminator('Review')
const CONFIG_DISC = discriminator('GuardConfig')

/** Base64 to bytes without Node Buffer or atob (QuickJS). */
export function base64ToBytes(b64: string): Uint8Array {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
	const clean = b64.replace(/=+$/, '')
	const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
	let buf = 0
	let bits = 0
	let o = 0
	for (const ch of clean) {
		const v = alphabet.indexOf(ch)
		if (v < 0) throw new Error('invalid base64')
		buf = (buf << 6) | v
		bits += 6
		if (bits >= 8) {
			bits -= 8
			out[o++] = (buf >> bits) & 0xff
		}
	}
	return out
}

const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength)
const key = (d: Uint8Array, off: number) => new PublicKey(d.subarray(off, off + 32)).toBase58()
const startsWith = (d: Uint8Array, p: Uint8Array) => d.length >= p.length && p.every((b, i) => d[i] === b)

function owned(acc: AccountSnapshot, program: string, disc: Uint8Array, minLen: number, what: string) {
	if (acc.owner !== program || !startsWith(acc.data, disc) || acc.data.length < minLen) throw new Error(`not a ${what} account`)
}

/** Review: disc 8 | version 1 | multisig 32 | vault_transaction 32 | proposal 32 | tx_index 8 | tx_hash 32 | status 1 | ... | created_at at 229. */
export function parseReview(acc: AccountSnapshot, guardProgram: string) {
	owned(acc, guardProgram, REVIEW_DISC, 238, 'Review')
	const d = acc.data
	const status = STATUSES[d[145]!]
	if (!status) throw new Error('unknown review status')
	return {
		multisig: key(d, 9),
		vaultTransaction: key(d, 41),
		txIndex: view(d).getBigUint64(105, true),
		txHash: d.slice(113, 145),
		status,
		createdAt: view(d).getBigInt64(229, true),
	}
}

/** GuardConfig: disc 8 | multisig 32 | forwarder_program 32 | forwarder_state 32 | policy_hash 32 | workflow_owner 20 | max_review_lifetime 8 | review_deadline_secs 8. */
export function parseGuardConfig(acc: AccountSnapshot, guardProgram: string) {
	owned(acc, guardProgram, CONFIG_DISC, 172, 'GuardConfig')
	const d = acc.data
	return {
		multisig: key(d, 8),
		forwarderProgram: key(d, 40),
		forwarderState: key(d, 72),
		policyHash: d.slice(104, 136),
		workflowOwner: d.slice(136, 156),
		maxReviewLifetime: view(d).getBigInt64(156, true),
		reviewDeadlineSecs: view(d).getBigInt64(164, true),
	}
}

const reject = (reason: number, summary: string): Decision => ({
	verdict: VERDICT.REJECT,
	reason,
	actionKind: ACTION_KIND.NONE,
	destinationHash: ZERO32,
	summary,
})

const AUTHORITY_KINDS = new Set(['token.setAuthority', 'token.approve', 'token.approveChecked', 'system.assign', 'system.authorizeNonce'])
const NONCE_KINDS = new Set(['system.advanceNonce', 'system.withdrawNonce', 'system.initializeNonce'])

type Plan =
	| { kind: 'decided'; decision: Decision }
	| { kind: 'needsDestination'; destination: string; action: Extract<DecodedAction, { kind: 'token.transferChecked' }> }

/** Decode and apply every rule that does not need the destination account. */
export function planReview(vaultTx: AccountSnapshot, vault: string, policy: Policy): Plan {
	const decided = (decision: Decision): Plan => ({ kind: 'decided', decision })
	if (vaultTx.owner !== SQUADS_PROGRAM) return decided(reject(ReviewReason.UNEXPECTED_INSTRUCTION, 'stored transaction is not a Squads account'))
	const decoded = decodeVaultTransaction(vaultTx.data)
	if (decoded.status === 'unsupported') return decided(reject(ReviewReason.UNSUPPORTED_FEATURE, decoded.error))
	if (decoded.status === 'malformed') return decided(reject(ReviewReason.UNEXPECTED_INSTRUCTION, decoded.error))
	const actions = decoded.actions
	if (actions.some((a) => AUTHORITY_KINDS.has(a.kind))) return decided(reject(ReviewReason.AUTHORITY_CHANGE_BLOCKED, 'authority change in the payment'))
	if (actions.some((a) => NONCE_KINDS.has(a.kind))) return decided(reject(ReviewReason.DURABLE_NONCE_DETECTED, 'durable nonce operation in the payment'))
	if (actions.length !== 1) return decided(reject(ReviewReason.UNEXPECTED_INSTRUCTION, `expected one payment, found ${actions.length} instructions`))
	const a = actions[0]!
	// Program allowlist, then instruction allowlist (policy layers), before any parameter check.
	const allowed = ALLOWED_PAYMENTS[a.kind]
	if (allowed) {
		const program = a.kind === 'token.transferChecked' ? a.programId : allowed.program
		if (!policy.allowedPrograms.includes(program)) return decided(reject(ReviewReason.UNKNOWN_PROGRAM, 'payment program is not allowed by the policy'))
		if (!policy.allowedInstructions.includes(allowed.instruction)) return decided(reject(ReviewReason.UNEXPECTED_INSTRUCTION, 'payment instruction is not allowed by the policy'))
	}
	const cap = BigInt(policy.maxAmountPerPayment)
	if (a.kind === 'system.transfer') {
		if (a.source !== vault) return decided(reject(ReviewReason.UNEXPECTED_INSTRUCTION, 'transfer is not from the vault'))
		if (BigInt(a.lamports) > cap) return decided(reject(ReviewReason.AMOUNT_OVER_CAP, 'amount over the cap'))
		if (!policy.destinationWhitelist.includes(a.destination)) return decided(reject(ReviewReason.DESTINATION_NOT_WHITELISTED, 'recipient is not whitelisted'))
		const dest = new PublicKey(a.destination).toBytes()
		return decided({
			verdict: VERDICT.APPROVE,
			reason: ReviewReason.WITHIN_POLICY,
			actionKind: ACTION_KIND.SOL,
			destinationHash: destinationHash(ACTION_KIND.SOL, dest, dest, ZERO32),
			summary: `pay ${a.lamports} lamports to a whitelisted wallet`,
			wallet: a.destination,
		})
	}
	if (a.kind === 'token.transferChecked') {
		if (a.programId !== TOKEN_PROGRAM) return decided(reject(ReviewReason.UNSUPPORTED_FEATURE, 'not the legacy Token program'))
		if (a.authority !== vault) return decided(reject(ReviewReason.UNEXPECTED_INSTRUCTION, 'transfer authority is not the vault'))
		const mint = policy.allowedMints.find((m) => m.mint === a.mint)
		if (!mint || mint.decimals !== a.decimals) return decided(reject(ReviewReason.MINT_NOT_ALLOWED, 'mint not allowed'))
		if (BigInt(a.amount) > cap) return decided(reject(ReviewReason.AMOUNT_OVER_CAP, 'amount over the cap'))
		return { kind: 'needsDestination', destination: a.destinationTokenAccount, action: a }
	}
	return decided(reject(ReviewReason.UNEXPECTED_INSTRUCTION, `${a.kind} is not an allowed payment`))
}

/** Finish an SPL decision with the destination token account (null when it does not exist). */
export function decideDestination(
	action: Extract<DecodedAction, { kind: 'token.transferChecked' }>,
	dest: AccountSnapshot | null,
	policy: Policy,
): Decision {
	if (!dest || dest.owner !== TOKEN_PROGRAM || dest.data.length !== 165 || dest.data[108] !== 1) {
		return reject(ReviewReason.DESTINATION_OWNER_UNRESOLVED, 'destination is not a live token account')
	}
	const mint = key(dest.data, 0)
	const owner = key(dest.data, 32)
	if (mint !== action.mint) return reject(ReviewReason.MINT_NOT_ALLOWED, 'destination holds another mint')
	if (!policy.destinationWhitelist.includes(owner)) return reject(ReviewReason.DESTINATION_NOT_WHITELISTED, 'recipient is not whitelisted')
	return {
		verdict: VERDICT.APPROVE,
		reason: ReviewReason.WITHIN_POLICY,
		actionKind: ACTION_KIND.SPL,
		destinationHash: destinationHash(ACTION_KIND.SPL, new PublicKey(dest.address).toBytes(), new PublicKey(owner).toBytes(), new PublicKey(mint).toBytes()),
		summary: `pay ${action.amount} base units to a whitelisted wallet`,
		wallet: owner,
	}
}

/** planReview + decideDestination in one call (tests and single-read callers). */
export function decide(vaultTx: AccountSnapshot, vault: string, policy: Policy, dest: AccountSnapshot | null): Decision {
	const plan = planReview(vaultTx, vault, policy)
	return plan.kind === 'decided' ? plan.decision : decideDestination(plan.action, dest, policy)
}

/** 117-byte report payload v2. */
export function buildPayload(d: Decision, txHash: Uint8Array, policyHash: Uint8Array, issuedAt: bigint, approvalSeconds: bigint): Uint8Array {
	return encodeReportPayload({
		verdict: d.verdict,
		reason: d.reason,
		txHash,
		policyHash,
		actionKind: d.actionKind,
		destinationHash: d.destinationHash,
		issuedAt,
		expiresAt: issuedAt + approvalSeconds,
	})
}
