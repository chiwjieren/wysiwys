import { readFile } from 'node:fs/promises';
import { decodeVaultTransaction, inspectVaultTransaction } from '../dist/index.js';

const [dataPath, registryPath] = process.argv.slice(2);
if (!dataPath) {
  console.error('Usage: node tools/inspect-vault.mjs <vault-account.bin> [reviewed-anchor-idls.json]');
  process.exitCode = 2;
} else {
  const bytes = new Uint8Array(await readFile(dataPath));
  const registry = registryPath ? JSON.parse(await readFile(registryPath, 'utf8')) : [];
  if (!Array.isArray(registry)) throw new Error('IDL registry must be a JSON array');
  console.log(JSON.stringify({
    inspection: inspectVaultTransaction(bytes, registry),
    payoutDecoder: decodeVaultTransaction(bytes),
  }, null, 2));
}
