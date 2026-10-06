import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeVaultTransaction } from '../src/index.ts';
import fixture from '../fixtures/transfer-checked.json' with { type: 'json' };

const accountBytes = () => Uint8Array.from(fixture.accountDataHex.match(/../g)!, (x) => Number.parseInt(x, 16));

test('decodes the complete deterministic Squads TransferChecked fixture', () => {
  const result = decodeVaultTransaction(accountBytes());
  assert.deepEqual(result, {
    schemaVersion: 1,
    status: 'success',
    actions: [{
      instructionIndex: 0,
      kind: 'token.transferChecked',
      programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      sourceTokenAccount: '11111111111111111111111111111112',
      mint: '11111111111111111111111111111113',
      destinationTokenAccount: '11111111111111111111111111111114',
      authority: '11111111111111111111111111111115',
      amount: '9007199254740993',
      decimals: 6,
    }],
  });
});

test('fails closed on a nonempty address table lookup', () => {
  const result = decodeVaultTransaction(Uint8Array.from(fixture.altAccountDataHex.match(/../g)!, (x) => Number.parseInt(x, 16)));
  assert.equal(result.status, 'unsupported');
  assert.equal(result.error, 'address_table_lookups');
});

test('reports malformed discriminator, truncation, counts, and indexes', () => {
  const wrongDiscriminator = accountBytes();
  wrongDiscriminator[0] ^= 1;
  assert.deepEqual(decodeVaultTransaction(wrongDiscriminator), { schemaVersion: 1, status: 'malformed', error: 'wrong_discriminator' });

  assert.deepEqual(decodeVaultTransaction(accountBytes().slice(0, -1)), { schemaVersion: 1, status: 'malformed', error: 'truncated' });

  const invalidCount = accountBytes();
  invalidCount[90] = 1;
  invalidCount[91] = 16;
  assert.deepEqual(decodeVaultTransaction(invalidCount), { schemaVersion: 1, status: 'malformed', error: 'count_out_of_range' });

  const invalidIndex = accountBytes();
  invalidIndex[263] = 255;
  assert.deepEqual(decodeVaultTransaction(invalidIndex), { schemaVersion: 1, status: 'malformed', error: 'account_index_out_of_range' });
});
