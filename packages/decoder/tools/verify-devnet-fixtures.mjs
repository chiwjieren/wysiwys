import { readFile } from 'node:fs/promises';

const fixtureUrl = new URL('../fixtures/real-devnet.json', import.meta.url);
const fixtures = JSON.parse(await readFile(fixtureUrl, 'utf8'));
if (!Array.isArray(fixtures) || fixtures.length === 0) throw new Error('missing devnet fixtures');

const endpoint = fixtures[0].rpcEndpoint;
if (fixtures.some((fixture) => fixture.rpcEndpoint !== endpoint || fixture.cluster !== 'devnet')) {
  throw new Error('inconsistent devnet fixture endpoints');
}

const response = await fetch(endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'getMultipleAccounts',
    params: [fixtures.map((fixture) => fixture.accountAddress), { encoding: 'base64', commitment: 'finalized' }],
  }),
});
if (!response.ok) throw new Error(`devnet RPC HTTP ${response.status}`);

const rpc = await response.json();
if (rpc.error) throw new Error(`devnet RPC error: ${JSON.stringify(rpc.error)}`);
if (!Array.isArray(rpc.result?.value) || rpc.result.value.length !== fixtures.length) {
  throw new Error('unexpected devnet RPC account result');
}

for (const [index, fixture] of fixtures.entries()) {
  const account = rpc.result.value[index];
  if (!account) throw new Error(`account missing: ${fixture.accountAddress}`);
  if (account.owner !== fixture.owner) throw new Error(`owner mismatch: ${fixture.accountAddress}`);
  if (!Array.isArray(account.data) || account.data[1] !== 'base64') {
    throw new Error(`unexpected account encoding: ${fixture.accountAddress}`);
  }
  const actualHex = Buffer.from(account.data[0], 'base64').toString('hex');
  if (actualHex !== fixture.accountDataHex) throw new Error(`account bytes mismatch: ${fixture.accountAddress}`);
  console.log(`match ${fixture.accountAddress} (${actualHex.length / 2} bytes)`);
}

console.log(`finalized devnet context slot ${rpc.result.context.slot}`);
