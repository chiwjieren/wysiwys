import { describe, expect, test } from 'bun:test'
import fixtures from './fixtures/devnet-e2e.json'
import deployment from '../../../deployments/devnet.json'
import { ACTION_KIND, ReviewReason, VERDICT, decodeReportPayload, destinationHash, txHash } from '../../../packages/shared/src/index'
import { base64ToBytes, buildPayload, decide, parseGuardConfig, parseReview, planReview, type AccountSnapshot } from './review-logic'

const snap = (a: { address: string; owner: string; data: string } | null): AccountSnapshot | null =>
	a ? { address: a.address, owner: a.owner, data: base64ToBytes(a.data) } : null
const policy = {
	version: 1,
	salt: '00'.repeat(16),
	allowedMints: [{ mint: deployment.mint, decimals: 6 }],
	maxAmountPerPayment: '100000000000',
	destinationWhitelist: [deployment.recipients.whitelisted.wallet],
}
const scenario = (name: keyof typeof fixtures.scenarios) => {
	const s = fixtures.scenarios[name]
	return decide(snap(s.vaultTransaction)!, fixtures.vault, policy, snap(s.destination))
}

describe('parseReview / parseGuardConfig (real devnet accounts)', () => {
	test('reads status, tx hash and identity from a Review', () => {
		const r = parseReview(snap(fixtures.scenarios.clean.review)!, fixtures.guardProgram)
		expect(r.status).toBe('executed')
		expect(r.multisig).toBe(fixtures.multisig)
		expect(r.txIndex).toBe(BigInt(fixtures.scenarios.clean.txIndex))
		const vt = snap(fixtures.scenarios.clean.vaultTransaction)!
		expect(Buffer.from(r.txHash).toString('hex')).toBe(Buffer.from(txHash(new (require('@solana/web3.js').PublicKey)(vt.address).toBytes(), vt.data)).toString('hex'))
		expect(r.createdAt > 1_700_000_000n).toBe(true)
		expect(parseReview(snap(fixtures.scenarios.lookalike.review)!, fixtures.guardProgram).status).toBe('rejected')
	})

	test('reads the guard config', () => {
		const c = parseGuardConfig(snap(fixtures.config)!, fixtures.guardProgram)
		expect(c.multisig).toBe(fixtures.multisig)
		// The fixture is the simulator test treasury; new treasuries (deployment.guard) use the live forwarder.
		expect(c.forwarderProgram).toBe(deployment.forwarders.simulator.program)
		expect(c.forwarderState).toBe(deployment.forwarders.simulator.state)
		// The fixture was recorded under the first policy; GuardConfig is immutable, so it keeps that hash
		// after the 7 Oct rotation (deployments/devnet.json now names the new one for new treasuries).
		expect(Buffer.from(c.policyHash).toString('hex')).toBe('402fba2bed1a4a6381b7c449d53309db5d71e5beab0e4da5bf43d60ba02a7ec0')
		expect(c.reviewDeadlineSecs).toBe(900n)
		expect(c.maxReviewLifetime).toBe(3600n)
	})

	test('refuses accounts from the wrong program or of the wrong type', () => {
		const review = snap(fixtures.scenarios.clean.review)!
		expect(() => parseReview({ ...review, owner: '11111111111111111111111111111111' }, fixtures.guardProgram)).toThrow()
		expect(() => parseReview(snap(fixtures.config)!, fixtures.guardProgram)).toThrow()
		expect(() => parseGuardConfig(review, fixtures.guardProgram)).toThrow()
	})
})

describe('decide (real devnet stored transactions)', () => {
	test('clean: approves the whitelisted mUSD payment with the right destination hash', () => {
		const d = scenario('clean')
		expect(d.verdict).toBe(VERDICT.APPROVE)
		expect(d.reason).toBe(ReviewReason.WITHIN_POLICY)
		expect(d.actionKind).toBe(ACTION_KIND.SPL)
		expect(d.wallet).toBe(deployment.recipients.whitelisted.wallet)
		const dest = fixtures.scenarios.clean.destination!
		const pk = (s: string) => new (require('@solana/web3.js').PublicKey)(s).toBytes()
		expect(Buffer.from(d.destinationHash).toString('hex')).toBe(
			Buffer.from(destinationHash(ACTION_KIND.SPL, pk(dest.address), pk(deployment.recipients.whitelisted.wallet), pk(deployment.mint))).toString('hex'),
		)
	})

	test('lookalike: rejects a destination owner that is not whitelisted', () => {
		expect(scenario('lookalike').reason).toBe(ReviewReason.DESTINATION_NOT_WHITELISTED)
	})

	test('drift: rejects the hidden authority change before anything else', () => {
		const d = scenario('drift')
		expect(d.verdict).toBe(VERDICT.REJECT)
		expect(d.reason).toBe(ReviewReason.AUTHORITY_CHANGE_BLOCKED)
	})

	test('overCap: rejects an amount over the cap', () => {
		expect(scenario('overCap').reason).toBe(ReviewReason.AMOUNT_OVER_CAP)
	})

	test('ownershipSwap (destination now owned by someone else): rejects', () => {
		expect(scenario('ownershipSwap').reason).toBe(ReviewReason.DESTINATION_NOT_WHITELISTED)
	})

	test('missing destination account: rejects as unresolved', () => {
		const s = fixtures.scenarios.clean
		expect(decide(snap(s.vaultTransaction)!, fixtures.vault, policy, null).reason).toBe(ReviewReason.DESTINATION_OWNER_UNRESOLVED)
	})

	test('mint not in the policy: rejects', () => {
		const d = decide(snap(fixtures.scenarios.clean.vaultTransaction)!, fixtures.vault, { ...policy, allowedMints: [] }, snap(fixtures.scenarios.clean.destination))
		expect(d.reason).toBe(ReviewReason.MINT_NOT_ALLOWED)
	})

	test('a payment not from the vault is rejected', () => {
		const d = decide(snap(fixtures.scenarios.clean.vaultTransaction)!, deployment.recipients.lookalike.wallet, policy, snap(fixtures.scenarios.clean.destination))
		expect(d.reason).toBe(ReviewReason.UNEXPECTED_INSTRUCTION)
	})

	test('planReview names the destination account to read for an SPL payment', () => {
		const p = planReview(snap(fixtures.scenarios.clean.vaultTransaction)!, fixtures.vault, policy)
		expect(p.kind).toBe('needsDestination')
		if (p.kind === 'needsDestination') expect(p.destination).toBe(fixtures.scenarios.clean.destination!.address)
		expect(planReview(snap(fixtures.scenarios.drift.vaultTransaction)!, fixtures.vault, policy).kind).toBe('decided')
	})
})

describe('buildPayload', () => {
	test('approve: 117-byte v2 payload with times and hashes', () => {
		const d = scenario('clean')
		const b = buildPayload(d, new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), 1_000n, 600n)
		expect(b.length).toBe(117)
		const p = decodeReportPayload(b)
		expect(p.verdict).toBe(1)
		expect(p.issuedAt).toBe(1_000n)
		expect(p.expiresAt).toBe(1_600n)
		expect(Buffer.from(p.destinationHash).toString('hex')).toBe(Buffer.from(d.destinationHash).toString('hex'))
	})

	test('reject: NONE kind with a zero destination hash', () => {
		const p = decodeReportPayload(buildPayload(scenario('drift'), new Uint8Array(32), new Uint8Array(32), 1n, 600n))
		expect(p.actionKind).toBe(ACTION_KIND.NONE)
		expect(p.destinationHash.every((x) => x === 0)).toBe(true)
	})
})
