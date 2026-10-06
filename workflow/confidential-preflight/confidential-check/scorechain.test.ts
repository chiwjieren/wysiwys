import { describe, expect } from 'bun:test'
import { test } from '@chainlink/cre-sdk/test'
import type { TeeRuntime } from '@chainlink/cre-sdk'
import { configSchema, initWorkflow, onCronTrigger, type Config } from './scorechain-workflow'
import { parseScorechainSanctions } from './scorechain'

// Synthetic address and credential for unit tests only.
const ADDRESS = '11111111111111111111111111111111'
const TOKEN = 'unit-test-dummy-token'
const makeConfig = (): Config => ({
  mode: 'local-simulation', schedule: '0 */5 * * * *',
  address: ADDRESS, secretId: 'SCORECHAIN_SANCTIONS_API_KEY',
})

function fakeRuntime(body = '[{"isSanctioned":false}]', statusCode = 200) {
  const requests: Array<{ url: string; method: string; multiHeaders: Record<string, { values: string[] }> }> = []
  const reports: unknown[] = []
  const logs: string[] = []
  const secrets: string[] = []
  const runtime = {
    config: makeConfig(),
    getSecret: ({ id }: { id: string }) => {
      secrets.push(id)
      return { result: () => ({ value: TOKEN }) }
    },
    callCapability: ({ payload }: { payload: typeof requests[number] }) => {
      requests.push(payload)
      return { result: () => ({ statusCode, body: new TextEncoder().encode(body) }) }
    },
    log: (value: string) => logs.push(value),
    usingTheDons: () => ({ report: (value: unknown) => {
      reports.push(value)
      return { result: () => ({}) }
    } }),
  }
  return { runtime: runtime as unknown as TeeRuntime<Config>, requests, reports, logs, secrets }
}

describe('Scorechain response validation', () => {
  test('accepts the direct result object described by the response table', () => {
    expect(parseScorechainSanctions('{"isSanctioned":true,"details":{"blockchain":"Solana"}}')).toBe('SANCTIONED')
    expect(parseScorechainSanctions('{"isSanctioned":false}')).toBe('NO_SANCTIONS_MATCH')
  })
  test('recognizes the documented sanctioned array response', () => {
    expect(parseScorechainSanctions('[{"isSanctioned":true,"details":{"name":"private attribution","blockchain":"Solana"}}]')).toBe('SANCTIONED')
  })
  test('requires explicit false results for no sanctions match', () => {
    expect(parseScorechainSanctions('[{"isSanctioned":false}]')).toBe('NO_SANCTIONS_MATCH')
  })
  test('a sanctioned result wins over a false result', () => {
    expect(parseScorechainSanctions('[{"isSanctioned":false},{"isSanctioned":true}]')).toBe('SANCTIONED')
  })
  for (const body of ['[]', '{}', 'null', '[{}]', '[{"isSanctioned":"false"}]', '[{"isSanctioned":null}]', 'not-json']) {
    test(`fails closed on unknown response ${body}`, () => {
      expect(() => parseScorechainSanctions(body)).toThrow('Unrecognized Scorechain response')
    })
  }
})

describe('Scorechain confidential handler', () => {
  test('uses the exact HTTPS endpoint and secret-backed x-api-key header', () => {
    const { runtime, requests, secrets } = fakeRuntime()
    onCronTrigger(runtime)
    expect(secrets).toEqual(['SCORECHAIN_SANCTIONS_API_KEY'])
    expect(requests[0].url).toBe(`https://sanctions.api.scorechain.com/v1/addresses/${ADDRESS}`)
    expect(requests[0].multiHeaders['x-api-key'].values).toEqual([TOKEN])
    expect(requests[0].multiHeaders.Authorization).toBeUndefined()
  })
  test('local mode returns a labelled screening result without a report or payment authorization', () => {
    const { runtime, reports } = fakeRuntime()
    expect(JSON.parse(onCronTrigger(runtime))).toMatchObject({ mode: 'local-simulation', provider: 'scorechain', sanctionsStatus: 'NO_SANCTIONS_MATCH', paymentAuthorized: false })
    expect(reports).toHaveLength(0)
  })
  test('reports a sanctions match without leaking attribution or token', () => {
    const { runtime, reports, logs } = fakeRuntime('[{"isSanctioned":true,"details":{"name":"private-attribution"}}]')
    runtime.config.mode = 'report-preflight'
    const result = onCronTrigger(runtime)
    expect(result).toContain('SANCTIONED')
    expect(reports).toHaveLength(1)
    const publicOutput = JSON.stringify({ result, reports, logs })
    expect(publicOutput).not.toContain(TOKEN)
    expect(publicOutput).not.toContain('private-attribution')
    expect(logs).toHaveLength(0)
  })
  for (const status of [401, 403, 429, 500]) {
    test(`HTTP ${status} never generates a report`, () => {
      const { runtime, reports } = fakeRuntime(TOKEN, status)
      runtime.config.mode = 'report-preflight'
      expect(() => onCronTrigger(runtime)).toThrow(`Scorechain HTTP ${status}`)
      expect(reports).toHaveLength(0)
    })
  }
  test('malformed success response cannot generate a report', () => {
    const { runtime, reports } = fakeRuntime('[]')
    runtime.config.mode = 'report-preflight'
    expect(() => onCronTrigger(runtime)).toThrow('Unrecognized Scorechain response')
    expect(reports).toHaveLength(0)
  })
  test('blank secret fails before HTTP', () => {
    const { runtime, requests } = fakeRuntime()
    runtime.getSecret = () => ({ result: () => ({ value: '' }) }) as ReturnType<TeeRuntime<Config>['getSecret']>
    expect(() => onCronTrigger(runtime)).toThrow('Scorechain secret unavailable')
    expect(requests).toHaveLength(0)
  })
  test('config rejects invalid modes, addresses and five-field cron', () => {
    expect(configSchema.safeParse(makeConfig()).success).toBe(true)
    for (const config of [{ ...makeConfig(), mode: 'production' }, { ...makeConfig(), address: '' }, { ...makeConfig(), address: 'not-a-wallet' }, { ...makeConfig(), schedule: '*/5 * * * *' }]) {
      expect(configSchema.safeParse(config).success).toBe(false)
    }
  })
  test('registers a confidential handler', () => {
    expect(initWorkflow(makeConfig())[0].requirements).toBeDefined()
  })
})
