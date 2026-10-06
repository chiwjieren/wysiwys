import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeVaultTransaction, inspectVaultTransaction } from '../src/index.ts';
import { encodeU64, fixtureKeys as k, makeVaultTransactionMany, SYSTEM_PROGRAM } from './account-fixture.ts';
import fixtures from '../fixtures/real-devnet.json' with { type: 'json' };
import transferFixture from '../fixtures/transfer-checked.json' with { type: 'json' };

const anchorProgram = k[10]!;
const idl = {
  address: anchorProgram,
  instructions: [{
    name: 'settle',
    discriminator: [1, 2, 3, 4, 5, 6, 7, 8],
    accounts: [{ name: 'source' }, { name: 'destination' }],
    args: [{ name: 'amount', type: 'u64' }, { name: 'approved', type: 'bool' }],
  }],
};
const anchorInstruction = {
  programId: anchorProgram,
  accounts: [k[0]!, k[1]!],
  instructionData: [1, 2, 3, 4, 5, 6, 7, 8, ...encodeU64(9_007_199_254_740_993n), 1],
};

test('real devnet account exposes every raw instruction without an IDL', () => {
  const bytes = Uint8Array.from(fixtures[0]!.accountDataHex.match(/../g)!, (pair) => Number.parseInt(pair, 16));
  const result = inspectVaultTransaction(bytes);
  assert.equal(result.status, 'inspected');
  if (result.status !== 'inspected') return;
  assert.equal(result.instructions.length, 2);
  assert.deepEqual(result.instructions.map((item) => [item.instructionIndex, item.programId, item.accountKeys.length]), [
    [0, SYSTEM_PROGRAM, 2], [1, SYSTEM_PROGRAM, 2],
  ]);
  assert.deepEqual(result.instructions.map((item) => item.interpretation?.source), ['builtin', 'builtin']);
  assert.ok(result.instructions.every((item) => /^[0-9a-f]+$/.test(item.dataHex)));
});

test('registered Anchor IDL interprets exact fields and preserves raw instruction', () => {
  const bytes = makeVaultTransactionMany([anchorInstruction]);
  const result = inspectVaultTransaction(bytes, [idl]);
  assert.deepEqual(result, {
    schemaVersion: 1,
    status: 'inspected',
    instructions: [{
      instructionIndex: 0,
      programId: anchorProgram,
      accountKeys: [k[0]!, k[1]!],
      dataHex: Buffer.from(anchorInstruction.instructionData).toString('hex'),
      interpretation: {
        source: 'anchor-idl',
        name: 'settle',
        accounts: { source: k[0]!, destination: k[1]! },
        args: { amount: '9007199254740993', approved: true },
      },
    }],
  });
  assert.equal(decodeVaultTransaction(bytes).status, 'unsupported');
});

test('unknown program, wrong discriminator, and wrong IDL address stay raw', () => {
  const bytes = makeVaultTransactionMany([anchorInstruction]);
  for (const registry of [[], [{ ...idl, address: k[9]! }], [{ ...idl, instructions: [{ ...idl.instructions[0]!, discriminator: [9, 2, 3, 4, 5, 6, 7, 8] }] }]]) {
    const result = inspectVaultTransaction(bytes, registry);
    assert.equal(result.status, 'inspected');
    if (result.status === 'inspected') assert.equal(result.instructions[0]!.interpretation, null);
  }
});

test('invalid Anchor argument and mixed instructions never make policy decoding succeed', () => {
  const malformedAnchor = { ...anchorInstruction, instructionData: [...anchorInstruction.instructionData.slice(0, -1), 2] };
  const bytes = makeVaultTransactionMany([
    { programId: SYSTEM_PROGRAM, accounts: [k[2]!, k[3]!], instructionData: [2, 0, 0, 0, ...encodeU64(42n)] },
    malformedAnchor,
  ]);
  const result = inspectVaultTransaction(bytes, [idl]);
  assert.equal(result.status, 'inspected');
  if (result.status === 'inspected') {
    assert.deepEqual(result.instructions.map((item) => item.interpretation?.source ?? null), ['builtin', null]);
  }
  assert.equal(decodeVaultTransaction(bytes).status, 'unsupported');
});

test('ambiguous IDL discriminators do not claim an interpretation', () => {
  const duplicate = { ...idl, instructions: [idl.instructions[0]!, { ...idl.instructions[0]!, name: 'otherMeaning' }] };
  const result = inspectVaultTransaction(makeVaultTransactionMany([anchorInstruction]), [duplicate]);
  assert.equal(result.status, 'inspected');
  if (result.status === 'inspected') assert.equal(result.instructions[0]!.interpretation, null);
});

test('a registered IDL cannot relabel malformed built-in Token data', () => {
  const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const bytes = makeVaultTransactionMany([{ programId: tokenProgram, accounts: [k[0]!], instructionData: [3, 1, 2] }]);
  const fakeIdl = {
    address: tokenProgram,
    instructions: [{ name: 'safe', discriminator: [3], accounts: [{ name: 'source' }], args: [{ name: 'x', type: 'u16' }] }],
  };
  const result = inspectVaultTransaction(bytes, [fakeIdl]);
  assert.equal(result.status, 'inspected');
  if (result.status === 'inspected') assert.equal(result.instructions[0]!.interpretation, null);
  assert.equal(decodeVaultTransaction(bytes).status, 'malformed');
});

test('structurally truncated account and address lookups remain non-inspected', () => {
  const bytes = makeVaultTransactionMany([anchorInstruction]);
  assert.equal(inspectVaultTransaction(bytes.slice(0, -1), [idl]).status, 'malformed');
  const altBytes = Uint8Array.from(transferFixture.altAccountDataHex.match(/../g)!, (pair) => Number.parseInt(pair, 16));
  assert.equal(inspectVaultTransaction(altBytes, [idl]).status, 'unsupported');
});

test('unsupported IDL types and unsafe field names stay raw', () => {
  const bytes = makeVaultTransactionMany([anchorInstruction]);
  for (const variant of [
    { ...idl, instructions: [{ ...idl.instructions[0]!, args: [{ name: 'amount', type: 'f64' }, { name: 'approved', type: 'bool' }] }] },
    { ...idl, instructions: [{ ...idl.instructions[0]!, args: [{ name: '__proto__', type: 'u64' }, { name: 'approved', type: 'bool' }] }] },
  ]) {
    const result = inspectVaultTransaction(bytes, [variant]);
    assert.equal(result.status, 'inspected');
    if (result.status === 'inspected') assert.equal(result.instructions[0]!.interpretation, null);
  }
});
