import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { cre, SolanaTxStatus, SolanaReceiverContractExecutionStatus, type Runtime, type TeeRuntime, type HTTPPayload } from '@chainlink/cre-sdk'
import fixtures from './fixtures/devnet-e2e.json'
import staging from './config.staging.json'
import live from './config.live.json'
import { policyHash } from '../../../packages/shared/src/index'
import { base64ToBytes } from './review-logic'
import { eligibleFrom, HEALTH_AGGREGATION, initWorkflow, onReview, onReviewDon, configSchema, type Config } from './workflow'

// Public devnet fixture bytes, synthetic policy and dummy credentials. These tests invoke the actual
// handler and RPC callbacks; capability I/O is mocked, not the decoder or policy evaluation.
const ENDPOINTS = ['https://test.solana-devnet.quiknode.pro/test', 'https://devnet.helius-rpc.com/?api-key=test', 'https://solana-devnet.g.alchemy.com/v2/test']
const IDS = ['QUICKNODE_SOLANA_DEVNET_RPC_URL', 'HELIUS_SOLANA_DEVNET_RPC_URL', 'ALCHEMY_SOLANA_DEVNET_RPC_URL']
const NOW = 1_800_000_000
const policy: Record<string, any> = {
  version: 1, salt: '00'.repeat(16),
  allowedPrograms: ['11111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
  allowedInstructions: ['system:transfer', 'spl-token:transferChecked'],
  allowedMints: [{ mint: '', decimals: 6 }],
  maxAmountPerPayment: '100000000000', destinationWhitelist: [] as string[],
  screening: { provider: 'scorechain', blockOn: ['SANCTIONED'] },
}
// The destination fixture only stores owner/data; decode its public token-account fields.
import { PublicKey } from '@solana/web3.js'
const destData = base64ToBytes(fixtures.scenarios.clean.destination!.data)
policy.allowedMints[0]!.mint = new PublicKey(destData.slice(0, 32)).toBase58()
policy.destinationWhitelist = [new PublicKey(destData.slice(32, 64)).toBase58()]

const mocks: Array<{ mockRestore(): void }> = []
afterEach(() => { for (const m of mocks.splice(0)) m.mockRestore() })

function harness(options: {
  mode?: 'report' | 'local-simulation'; endpoints?: string[]; sanctioned?: boolean;
  rpcEnvelopeError?: boolean;
  screeningStatus?: number; screeningBody?: unknown; staleDestination?: boolean; noQuorum?: boolean;
  wrongGenesis?: number[]; policyMismatch?: boolean; changedTx?: boolean;
  txStatus?: number; receiverStatus?: number | null; signature?: Uint8Array; error?: string;
  expired?: boolean; decided?: boolean; execution?: 'tee' | 'don';
  /** Replaces the policy document (the GuardConfig commits to whatever is passed). */
  policyDoc?: Record<string, unknown>;
  /** POLICY_DOCUMENT secret value: one document or a registry array (default: the committed document). */
  policySecret?: unknown;
  /** Runner policy store reply to GET /cre/policies/:hash (default 404). */
  store?: { status: number; document?: unknown };
} = {}) {
  const doc = options.policyDoc ?? policy
  const secretValue = JSON.stringify(options.policySecret ?? doc)
  const config = configSchema.parse(options.execution === 'don' ? { ...staging, execution: 'don' } : staging)
  const local = { mode: 'local-simulation', chainSelector: staging.chainSelector, guardProgram: staging.guardProgram,
    decoderVersion: staging.decoderVersion, approvalSeconds: staging.approvalSeconds, maxSlotLag: staging.maxSlotLag,
    screening: staging.screening, authorizedKeys: staging.authorizedKeys }
  const runtimeConfig = options.mode === 'local-simulation' ? configSchema.parse(local) : config
  const endpoints = options.endpoints ?? ENDPOINTS
  const secrets = Object.fromEntries(IDS.map((id, i) => [id, endpoints[i]!]))
  const calls: Array<{ provider: number; method: string; params: any[] }> = []
  const s = fixtures.scenarios.clean
  const review = base64ToBytes(s.review.data)
  review[145] = options.decided ? 1 : 0
  new DataView(review.buffer).setBigInt64(229, BigInt(NOW - (options.expired ? 1000 : 30)), true)
  const guard = base64ToBytes(fixtures.config.data)
  guard.set(policyHash(doc, staging.decoderVersion), 104)
  if (options.policyMismatch) guard[104] ^= 1
  const tx = base64ToBytes(s.vaultTransaction.data)
  if (options.changedTx) tx[tx.length - 1] ^= 1
  const accounts = new Map([
    [s.review.address, { owner: s.review.owner, data: Buffer.from(review).toString('base64') }],
    [fixtures.config.address, { owner: fixtures.config.owner, data: Buffer.from(guard).toString('base64') }],
    [s.vaultTransaction.address, { owner: s.vaultTransaction.owner, data: Buffer.from(tx).toString('base64') }],
    [s.destination!.address, s.destination!],
  ])
  const request = spyOn(cre.capabilities.HTTPClient.prototype, 'sendRequest').mockImplementation((_runtime: any, input: any) => {
    if (input.method === 'GET' && String(input.url).includes('/cre/policies/')) {
      const reply = options.store ?? { status: 404 }
      return { result: () => ({ statusCode: reply.status, body: new TextEncoder().encode(JSON.stringify({ document: reply.document })) }) } as any
    }
    if (input.method === 'GET') return { result: () => ({ statusCode: options.screeningStatus ?? 200,
      body: new TextEncoder().encode(JSON.stringify(options.screeningBody ?? { isSanctioned: options.sanctioned ?? false })) }) } as any
    const provider = endpoints.indexOf(input.url)
    const { method, params } = JSON.parse(Buffer.from(input.body, 'base64').toString())
    calls.push({ provider, method, params })
    let result: unknown
    if (method === 'getGenesisHash') result = options.wrongGenesis?.includes(provider) ? 'wrong-chain' : 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
    else if (method === 'getSlot') result = 1000 + provider
    else result = { context: { slot: options.staleDestination && params[0].length === 1 ? 1 : 1010 },
      value: params[0].map((a: string) => {
        const account = accounts.get(a)
        return account ? { owner: account.owner, data: [options.noQuorum ? Buffer.from([provider]).toString('base64') : account.data, 'base64'] } : null
      }) }
    return { result: () => ({ statusCode: 200, body: new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 1, result,
      ...(options.rpcEnvelopeError ? { error: { code: -32000, message: 'unavailable' } } : {}) })) }) } as any
  })
  const write = spyOn(cre.capabilities.SolanaClient.prototype, 'writeReport').mockImplementation(() => ({ result: () => ({
    txStatus: options.txStatus ?? SolanaTxStatus.SUCCESS,
    receiverContractExecutionStatus: options.receiverStatus === null ? undefined : options.receiverStatus ?? SolanaReceiverContractExecutionStatus.SUCCESS,
    txSignature: options.signature ?? new Uint8Array(64).fill(1), errorMessage: options.error ?? '',
  }) }) as any)
  mocks.push(request, write)
  let reports = 0
  const don = {
    config: runtimeConfig, log: () => {}, now: () => new Date(NOW * 1000),
    getSecret: ({ id }: { id: string }) => {
      // Without a TEE (execution "don") the policy and screening key are Vault DON secrets too.
      if (options.execution === 'don' && id === 'POLICY_DOCUMENT') return { result: () => ({ value: secretValue }) }
      if (options.execution === 'don' && id === 'SCORECHAIN_SANCTIONS_API_KEY') return { result: () => ({ value: 'dummy-test-api-key' }) }
      if (options.execution === 'don' && id === 'POLICY_STORE_TOKEN') return { result: () => ({ value: 'store-token' }) }
      if (!(id in secrets)) throw new Error('private secret crossed into DON')
      return { result: () => ({ value: secrets[id]! }) }
    },
    runInNodeMode: (callback: (...args: any[]) => any) => (...args: any[]) => ({ result: () => callback(don, ...args) }),
    report: () => { reports++; return { result: () => ({}) } },
  }
  const tee = { config: runtimeConfig, log: () => {}, usingTheDons: () => don,
    getSecret: ({ id }: { id: string }) => ({ result: () => ({ value: id === 'POLICY_DOCUMENT' ? secretValue : id === 'POLICY_STORE_TOKEN' ? 'store-token' : 'dummy-test-api-key' }) }) }
  const payload = { input: new TextEncoder().encode(JSON.stringify({ multisig: fixtures.multisig, txIndex: s.txIndex })) } as HTTPPayload
  return { run: () => JSON.parse(options.execution === 'don'
    ? onReviewDon(don as unknown as Runtime<Config>, payload)
    : onReview(tee as unknown as TeeRuntime<Config>, payload)), calls, request, write, reports: () => reports }
}

describe('complete confidential review handler', () => {
  test('approves, screens once inside TEE and checks report delivery', () => {
    const h = harness(); const result = h.run()
    expect(result.verdict).toBe('approve'); expect(result.txSignature).toBeTruthy()
    expect(h.request.mock.calls.filter(([, r]: any) => r.method === 'GET')).toHaveLength(1)
    expect(h.calls.length).toBe(12); expect(h.write).toHaveBeenCalledTimes(1)
  })
  test('pins both account reads to the same positive minimum context slot', () => {
    const h = harness(); h.run()
    const reads = h.calls.filter(c => c.method === 'getMultipleAccounts')
    expect(reads).toHaveLength(6)
    const floor = reads[0]!.params[1].minContextSlot
    expect(floor).toBeGreaterThan(0)
    expect(reads.every(c => c.params[1].minContextSlot === floor)).toBe(true)
  })
  test('a wrong-chain provider is excluded from both account reads', () => {
    const h = harness({ wrongGenesis: [2] }); h.run()
    expect(h.calls.some(c => c.method === 'getMultipleAccounts' && c.provider === 2)).toBe(false)
  })
  test('duplicate provider configuration cannot supply quorum', () => {
    const h = harness({ endpoints: [ENDPOINTS[0]!, ENDPOINTS[0]!, ENDPOINTS[2]!] })
    expect(h.run).toThrow('RPC_PROVIDER_CONFIGURATION'); expect(h.write).not.toHaveBeenCalled()
  })
  test('JSON-RPC errors cannot count as healthy providers even when result is also present', () => {
    const h = harness({ rpcEnvelopeError: true }); expect(h.run).toThrow('RPC_NO_QUORUM')
    expect(h.calls.filter(c => c.method === 'getMultipleAccounts')).toHaveLength(0)
  })
  for (const options of [{ noQuorum: true }, { staleDestination: true }, { wrongGenesis: [1, 2] },
    { policyMismatch: true }, { screeningStatus: 503 }, { screeningBody: {} }, { expired: true }, { rpcEnvelopeError: true }]) {
    test(`fails closed without a report: ${JSON.stringify(options)}`, () => {
      const h = harness(options); expect(h.run).toThrow(); expect(h.reports()).toBe(0); expect(h.write).not.toHaveBeenCalled()
    })
  }
  test('sanctions match produces a reject report', () => {
    const h = harness({ sanctioned: true }); expect(h.run().reason).toBe(12); expect(h.write).toHaveBeenCalledTimes(1)
  })
  test('a changed transaction produces a reject and never calls screening', () => {
    const h = harness({ changedTx: true }); expect(h.run().reason).toBe(2)
    expect(h.request.mock.calls.filter(([, r]: any) => r.method === 'GET')).toHaveLength(0)
  })
  for (const options of [{ txStatus: SolanaTxStatus.FATAL }, { txStatus: SolanaTxStatus.ABORTED },
    { receiverStatus: SolanaReceiverContractExecutionStatus.REVERTED },
    { signature: new Uint8Array(32) }, { signature: new Uint8Array(64) }, { error: 'failed' }]) {
    test(`does not return success on unsuccessful delivery: ${JSON.stringify(options)}`, () => {
      const h = harness(options); expect(h.run).toThrow('REPORT_DELIVERY_FAILED')
    })
  }
  // Live DON, 7 Oct: WriteReport succeeded and the guard recorded the decision, but the reply carried
  // no receiver status or signature (optional fields). That is not evidence of failure; the chain is the record.
  for (const options of [{ receiverStatus: null }, { signature: new Uint8Array(0) }, { receiverStatus: null, signature: new Uint8Array(0) }]) {
    test(`a successful write whose reply omits optional fields is delivered but unconfirmed: ${JSON.stringify(options)}`, () => {
      const result = harness(options).run()
      expect(result.verdict).toBe('approve'); expect(result.delivery).toBe('unconfirmed')
    })
  }
  test('a full reply is reported as confirmed with its signature', () => {
    const result = harness().run()
    expect(result.delivery).toBe('confirmed'); expect(result.txSignature).toBeTruthy()
  })
  test('local simulation evaluates the real handler path but cannot generate or send a report', () => {
    const h = harness({ mode: 'local-simulation' }); const result = h.run()
    expect(result.mode).toBe('local-simulation'); expect(result.verdict).toBe('approve')
    expect(h.calls.length).toBe(12); expect(h.reports()).toBe(0); expect(h.write).not.toHaveBeenCalled()
  })
  test('decided reviews are idempotently skipped', () => {
    const h = harness({ decided: true }); expect(h.run().skipped).toContain('approved'); expect(h.write).not.toHaveBeenCalled()
  })
  test('local replay labels decided or expired chain reviews and still cannot submit a report', () => {
    const h = harness({ mode: 'local-simulation', decided: true, expired: true }); const result = h.run()
    expect(result.reviewStatus).toBe('approved'); expect(result.withinDeadline).toBe(false)
    expect(result.reportSubmitted).toBe(false); expect(h.reports()).toBe(0); expect(h.write).not.toHaveBeenCalled()
  })
  test('local config rejects report fields and unknown modes', () => {
    expect(() => configSchema.parse({ ...staging, mode: 'local-simulation' })).toThrow()
    expect(() => configSchema.parse({ ...staging, mode: 'unknown' })).toThrow()
  })
})

describe('DON execution (live DON without Confidential Workflows)', () => {
  test('approves, screens once in node mode and checks report delivery', () => {
    const h = harness({ execution: 'don' }); const result = h.run()
    expect(result.verdict).toBe('approve'); expect(result.txSignature).toBeTruthy()
    expect(h.request.mock.calls.filter(([, r]: any) => r.method === 'GET')).toHaveLength(1)
    expect(h.calls.length).toBe(12); expect(h.write).toHaveBeenCalledTimes(1); expect(h.reports()).toBe(1)
  })
  test('a sanctions match produces a reject report', () => {
    const h = harness({ execution: 'don', sanctioned: true }); expect(h.run().reason).toBe(12); expect(h.write).toHaveBeenCalledTimes(1)
  })
  for (const options of [{ policyMismatch: true }, { screeningStatus: 503 }, { noQuorum: true }, { expired: true }]) {
    test(`fails closed without a report: ${JSON.stringify(options)}`, () => {
      const h = harness({ ...options, execution: 'don' }); expect(h.run).toThrow(); expect(h.reports()).toBe(0); expect(h.write).not.toHaveBeenCalled()
    })
  }
})

describe('workflow registration and live config', () => {
  test('registers a TEE handler by default and a plain DON handler for execution "don"', () => {
    const inTee = spyOn(cre, 'handlerInTee').mockImplementation((() => 'tee') as any)
    const plain = spyOn(cre, 'handler').mockImplementation((() => 'don') as any)
    mocks.push(inTee, plain)
    expect(initWorkflow(configSchema.parse(staging))).toEqual(['tee'])
    expect(initWorkflow(configSchema.parse({ ...staging, execution: 'don' }))).toEqual(['don'])
    expect(plain.mock.calls[0]![1]).toBe(onReviewDon)
  })
  test('live config targets the production Keystone forwarder with DON execution and an authorized trigger key', () => {
    const config = configSchema.parse(live)
    if (config.mode !== 'report') throw new Error('live config must report')
    expect(config.forwarderProgram).toBe('CXsKEJcs25TQEYU2e5jZ8QTPE3ffMLZhH6BWHrdcCCB5')
    expect(config.forwarderState).toBe('8QoomCQyPSkJ8WopJbX9B4HyvrFzziwvJdU8hZE6DCr9')
    expect(config.execution).toBe('don')
    expect(config.authorizedKeys).toEqual([{ type: 'KEY_TYPE_ECDSA_EVM', publicKey: '0xD6Bbf377d9ce95975a78b84656548B255d816325' }])
    const perTarget = { forwarderProgram: undefined, forwarderState: undefined, authorizedKeys: undefined, execution: undefined, policyStoreUrl: undefined }
    expect({ ...live, ...perTarget }).toEqual({ ...staging, ...perTarget })
  })
  test('authorized keys must be EVM key objects', () => {
    expect(() => configSchema.parse({ ...staging, authorizedKeys: ['0xD6Bbf377d9ce95975a78b84656548B255d816325'] })).toThrow()
    expect(() => configSchema.parse({ ...staging, authorizedKeys: [{ type: 'KEY_TYPE_ECDSA_EVM', publicKey: '0x1234' }] })).toThrow()
  })
})

describe('provider health consensus across DON nodes', () => {
  // Live DON, 7 Oct: QuickNode failed the health check on 5 of 10 nodes. An identical-aggregated
  // eligibility string could not reach consensus; a per-provider majority (median of 0/1) can.
  test('every health field is a median (no identical field a provider split can break)', () => {
    const fields = (HEALTH_AGGREGATION.descriptor.descriptor as any).value.fields
    expect(Object.keys(fields).sort()).toEqual(['alchemy', 'helius', 'minContextSlot', 'quicknode'])
    for (const f of Object.values(fields) as any[]) expect(f.descriptor).toEqual({ case: 'aggregation', value: 1 })
  })
  test('the DON-agreed per-provider votes decide eligibility', () => {
    expect(eligibleFrom({ minContextSlot: 1, quicknode: 1, helius: 1, alchemy: 1 })).toBe('111')
    expect(eligibleFrom({ minContextSlot: 1, quicknode: 0, helius: 1, alchemy: 1 })).toBe('011')
    // An even split's median may land between 0 and 1; the provider stays eligible and the
    // nodes where it fails simply do not count it in their 2-of-3 read.
    expect(eligibleFrom({ minContextSlot: 1, quicknode: 0.5, helius: 1, alchemy: 0 })).toBe('110')
  })
})

describe('policy document handling', () => {
  test('screening runs only when the policy has a screening entry', () => {
    const { screening: _, ...unscreened } = policy
    const h = harness({ policyDoc: unscreened })
    expect(h.run().verdict).toBe('approve')
    expect(h.request.mock.calls.filter(([, r]: any) => r.method === 'GET')).toHaveLength(0)
  })
  test('an invalid policy document fails closed without a report, even when its hash matches', () => {
    for (const execution of ['tee', 'don'] as const) {
      const h = harness({ execution, policyDoc: { ...policy, extra: 'not in Policy v1' } })
      expect(h.run).toThrow('POLICY_INVALID')
      expect(h.reports()).toBe(0); expect(h.write).not.toHaveBeenCalled()
    }
  })
})

describe('policy registry (one secret, one document per policy hash)', () => {
  const other = (n: number) => ({ ...policy, version: n, salt: String(n).padStart(2, '0').repeat(16) })
  test('picks the document whose hash the treasury committed to', () => {
    const h = harness({ policySecret: [other(2), policy, other(3)] })
    expect(h.run().verdict).toBe('approve')
  })
  test('a single document secret still works', () => {
    expect(harness({ policySecret: policy }).run().verdict).toBe('approve')
  })
  test('no matching document fails closed with POLICY_STALE and no report', () => {
    const h = harness({ policySecret: [other(2), other(3)] })
    expect(h.run).toThrow('POLICY_STALE'); expect(h.reports()).toBe(0); expect(h.write).not.toHaveBeenCalled()
  })
  test('duplicate or malformed registry entries are rejected even when one matches', () => {
    for (const policySecret of [[policy, policy], [policy, { ...other(2), extra: 1 }], [], 'not a policy']) {
      const h = harness({ policySecret })
      expect(h.run).toThrow('POLICY_INVALID'); expect(h.reports()).toBe(0)
    }
  })
})

describe('sanctions screening request', () => {
  // Live DON, 7 Oct: Scorechain missed CRE's default HTTP deadline on 7 of 10 nodes, so screening could not
  // reach consensus. The request uses CRE's 10 s maximum, like the deadline-sensitive call it is.
  for (const execution of ['tee', 'don'] as const) {
    test(`asks Scorechain with a 10 s timeout (${execution})`, () => {
      const h = harness({ execution })
      h.run()
      const screening = h.request.mock.calls.map(([, r]: any) => r).filter((r: any) => r.method === 'GET')
      expect(screening).toHaveLength(1)
      expect(screening[0].timeout).toBe('10s')
    })
  }
})

describe('policy fetched by hash from the runner store', () => {
  const other = (n: number) => ({ ...policy, version: n, salt: String(n).padStart(2, '0').repeat(16) })
  const fetches = (h: ReturnType<typeof harness>) =>
    h.request.mock.calls.map(([, r]: any) => r).filter((r: any) => String(r.url).includes('/cre/policies/'))
  for (const execution of ['tee', 'don'] as const) {
    test(`a matching secret needs no fetch (${execution})`, () => {
      const h = harness({ execution, store: { status: 200, document: policy } })
      expect(h.run().verdict).toBe('approve')
      expect(fetches(h)).toHaveLength(0)
    })
    test(`fetches the treasury's document by hash when the secret lacks it, verifies it and approves (${execution})`, () => {
      const h = harness({ execution, policySecret: other(2), store: { status: 200, document: policy } })
      expect(h.run().verdict).toBe('approve')
      const [f] = fetches(h)
      expect(f.url).toBe(`${staging.policyStoreUrl}/cre/policies/${Buffer.from(policyHash(policy, staging.decoderVersion)).toString('hex')}`)
      expect(f.multiHeaders.authorization.values).toEqual(['Bearer store-token'])
      // 12 RPC calls + the policy fetch + screening stays within CRE's 15 HTTP calls.
      expect(h.request.mock.calls.length).toBe(14)
    })
    for (const store of [{ status: 200, document: other(3) }, { status: 404 }, { status: 200, document: { ...policy, extra: 1 } }]) {
      test(`a missing or mismatched document fails closed with POLICY_STALE (${execution}, ${JSON.stringify(store).slice(0, 40)})`, () => {
        const h = harness({ execution, policySecret: other(2), store })
        expect(h.run).toThrow('POLICY_STALE'); expect(h.reports()).toBe(0); expect(h.write).not.toHaveBeenCalled()
      })
    }
    test(`a store outage fails closed without a report (${execution})`, () => {
      const h = harness({ execution, policySecret: other(2), store: { status: 500 } })
      expect(h.run).toThrow(); expect(h.reports()).toBe(0); expect(h.write).not.toHaveBeenCalled()
    })
  }
  test('live and staging configs name a policy store', () => {
    expect(configSchema.parse(live)).toMatchObject({ policyStoreUrl: 'https://runner.13-250-78-41.sslip.io' })
    expect(configSchema.parse(staging)).toMatchObject({ policyStoreUrl: 'http://127.0.0.1:8787' })
  })
})
