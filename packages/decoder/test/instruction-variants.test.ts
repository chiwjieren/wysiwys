import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeVaultTransaction } from '../src/index.ts';
import { fixtureBytes, instructionFixtures } from './instruction-fixtures.ts';
import { encodeU64, fixtureKeys as k, makeVaultTransactionMany, SYSTEM_PROGRAM, TOKEN_PROGRAM } from './account-fixture.ts';

for (const fixture of instructionFixtures) {
  test(`${fixture.name} decodes all canonical fields`, () => {
    assert.deepEqual(decodeVaultTransaction(fixtureBytes(fixture)), {
      schemaVersion: 1,
      status: 'success',
      actions: [fixture.expected],
    });
  });

  test(`${fixture.name} rejects a missing required account`, () => {
    const result = decodeVaultTransaction(fixtureBytes(fixture, true));
    assert.equal(result.status, 'malformed');
  });
}

test('decodes every top-level instruction in original order', () => {
  const data = makeVaultTransactionMany([
    { programId: SYSTEM_PROGRAM, accounts: [k[0]!, k[1]!], instructionData: [2, 0, 0, 0, ...encodeU64(12n)] },
    { programId: TOKEN_PROGRAM, accounts: [k[2]!, k[3]!, k[4]!], instructionData: [3, ...encodeU64(34n)] },
    { programId: TOKEN_PROGRAM, accounts: [k[5]!, k[6]!, k[7]!], instructionData: [4, ...encodeU64(56n)] },
  ]);
  const result = decodeVaultTransaction(data);
  assert.equal(result.status, 'success');
  if (result.status !== 'success') return;
  assert.deepEqual(result.actions.map((action) => [action.instructionIndex, action.kind]), [
    [0, 'system.transfer'],
    [1, 'token.transfer'],
    [2, 'token.approve'],
  ]);
});
