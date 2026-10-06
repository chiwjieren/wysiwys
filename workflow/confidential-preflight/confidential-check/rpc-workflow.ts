import { bytesToBase64, consensusIdenticalAggregation, cre, type NodeRuntime, type TeeRuntime } from '@chainlink/cre-sdk'
import { z } from 'zod'
import { isSolanaAddress, normalizeSnapshot, selectQuorum } from './rpc-quorum'

// Verified against official Solana Devnet and QuickNode; see the RPC plan.
export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
const integer = z.number().int().nonnegative().refine(Number.isSafeInteger)
export const configSchema = z.object({
  mode: z.literal('local-simulation'), operation: z.enum(['network-probe', 'account-read']),
  schedule: z.string().refine(value => value.trim().split(/\s+/).length === 6),
  addresses: z.array(z.string().refine(isSolanaAddress)).max(10),
  maxSlotLag: integer.refine(value => value <= 128),
}).strict().refine(config => config.operation === 'network-probe' ? config.addresses.length === 0 :
  config.addresses.length > 0 && new Set(config.addresses).size === config.addresses.length)
export type Config = z.infer<typeof configSchema>
const secretIds = ['QUICKNODE_SOLANA_DEVNET_RPC_URL', 'HELIUS_SOLANA_DEVNET_RPC_URL', 'ALCHEMY_SOLANA_DEVNET_RPC_URL'] as const
const providers = ['quicknode', 'helius', 'alchemy'] as const

function validateEndpoints(endpoints: string[]): void {
  // Fixed provider order, HTTPS only, no authority credentials or duplicate hosts.
  const patterns = [
    /^https:\/\/[a-z0-9-]+\.solana-devnet\.quiknode\.pro\/[^\s#]+$/,
    /^https:\/\/devnet\.helius-rpc\.com\/\?api-key=[^\s&#]+$/,
    /^https:\/\/solana-devnet\.g\.alchemy\.com\/v2\/[^\s/?#]+$/,
  ]
  if (endpoints.length !== 3 || endpoints.some((endpoint, index) => !patterns[index].test(endpoint))) {
    throw new Error('RPC endpoint configuration invalid')
  }
}

function rpc(node: NodeRuntime<Config>, endpoint: string, method: string, params: unknown[]): unknown {
  try {
    const response = new cre.capabilities.HTTPClient().sendRequest(node, {
      url: endpoint, method: 'POST', timeout: '5s',
      multiHeaders: { 'Content-Type': { values: ['application/json'] } },
      body: bytesToBase64(new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))),
      cacheSettings: { store: false },
    }).result()
    if (response.statusCode !== 200) throw new Error('HTTP failure')
    const raw: unknown = JSON.parse(new TextDecoder().decode(response.body))
    if (!raw || typeof raw !== 'object' || 'error' in raw) throw new Error('RPC failure')
    const envelope = z.object({ jsonrpc: z.literal('2.0'), id: z.literal(1), result: z.unknown() }).parse(raw)
    if (!('result' in raw)) throw new Error('Missing result')
    return method === 'getMultipleAccounts' ? raw : envelope.result
  } catch { throw new Error('RPC request failed') }
}

// Runs once per actual DON node, or once in the local single-node simulator.
export function readProviders(node: NodeRuntime<Config>, endpoints: string[]): string {
  validateEndpoints(endpoints)
  const config = configSchema.parse(node.config)
  const slots: Array<number | null> = endpoints.map(endpoint => {
    try {
      if (rpc(node, endpoint, 'getGenesisHash', []) !== DEVNET_GENESIS_HASH) throw new Error('Wrong network')
      return integer.parse(rpc(node, endpoint, 'getSlot', [{ commitment: 'finalized' }]))
    } catch { return null }
  })
  if (config.operation === 'network-probe') {
    if (slots.some(slot => slot === null)) throw new Error('RPC_PROVIDER_CHECK_FAILED')
    return JSON.stringify({ genesisHash: DEVNET_GENESIS_HASH, providers, verifiedProviders: 3, accountQuorumVerified: false })
  }
  const validSlots = slots.filter((slot): slot is number => slot !== null).sort((a, b) => a - b)
  if (validSlots.length < 2) throw new Error('RPC_NO_CONSENSUS')
  // Lower median for two providers; a single inflated slot cannot force the floor.
  const floor = Math.max(0, validSlots[Math.floor((validSlots.length - 1) / 2)] - config.maxSlotLag)
  const observations = endpoints.map((endpoint, index) => {
    if (slots[index] === null) return null
    try {
      const response = rpc(node, endpoint, 'getMultipleAccounts', [config.addresses, {
        commitment: 'finalized', encoding: 'base64', minContextSlot: floor,
      }])
      return normalizeSnapshot(response, config.addresses, floor)
    } catch { return null }
  })
  // Provider slots/health can vary between nodes; aggregate only agreed contents.
  return selectQuorum(observations)
}

export function onCronTrigger(runtime: TeeRuntime<Config>): string {
  const config = configSchema.parse(runtime.config)
  const don = runtime.usingTheDons()
  let endpoints: string[]
  try {
    // Operational RPC credentials are resolved on the DON, not exported from TEE data.
    endpoints = secretIds.map(id => don.getSecret({ id }).result().value)
  } catch { throw new Error('RPC secrets unavailable') }
  validateEndpoints(endpoints)
  const agreed = don.runInNodeMode(readProviders, consensusIdenticalAggregation<string>())(endpoints).result()
  const result = config.operation === 'network-probe' ? {
    mode: config.mode, operation: config.operation, ...JSON.parse(agreed), paymentAuthorized: false,
  } : {
    mode: config.mode, operation: config.operation, accounts: JSON.parse(agreed),
    sourceQuorum: '2-of-3', accountQuorumVerified: true, paymentAuthorized: false,
  }
  runtime.log(config.operation === 'network-probe' ?
    'Devnet RPC probe passed: QuickNode, Helius, Alchemy. Account review not performed.' :
    'Devnet account snapshot passed 2-of-3 provider agreement. Payment authorization not performed.')
  return JSON.stringify(result)
}

export function initWorkflow(config: Config) {
  return [cre.handlerInTee(new cre.capabilities.CronCapability().trigger({ schedule: config.schedule }), onCronTrigger,
    [{ tee: 'nitro', regions: ['us-west-2'] }])]
}
