import { cre, hexToBase64, solanaAddressToBytes, type TeeRuntime } from '@chainlink/cre-sdk'
import { encodeAbiParameters, parseAbiParameters } from 'viem'
import { z } from 'zod'
import { parseScorechainSanctions } from './scorechain'

const isSolanaAddress = (address: string): boolean => {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false
  try { return solanaAddressToBytes(address).length === 32 } catch { return false }
}

export const configSchema = z.object({
  mode: z.enum(['local-simulation', 'report-preflight']),
  schedule: z.string().refine(value => value.trim().split(/\s+/).length === 6, 'Six-field cron required'),
  address: z.string().refine(isSolanaAddress, 'A valid public Solana address is required'),
  secretId: z.literal('SCORECHAIN_SANCTIONS_API_KEY'),
}).strict()
export type Config = z.infer<typeof configSchema>

export function onCronTrigger(runtime: TeeRuntime<Config>): string {
  const config = configSchema.parse(runtime.config)
  let apiKey: string
  try {
    apiKey = runtime.getSecret({ id: config.secretId }).result().value
    if (!apiKey.trim()) throw new Error('empty')
  } catch {
    throw new Error('Scorechain secret unavailable')
  }

  let response
  try {
    response = new cre.capabilities.HTTPClient().sendRequest(runtime, {
      url: `https://sanctions.api.scorechain.com/v1/addresses/${encodeURIComponent(config.address)}`,
      method: 'GET',
      multiHeaders: { 'x-api-key': { values: [apiKey] } },
      cacheSettings: { store: false },
    }).result()
  } catch {
    throw new Error('Scorechain request failed')
  }
  if (response.statusCode !== 200) throw new Error(`Scorechain HTTP ${response.statusCode}`)
  const sanctionsStatus = parseScorechainSanctions(new TextDecoder().decode(response.body))

  // Export only the public screening conclusion. No private data or logging.
  const result = { mode: config.mode, provider: 'scorechain', address: config.address, sanctionsStatus, paymentAuthorized: false }
  const donRuntime = runtime.usingTheDons()
  if (config.mode === 'local-simulation') return JSON.stringify(result)

  // Diagnostic report only. This is never a Guard report and is never delivered.
  const payload = encodeAbiParameters(parseAbiParameters('string scope, string wallet, string status'), [
    'wysiwys:scorechain-sanctions-preflight:v1', config.address, sanctionsStatus,
  ])
  donRuntime.report({ encodedPayload: hexToBase64(payload), encoderName: 'evm', signingAlgo: 'ecdsa', hashingAlgo: 'keccak256' }).result()
  return JSON.stringify(result)
}

export function initWorkflow(config: Config) {
  return [cre.handlerInTee(new cre.capabilities.CronCapability().trigger({ schedule: config.schedule }), onCronTrigger, [
    { tee: 'nitro', regions: ['us-west-2'] },
  ])]
}
