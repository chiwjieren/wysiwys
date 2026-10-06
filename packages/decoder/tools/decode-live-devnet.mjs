import { readFile } from 'node:fs/promises';
import { decodeVaultTransaction } from '../dist/index.js';

const fixtures = JSON.parse(await readFile(new URL('../fixtures/real-devnet.json', import.meta.url), 'utf8'));
const fixture = process.argv[2]
  ? fixtures.find((item) => item.accountAddress === process.argv[2])
  : fixtures[0];
if (!fixture) throw new Error('account address is not in the recorded devnet fixtures');

async function rpc(method, params) {
  const response = await fetch(fixture.rpcEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

const accountResult = await rpc('getAccountInfo', [fixture.accountAddress, { encoding: 'base64', commitment: 'finalized' }]);
const account = accountResult?.value;
if (!account || account.owner !== fixture.owner || account.data?.[1] !== 'base64') {
  throw new Error('missing account, wrong owner, or unexpected encoding');
}
const bytes = Buffer.from(account.data[0], 'base64');
if (bytes.toString('hex') !== fixture.accountDataHex) throw new Error('live account bytes differ from recorded fixture');

const transaction = await rpc('getTransaction', [fixture.creationSignature, {
  encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 0,
}]);
if (!transaction || transaction.meta?.err !== null || transaction.slot !== fixture.creationSlot ||
    !transaction.meta?.logMessages?.some((line) => line.includes('Instruction: VaultTransactionCreate'))) {
  throw new Error('recorded creation transaction could not be verified');
}

console.log(JSON.stringify({
  cluster: fixture.cluster,
  account: fixture.accountAddress,
  creationSignature: fixture.creationSignature,
  creationSlot: transaction.slot,
  finalizedReadSlot: accountResult.context.slot,
  owner: account.owner,
  accountBytes: bytes.length,
  fixtureMatchesLiveAccount: true,
  decoded: decodeVaultTransaction(bytes),
}, null, 2));
