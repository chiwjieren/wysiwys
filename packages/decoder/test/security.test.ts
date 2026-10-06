import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeVaultTransaction, inspectVaultTransaction } from '../src/index.ts';
import { ATA_PROGRAM, encodeU64, fixtureKeys as k, makeVaultTransaction, makeVaultTransactionMany, SYSTEM_PROGRAM, TOKEN_PROGRAM } from './account-fixture.ts';
import phaseOneFixture from '../fixtures/transfer-checked.json' with { type: 'json' };

const hex = (value: string) => Uint8Array.from(value.match(/../g)!, (pair) => Number.parseInt(pair, 16));
const token2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

test('unknown programs preserve every recoverable field without successful actions', () => {
  const data = [3, ...encodeU64(4n)];
  assert.deepEqual(decodeVaultTransaction(makeVaultTransaction(k[8]!, [k[0]!, k[1]!], data)), {
    schemaVersion: 1,
    status: 'unsupported',
    error: 'unsupported_instruction',
    unsupportedInstructions: [{
      instructionIndex: 0,
      category: 'unknown_program',
      programId: k[8]!,
      accountKeys: [k[0]!, k[1]!],
      dataHex: '030400000000000000',
    }],
  });
});

test('an Anchor instruction discriminator does not authorize an unknown program', () => {
  const data = [175, 175, 109, 31, 13, 152, 155, 237, ...encodeU64(42n)];
  assert.deepEqual(decodeVaultTransaction(makeVaultTransaction(k[10]!, [k[0]!, k[1]!], data)), {
    schemaVersion: 1,
    status: 'unsupported',
    error: 'unsupported_instruction',
    unsupportedInstructions: [{
      instructionIndex: 0,
      category: 'unknown_program',
      programId: k[10]!,
      accountKeys: [k[0]!, k[1]!],
      dataHex: 'afaf6d1f0d989bed2a00000000000000',
    }],
  });
});

test('Token-2022 and wrong classic program IDs are unsupported', () => {
  for (const programId of [token2022, k[9]!]) {
    const result = decodeVaultTransaction(makeVaultTransaction(programId, [k[0]!, k[1]!, k[2]!], [3, ...encodeU64(5n)]));
    assert.equal(result.status, 'unsupported');
    if (result.status !== 'unsupported') continue;
    assert.equal(result.unsupportedInstructions[0]?.category, 'unknown_program');
    assert.equal(result.unsupportedInstructions[0]?.programId, programId);
    assert.equal('actions' in result, false);
  }
});

test('unknown variants in each recognized program retain their data and order', () => {
  const inputs = [
    { programId: SYSTEM_PROGRAM, accounts: [k[0]!], instructionData: [99, 0, 0, 0] },
    { programId: TOKEN_PROGRAM, accounts: [k[1]!], instructionData: [250, 171] },
    { programId: ATA_PROGRAM, accounts: [k[2]!], instructionData: [2] },
  ];
  assert.deepEqual(decodeVaultTransaction(makeVaultTransactionMany(inputs)), {
    schemaVersion: 1,
    status: 'unsupported',
    error: 'unsupported_instruction',
    unsupportedInstructions: [
      { instructionIndex: 0, category: 'unknown_instruction', programId: SYSTEM_PROGRAM, accountKeys: [k[0]!], dataHex: '63000000' },
      { instructionIndex: 1, category: 'unknown_instruction', programId: TOKEN_PROGRAM, accountKeys: [k[1]!], dataHex: 'faab' },
      { instructionIndex: 2, category: 'unknown_instruction', programId: ATA_PROGRAM, accountKeys: [k[2]!], dataHex: '02' },
    ],
  });
});

test('mixed supported and unsupported instructions never expose a successful subset', () => {
  const result = decodeVaultTransaction(makeVaultTransactionMany([
    { programId: TOKEN_PROGRAM, accounts: [k[0]!, k[1]!, k[2]!], instructionData: [3, ...encodeU64(1n)] },
    { programId: k[8]!, accounts: [k[3]!], instructionData: [17, 18] },
    { programId: TOKEN_PROGRAM, accounts: [k[4]!, k[5]!, k[6]!], instructionData: [4, ...encodeU64(2n)] },
  ]));
  assert.equal(result.status, 'unsupported');
  assert.equal('actions' in result, false);
  if (result.status === 'unsupported') assert.deepEqual(result.unsupportedInstructions.map((record) => record.instructionIndex), [1]);
});

test('ALT content is explicitly unsupported before instruction decoding', () => {
  assert.deepEqual(decodeVaultTransaction(hex(phaseOneFixture.altAccountDataHex)), {
    schemaVersion: 1,
    status: 'unsupported',
    error: 'address_table_lookups',
    unsupportedInstructions: [],
  });
});

test('nonempty ephemeral signer bumps reject otherwise supported payments without exposing actions', () => {
  const payments = [
    { programId: SYSTEM_PROGRAM, accounts: [k[0]!, k[1]!], instructionData: [2, 0, 0, 0, ...encodeU64(1n)] },
    { programId: TOKEN_PROGRAM, accounts: [k[0]!, k[1]!, k[2]!, k[3]!], instructionData: [12, ...encodeU64(1n), 6] },
  ];
  for (const payment of payments) {
    assert.equal(decodeVaultTransaction(makeVaultTransactionMany([payment])).status, 'success');
    for (const bumps of [[0], [254], [0, 255]]) {
      const bytes = makeVaultTransactionMany([payment], bumps);
      const expected = { schemaVersion: 1, status: 'unsupported', error: 'ephemeral_signers', unsupportedInstructions: [] };
      assert.deepEqual(decodeVaultTransaction(bytes), expected);
      assert.deepEqual(inspectVaultTransaction(bytes), expected);
    }
  }
});

test('TransferChecked followed by SetAuthority preserves order and explicit null', () => {
  const result = decodeVaultTransaction(makeVaultTransactionMany([
    { programId: TOKEN_PROGRAM, accounts: [k[0]!, k[1]!, k[2]!, k[3]!], instructionData: [12, ...encodeU64(9_007_199_254_740_993n), 6] },
    { programId: TOKEN_PROGRAM, accounts: [k[4]!, k[5]!], instructionData: [6, 2, 0] },
  ]));
  assert.deepEqual(result, {
    schemaVersion: 1,
    status: 'success',
    actions: [
      { instructionIndex: 0, kind: 'token.transferChecked', programId: TOKEN_PROGRAM, sourceTokenAccount: k[0]!, mint: k[1]!, destinationTokenAccount: k[2]!, authority: k[3]!, amount: '9007199254740993', decimals: 6 },
      { instructionIndex: 1, kind: 'token.setAuthority', target: k[4]!, authorityType: 'accountOwner', currentAuthority: k[5]!, newAuthority: null },
    ],
  });
});

test('classic Token actions preserve trailing multisig signer keys', () => {
  const result = decodeVaultTransaction(makeVaultTransaction(TOKEN_PROGRAM, [k[0]!, k[1]!, k[2]!, k[3]!, k[4]!], [3, ...encodeU64(42n)]));
  assert.deepEqual(result, {
    schemaVersion: 1,
    status: 'success',
    actions: [{ instructionIndex: 0, kind: 'token.transfer', sourceTokenAccount: k[0]!, destinationTokenAccount: k[1]!, authority: k[2]!, amount: '42', multisigSigners: [k[3]!, k[4]!] }],
  });
});

test('malformed supported instruction data cannot expose earlier supported actions', () => {
  const result = decodeVaultTransaction(makeVaultTransactionMany([
    { programId: TOKEN_PROGRAM, accounts: [k[0]!, k[1]!, k[2]!], instructionData: [3, ...encodeU64(1n)] },
    { programId: TOKEN_PROGRAM, accounts: [k[3]!, k[4]!], instructionData: [6, 2, 2] },
    { programId: TOKEN_PROGRAM, accounts: [k[5]!, k[6]!, k[7]!], instructionData: [4, ...encodeU64(2n)] },
  ]));
  assert.deepEqual(result, { schemaVersion: 1, status: 'malformed', error: 'invalid_set_authority_data', instructionIndex: 1 });
});

test('malformed instructions take precedence while retaining ordered unknown records', () => {
  const result = decodeVaultTransaction(makeVaultTransactionMany([
    { programId: k[8]!, accounts: [k[0]!], instructionData: [0, 255] },
    { programId: TOKEN_PROGRAM, accounts: [k[1]!, k[2]!], instructionData: [6, 2, 2] },
    { programId: ATA_PROGRAM, accounts: [k[3]!], instructionData: [3] },
  ]));
  assert.deepEqual(result, {
    schemaVersion: 1,
    status: 'malformed',
    error: 'invalid_set_authority_data',
    instructionIndex: 1,
    unsupportedInstructions: [
      { instructionIndex: 0, category: 'unknown_program', programId: k[8]!, accountKeys: [k[0]!], dataHex: '00ff' },
      { instructionIndex: 2, category: 'unknown_instruction', programId: ATA_PROGRAM, accountKeys: [k[3]!], dataHex: '03' },
    ],
  });
});

test('trailing bytes, invalid program index, and empty instruction lists fail predictably', () => {
  const ordinary = makeVaultTransaction(TOKEN_PROGRAM, [k[0]!, k[1]!, k[2]!], [3, ...encodeU64(8n)]);
  assert.deepEqual(decodeVaultTransaction(Uint8Array.from([...ordinary, 255])), { schemaVersion: 1, status: 'malformed', error: 'trailing_data' });
  const badProgramIndex = ordinary.slice();
  badProgramIndex[226] = 255;
  assert.deepEqual(decodeVaultTransaction(badProgramIndex), { schemaVersion: 1, status: 'malformed', error: 'program_index_out_of_range' });
  assert.deepEqual(decodeVaultTransaction(makeVaultTransactionMany([])), { schemaVersion: 1, status: 'malformed', error: 'empty_instructions' });
});

test('identical input yields identical serialized output', () => {
  const input = makeVaultTransaction(TOKEN_PROGRAM, [k[0]!, k[1]!, k[2]!], [3, ...encodeU64(9_007_199_254_740_993n)]);
  const outputs = Array.from({ length: 3 }, () => JSON.stringify(decodeVaultTransaction(input)));
  assert.equal(outputs[0], outputs[1]);
  assert.equal(outputs[1], outputs[2]);
});
