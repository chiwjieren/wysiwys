import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeVaultTransaction } from '../src/index.ts';
import { encodeU64, fixtureKeys as k, makeVaultTransaction, systemData, SYSTEM_PROGRAM, TOKEN_PROGRAM } from './account-fixture.ts';
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

test('distinct input keys and amounts produce distinct System Transfer actions', () => {
  for (const [source, destination, lamports] of [
    [k[2]!, k[3]!, 17n],
    [k[8]!, k[9]!, 9_007_199_254_740_995n],
  ] as const) {
    const bytes = makeVaultTransaction(SYSTEM_PROGRAM, [source, destination], systemData(2, encodeU64(lamports)));
    assert.deepEqual(decodeVaultTransaction(bytes), {
      schemaVersion: 1,
      status: 'success',
      actions: [{ instructionIndex: 0, kind: 'system.transfer', source, destination, lamports: lamports.toString() }],
    });
  }
});

test('distinct input keys and amounts produce distinct TransferChecked actions', () => {
  for (const [sourceTokenAccount, mint, destinationTokenAccount, authority, amount, decimals] of [
    [k[2]!, k[3]!, k[4]!, k[5]!, 23n, 2],
    [k[6]!, k[7]!, k[8]!, k[9]!, 9_007_199_254_740_997n, 9],
  ] as const) {
    const bytes = makeVaultTransaction(TOKEN_PROGRAM, [sourceTokenAccount, mint, destinationTokenAccount, authority], [12, ...encodeU64(amount), decimals]);
    assert.deepEqual(decodeVaultTransaction(bytes), {
      schemaVersion: 1,
      status: 'success',
      actions: [{ instructionIndex: 0, kind: 'token.transferChecked', programId: TOKEN_PROGRAM, sourceTokenAccount, mint, destinationTokenAccount, authority, amount: amount.toString(), decimals }],
    });
  }
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
