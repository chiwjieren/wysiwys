import { describe, expect, test } from 'bun:test'
import { normalizeSnapshot, selectQuorum } from './rpc-quorum'

const owner = '11111111111111111111111111111111'
const account = { owner, executable: false, lamports: 42, data: ['AQI=', 'base64'], space: 2, rentEpoch: 18446744073709551615 }
const response = (slot = 100, values: unknown[] = [account]) => ({ jsonrpc: '2.0', id: 1, result: { context: { slot }, value: values } })
const snapshot = (slot = 100) => normalizeSnapshot(response(slot), [owner], 90)

describe('normalized finalized account snapshot', () => {
  test('compares required contents, ignoring incidental RPC context and rent epoch', () => {
    expect(snapshot(100)).toEqual(snapshot(101))
    expect(snapshot()).toContain('"lamports":"42"')
  })
  test('preserves account order and addresses', () => {
    const other = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
    expect(normalizeSnapshot(response(100, [account, account]), [owner, other], 90)).toContain(other)
  })
  test('blocks stale context', () => expect(() => snapshot(89)).toThrow())
  test('blocks a missing account', () => expect(() => normalizeSnapshot(response(100, [null]), [owner], 90)).toThrow())
  test('blocks incomplete snapshots', () => expect(() => normalizeSnapshot(response(100, []), [owner], 90)).toThrow())
  test('blocks JSON-RPC errors even with a result', () => expect(() => normalizeSnapshot({ ...response(), error: { code: -1 } }, [owner], 90)).toThrow())
  for (const replacement of [
    { lamports: Number.MAX_SAFE_INTEGER + 1 }, { lamports: -1 }, { lamports: 1.5 },
    { owner: 'bad' }, { executable: 'false' }, { data: ['not-base64', 'base64'] },
    { data: ['AR==', 'base64'] }, { data: ['AQI=', 'jsonParsed'] }, { space: 3 },
  ]) {
    test(`blocks malformed account ${JSON.stringify(replacement)}`, () => {
      expect(() => normalizeSnapshot(response(100, [{ ...account, ...replacement }]), [owner], 90)).toThrow()
    })
  }
})

describe('whole-snapshot 2-of-3 source agreement', () => {
  test('accepts all three matching', () => expect(selectQuorum([snapshot(), snapshot(), snapshot()])).toBe(snapshot()))
  test('accepts two matching with one outage', () => expect(selectQuorum([snapshot(), null, snapshot()])).toBe(snapshot()))
  test('accepts two matching with one conflicting', () => expect(selectQuorum(['different', snapshot(), snapshot()])).toBe(snapshot()))
  test('blocks three conflicting snapshots', () => expect(() => selectQuorum(['a', 'b', 'c'])).toThrow('RPC_NO_CONSENSUS'))
  test('blocks only one valid provider', () => expect(() => selectQuorum([snapshot(), null, null])).toThrow('RPC_NO_CONSENSUS'))
  test('requires exactly three provider observations', () => expect(() => selectQuorum([snapshot(), snapshot()])).toThrow('RPC_NO_CONSENSUS'))
})
