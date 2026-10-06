import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeVaultTransaction } from '../src/index.ts';
import { encodeU64, fixtureKeys as k, makeVaultTransactionMany, TOKEN_PROGRAM } from './account-fixture.ts';
import fixture from '../fixtures/transfer-checked.json' with { type: 'json' };

const valid = Uint8Array.from(fixture.accountDataHex.match(/../g)!, (pair) => Number.parseInt(pair, 16));

function assertResultContract(bytes: Uint8Array): void {
  const first = decodeVaultTransaction(bytes);
  const second = decodeVaultTransaction(bytes);
  assert.deepEqual(second, first);
  assert.equal(first.schemaVersion, 1);
  assert.ok(['success', 'unsupported', 'malformed'].includes(first.status));
  if (first.status === 'success') {
    assert.ok(first.actions.length > 0);
    assert.deepEqual(first.actions.map((action) => action.instructionIndex), first.actions.map((_, index) => index));
  } else {
    assert.equal('actions' in first, false);
  }
}

test('every truncated prefix of a valid account fails closed', () => {
  for (let length = 0; length < valid.length; length++) {
    const result = decodeVaultTransaction(valid.subarray(0, length));
    assert.equal(result.status, 'malformed', `prefix length ${length}`);
    assert.equal('actions' in result, false, `prefix length ${length}`);
  }
});

test('thousands of deterministic byte mutations never throw or return a partial result', () => {
  let state = 0x6d2b79f5;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  for (let i = 0; i < 5_000; i++) {
    const mutated = valid.slice();
    const changes = 1 + random() % 4;
    for (let j = 0; j < changes; j++) mutated[random() % mutated.length] ^= 1 << (random() % 8);
    assertResultContract(mutated);
  }
});

test('random complete accounts and size boundaries remain bounded and deterministic', () => {
  let state = 0x9e3779b9;
  const randomByte = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 24;
  };
  for (const length of [0, 1, 7, 8, 32, 128, 512, 2048, 8192]) {
    for (let sample = 0; sample < 30; sample++) {
      const bytes = Uint8Array.from({ length }, randomByte);
      assertResultContract(bytes);
    }
  }
  assert.equal(decodeVaultTransaction(new Uint8Array(1_048_576)).status, 'malformed');
  assert.deepEqual(decodeVaultTransaction(new Uint8Array(1_048_577)), {
    schemaVersion: 1,
    status: 'malformed',
    error: 'account_size_out_of_range',
  });
});

test('long ordered instruction sequence preserves every exact amount and index', () => {
  const instructions = Array.from({ length: 48 }, (_, index) => ({
    programId: TOKEN_PROGRAM,
    accounts: [k[0]!, k[1]!, k[2]!, k[3]!],
    instructionData: [12, ...encodeU64((1n << 53n) + BigInt(index)), 6],
  }));
  const result = decodeVaultTransaction(makeVaultTransactionMany(instructions));
  assert.equal(result.status, 'success');
  if (result.status !== 'success') return;
  assert.equal(result.actions.length, instructions.length);
  for (const [index, action] of result.actions.entries()) {
    assert.equal(action.instructionIndex, index);
    assert.equal(action.kind, 'token.transferChecked');
    if (action.kind === 'token.transferChecked') assert.equal(action.amount, ((1n << 53n) + BigInt(index)).toString());
  }
});
