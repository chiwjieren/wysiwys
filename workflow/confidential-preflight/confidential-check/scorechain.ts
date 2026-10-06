import { z } from 'zod'

// Local diagnostic values, not Guard verdicts or shared reason codes.
export type SanctionsStatus = 'SANCTIONED' | 'NO_SANCTIONS_MATCH'
const resultSchema = z.object({ isSanctioned: z.boolean() })
const responseSchema = z.union([z.array(resultSchema).min(1), resultSchema])

export function parseScorechainSanctions(body: string): SanctionsStatus {
  let records: Array<{ isSanctioned: boolean }>
  try {
    const parsed = responseSchema.parse(JSON.parse(body))
    records = Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    // Never include the provider body in an error or public output.
    throw new Error('Unrecognized Scorechain response')
  }
  return records.some(record => record.isSanctioned) ? 'SANCTIONED' : 'NO_SANCTIONS_MATCH'
}
