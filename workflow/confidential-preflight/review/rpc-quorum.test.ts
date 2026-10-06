import { describe, expect, test } from 'bun:test'
import { normalizeSnapshot, selectQuorum } from './rpc-quorum'

const A = '11111111111111111111111111111111'
const B = 'SysvarC1ock11111111111111111111111111111111'
const acc = (data = 'AAEC') => ({ owner: A, executable: false, lamports: 5, data: [data, 'base64'] as [string, string], space: 3 })
const env = (value: unknown[], slot = 100) => ({ jsonrpc: '2.0', id: 1, result: { context: { slot }, value } })

describe('normalizeSnapshot', () => {
	test('keeps address, owner and data; a missing account is null', () => {
		const s = JSON.parse(normalizeSnapshot(env([acc(), null]), [A, B], 90))
		expect(s).toEqual([{ address: A, owner: A, data: 'AAEC' }, null])
	})

	test('rejects stale context, wrong length, RPC errors and bad base64', () => {
		expect(() => normalizeSnapshot(env([acc()], 80), [A], 90)).toThrow()
		expect(() => normalizeSnapshot(env([acc()]), [A, B], 90)).toThrow()
		expect(() => normalizeSnapshot({ jsonrpc: '2.0', id: 1, error: { code: 1 } }, [A], 90)).toThrow()
		expect(() => normalizeSnapshot(env([acc('A=B')]), [A], 90)).toThrow()
	})

	test('ignores fields that legitimately differ between providers (lamports, rent epoch, slot)', () => {
		const a = normalizeSnapshot(env([{ ...acc(), lamports: 5 }], 100), [A], 90)
		const b = normalizeSnapshot(env([{ ...acc(), lamports: 6, rentEpoch: 9 }], 120), [A], 90)
		expect(a).toBe(b)
	})
})

describe('selectQuorum', () => {
	test('two matching observations win; one conflicting provider is outvoted', () => {
		expect(selectQuorum(['x', 'y', 'x'])).toBe('x')
	})

	test('missing or failed providers never count as agreement', () => {
		expect(() => selectQuorum(['x', null, null])).toThrow('RPC_NO_QUORUM')
		expect(() => selectQuorum(['x', 'y', 'z'])).toThrow('RPC_NO_QUORUM')
		expect(() => selectQuorum([null, null, null])).toThrow('RPC_NO_QUORUM')
	})
})
