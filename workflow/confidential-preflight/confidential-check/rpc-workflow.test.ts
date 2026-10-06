import { describe, expect } from 'bun:test'
import { test } from '@chainlink/cre-sdk/test'
import type { TeeRuntime } from '@chainlink/cre-sdk'
import { configSchema, DEVNET_GENESIS_HASH, onCronTrigger, type Config } from './rpc-workflow'

const owner = '11111111111111111111111111111111'
const endpoints = [
  'https://unit.solana-devnet.quiknode.pro/dummy',
  'https://devnet.helius-rpc.com/?api-key=dummy',
  'https://solana-devnet.g.alchemy.com/v2/dummy',
]
const makeConfig = (operation: 'network-probe' | 'account-read' = 'account-read'): Config => ({
  mode: 'local-simulation', operation, schedule: '0 */5 * * * *',
  addresses: operation === 'account-read' ? [owner] : [], maxSlotLag: 32,
})
function fakeRuntime(operation: 'network-probe' | 'account-read' = 'account-read', fault = '', failedProvider = 2) {
  const methods: string[] = []
  const secrets: string[] = []
  const logs: string[] = []
  let nodeCalls = 0
  const runtime = {
    config: makeConfig(operation), log: (value: string) => logs.push(value),
    callCapability: ({ payload }: { payload: { url: string; body: Uint8Array; timeout: { seconds: bigint }; cacheSettings: { store: boolean } } }) => {
      expect(payload.timeout.seconds).toBe(5n)
      expect(payload.cacheSettings.store).toBe(false)
      const request = JSON.parse(new TextDecoder().decode(payload.body))
      methods.push(request.method)
      const provider = endpoints.indexOf(payload.url)
      if (fault === 'outage' && provider === failedProvider) throw new Error('private-endpoint-dummy')
      let result: unknown = DEVNET_GENESIS_HASH
      if (request.method === 'getGenesisHash' && fault === 'wrong-network' && provider === failedProvider) result = 'wrong'
      if (request.method === 'getSlot') result = 100 + provider
      if (request.method === 'getMultipleAccounts') {
        expect(request.params[1].commitment).toBe('finalized')
        expect(request.params[1].encoding).toBe('base64')
        expect(request.params[1].minContextSlot).toBe(69)
        result = { context: { slot: fault === 'stale' && provider === failedProvider ? 10 : 100 + provider }, value: [
          fault === 'missing' && provider === failedProvider ? null : {
            owner, executable: false, lamports: fault === 'conflict' && provider === failedProvider ? 43 : 42,
            data: ['AQI=', 'base64'], space: 2,
          },
        ] }
      }
      return { result: () => ({ statusCode: 200, body: new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 1, result })) }) }
    },
    usingTheDons: () => ({
      getSecret: ({ id }: { id: string }) => {
        secrets.push(id)
        const index = ['QUICKNODE_SOLANA_DEVNET_RPC_URL', 'HELIUS_SOLANA_DEVNET_RPC_URL', 'ALCHEMY_SOLANA_DEVNET_RPC_URL'].indexOf(id)
        return { result: () => ({ value: fault === 'duplicate' ? endpoints[0] : endpoints[index] }) }
      },
      runInNodeMode: (callback: Function) => (...args: unknown[]) => ({ result: () => {
        nodeCalls++
        return callback(runtime, ...args)
      } }),
    }),
  }
  return { runtime: runtime as unknown as TeeRuntime<Config>, methods, secrets, logs, get nodeCalls() { return nodeCalls } }
}

describe('three-provider CRE callback', () => {
  test('probes all three real configured sources through node mode, without account claims', () => {
    const fake = fakeRuntime('network-probe')
    expect(JSON.parse(onCronTrigger(fake.runtime))).toMatchObject({ operation: 'network-probe', verifiedProviders: 3, accountQuorumVerified: false, paymentAuthorized: false })
    expect(fake.nodeCalls).toBe(1)
    expect(fake.methods.filter(method => method === 'getGenesisHash')).toHaveLength(3)
    expect(fake.secrets).toHaveLength(3)
    expect(JSON.stringify(fake.logs)).not.toContain('dummy')
  })
  test('network probe fails if any provider is unavailable', () => {
    expect(() => onCronTrigger(fakeRuntime('network-probe', 'outage').runtime)).toThrow('RPC_PROVIDER_CHECK_FAILED')
  })
  test('reads complete snapshots and returns stable account contents', () => {
    const fake = fakeRuntime()
    expect(JSON.parse(onCronTrigger(fake.runtime))).toMatchObject({ accountQuorumVerified: true, paymentAuthorized: false,
      accounts: [{ address: owner, lamports: '42', data: 'AQI=' }],
    })
    expect(fake.methods.filter(method => method === 'getMultipleAccounts')).toHaveLength(3)
  })
  for (const fault of ['outage', 'wrong-network', 'stale', 'missing', 'conflict']) {
    test(`two agreeing providers survive one ${fault}`, () => {
      const fake = fakeRuntime('account-read', fault)
      // An unavailable/wrong-network provider is excluded from the slot median (100,101).
      if (fault === 'outage' || fault === 'wrong-network') fake.runtime.config.maxSlotLag = 31
      expect(JSON.parse(onCronTrigger(fake.runtime)).accountQuorumVerified).toBe(true)
    })
  }
  test('does not count duplicated provider credentials as independent sources', () => {
    const fake = fakeRuntime('account-read', 'duplicate')
    expect(() => onCronTrigger(fake.runtime)).toThrow('RPC endpoint configuration invalid')
    expect(fake.methods).toHaveLength(0)
  })
  test('requires addresses for account mode', () => expect(() => configSchema.parse({ ...makeConfig(), addresses: [] })).toThrow())
  test('rejects unknown modes', () => expect(() => configSchema.parse({ ...makeConfig(), mode: 'production' })).toThrow())
})
