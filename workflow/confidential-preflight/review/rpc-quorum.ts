import { z } from 'zod'

// Adapted from ../confidential-check/rpc-quorum.ts (3-provider preflight). Differences: an account that
// does not exist is a valid observation (null), and only owner + data are compared, because lamports and
// rentEpoch can differ between providers at the same finalized state of interest.

const isAddress = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)
const integer = z.number().int().nonnegative().refine(Number.isSafeInteger)
const accountSchema = z.object({
	owner: z.string().refine(isAddress),
	data: z.tuple([z.string(), z.literal('base64')]),
}).passthrough()
const envelopeSchema = z.object({
	jsonrpc: z.literal('2.0'),
	id: z.literal(1),
	result: z.object({ context: z.object({ slot: integer }), value: z.array(accountSchema.nullable()) }),
})

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export type SnapshotAccount = { address: string; owner: string; data: string } | null

/** Canonical JSON of the accounts a provider returned, or throws when the response is unusable. */
export function normalizeSnapshot(raw: unknown, addresses: string[], minContextSlot: number): string {
	try {
		if (!raw || typeof raw !== 'object' || 'error' in raw) throw new Error('RPC error')
		if (!addresses.length || !addresses.every(isAddress)) throw new Error('invalid addresses')
		const { result } = envelopeSchema.parse(raw)
		if (result.context.slot < minContextSlot || result.value.length !== addresses.length) throw new Error('stale or incomplete')
		const accounts: SnapshotAccount[] = result.value.map((a, i) => {
			if (!a) return null
			if (!BASE64.test(a.data[0])) throw new Error('invalid account data')
			return { address: addresses[i]!, owner: a.owner, data: a.data[0] }
		})
		return JSON.stringify(accounts)
	} catch {
		throw new Error('invalid RPC account snapshot')
	}
}

/** 2-of-3 identical observations; null (failed provider) never counts. */
export function selectQuorum(observations: Array<string | null>): string {
	if (observations.length === 3) {
		for (const v of observations) {
			if (v !== null && observations.filter((c) => c === v).length >= 2) return v
		}
	}
	throw new Error('RPC_NO_QUORUM')
}
