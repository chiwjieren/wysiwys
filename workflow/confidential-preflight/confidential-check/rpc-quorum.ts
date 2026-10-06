import { solanaAddressToBytes } from '@chainlink/cre-sdk'
import { z } from 'zod'

export const isSolanaAddress = (value: string): boolean => {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false
  try { return solanaAddressToBytes(value).length === 32 } catch { return false }
}
const integer = z.number().int().nonnegative().refine(Number.isSafeInteger)
const accountSchema = z.object({
  owner: z.string().refine(isSolanaAddress), executable: z.boolean(), lamports: integer,
  data: z.tuple([z.string(), z.literal('base64')]), space: integer.optional(),
})
const envelopeSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.literal(1), result: z.object({
  context: z.object({ slot: integer }), value: z.array(accountSchema),
}) })

// Require canonical padding and zero unused bits, without Node Buffer/atob.
function base64ByteLength(data: string): number {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error('Invalid account data')
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  if (data.endsWith('==') && (alphabet.indexOf(data[data.length - 3]) & 15) !== 0) throw new Error('Invalid account data')
  if (data.endsWith('=') && !data.endsWith('==') && (alphabet.indexOf(data[data.length - 2]) & 3) !== 0) throw new Error('Invalid account data')
  return data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
}

export function normalizeSnapshot(raw: unknown, addresses: string[], minContextSlot: number): string {
  try {
    if (!raw || typeof raw !== 'object' || 'error' in raw) throw new Error('RPC error')
    if (!addresses.length || new Set(addresses).size !== addresses.length || !addresses.every(isSolanaAddress)) throw new Error('Invalid addresses')
    integer.parse(minContextSlot)
    const { result } = envelopeSchema.parse(raw)
    if (result.context.slot < minContextSlot || result.value.length !== addresses.length) throw new Error('Incomplete or stale snapshot')
    return JSON.stringify(result.value.map((account, index) => {
      const space = base64ByteLength(account.data[0])
      if (account.space !== undefined && account.space !== space) throw new Error('Invalid byte length')
      return { address: addresses[index], owner: account.owner, executable: account.executable,
        lamports: String(account.lamports), data: account.data[0], space }
    }))
  } catch { throw new Error('Invalid RPC account snapshot') }
}

export function selectQuorum(observations: Array<string | null>): string {
  if (observations.length !== 3) throw new Error('RPC_NO_CONSENSUS')
  for (const value of observations) {
    if (value !== null && observations.filter(candidate => candidate === value).length >= 2) return value
  }
  throw new Error('RPC_NO_CONSENSUS')
}
