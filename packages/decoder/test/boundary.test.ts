import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeVaultTransaction } from '@omnicounter/decoder';
import type { DecodedAction, DecodeResult } from '@omnicounter/decoder';
import realFixtures from '../fixtures/real-devnet.json' with { type: 'json' };
import syntheticFixture from '../fixtures/transfer-checked.json' with { type: 'json' };

const bytesOf = (hex: string) => Uint8Array.from(hex.match(/../g)!, (pair) => Number.parseInt(pair, 16));
type Decoder = (bytes: Uint8Array) => DecodeResult;
type HashCheck = (bytes: Uint8Array, expectedHash: string) => boolean;
type Policy = (actions: DecodedAction[]) => void;

// This test-only caller models the ordering required of CRE and web consumers.
function passThroughBoundary(bytes: Uint8Array, expectedHash: string, hashMatches: HashCheck, decode: Decoder, policy: Policy): DecodeResult | 'hash_mismatch' {
  if (!hashMatches(bytes, expectedHash)) return 'hash_mismatch';
  const result = decode(bytes);
  if (result.status === 'success') policy(result.actions);
  return result;
}

test('a matching upstream hash invokes the package decoder and sends only the complete action list to policy', () => {
  const bytes = bytesOf(realFixtures[0]!.accountDataHex);
  let decodeCalls = 0;
  let policyActions: DecodedAction[] | undefined;
  const result = passThroughBoundary(bytes, 'expected-hash', (receivedBytes, hash) => {
    assert.equal(receivedBytes, bytes);
    assert.equal(hash, 'expected-hash');
    return true;
  }, (receivedBytes) => {
    decodeCalls++;
    return decodeVaultTransaction(receivedBytes);
  }, (actions) => { policyActions = actions; });
  assert.equal(decodeCalls, 1);
  assert.equal(result !== 'hash_mismatch' && result.status, 'success');
  assert.deepEqual(policyActions?.map((action) => action.instructionIndex), [0, 1]);
});

test('an upstream hash mismatch never invokes the decoder or policy', () => {
  let decodeCalls = 0;
  let policyCalls = 0;
  const result = passThroughBoundary(bytesOf(realFixtures[0]!.accountDataHex), 'expected-hash', () => false, () => {
    decodeCalls++;
    throw new Error('decoder must not run');
  }, () => { policyCalls++; });
  assert.equal(result, 'hash_mismatch');
  assert.equal(decodeCalls, 0);
  assert.equal(policyCalls, 0);
});

test('unsupported and malformed results never expose a supported subset to policy', () => {
  for (const [bytes, expectedStatus] of [
    [bytesOf(syntheticFixture.altAccountDataHex), 'unsupported'],
    [bytesOf(realFixtures[0]!.accountDataHex).slice(0, -1), 'malformed'],
  ] as const) {
    let policyCalls = 0;
    const result = passThroughBoundary(bytes, 'expected-hash', () => true, decodeVaultTransaction, () => { policyCalls++; });
    assert.notEqual(result, 'hash_mismatch');
    if (result === 'hash_mismatch') continue;
    assert.equal(result.status, expectedStatus);
    assert.equal('actions' in result, false);
    assert.equal(policyCalls, 0);
  }
});
