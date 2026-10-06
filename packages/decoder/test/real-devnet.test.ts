import test from 'node:test';
import assert from 'node:assert/strict';
import { accounts } from '@sqds/multisig';
import { decodeVaultTransaction } from '../src/index.ts';
import { ATA_PROGRAM, fixtureKeys as k, makeVaultTransaction, SYSTEM_PROGRAM, TOKEN_PROGRAM } from './account-fixture.ts';
import fixtures from '../fixtures/real-devnet.json' with { type: 'json' };
import syntheticTransferChecked from '../fixtures/transfer-checked.json' with { type: 'json' };

const bytesOf = (hex: string) => Buffer.from(hex, 'hex');

test('real finalized Squads devnet account decodes both System transfers in order', () => {
  const fixture = fixtures[0]!;
  const bytes = bytesOf(fixture.accountDataHex);
  assert.equal(fixture.accountAddress, '11fcK8xBkav1Ypd3fDWHcqN5F9FeWLfqCwTVj2tMxCY');
  assert.equal(fixture.observedSlot, 507998625);
  assert.equal(fixture.creationSlot, 427397070);
  assert.equal(fixture.creationSignature, '32kQ2FzJ1Sq3TZDJNok1vEm3BoiwiB61izZqkY9SKr7jhRTGZkLzQzBBgeP4F4P4C2r94SUVMn1WyL9keU2kStQi');
  assert.equal(fixture.owner, 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf');
  assert.equal(fixture.sdkVersion, '2.1.4');
  assert.equal(fixture.cluster, 'devnet');
  assert.equal(bytes.length, 276);
  const [sdkAccount, offset] = accounts.VaultTransaction.deserialize(bytes);
  assert.equal(offset, bytes.length);
  assert.deepEqual(sdkAccount.serialize()[0], bytes);
  assert.equal(sdkAccount.message.instructions.length, 2);
  assert.equal(sdkAccount.message.addressTableLookups.length, 0);
  assert.deepEqual(decodeVaultTransaction(bytes), {
    schemaVersion: 1,
    status: 'success',
    actions: [
      { instructionIndex: 0, kind: 'system.transfer', source: '3iYsM1MnhVDSMaCK7hnzo5sntBFJnAeVVpras8F6TuCC', destination: 'F4WKQYkUDBiFxCEMH49NpjjipCeHyG5a45isY8o7wpZ8', lamports: '68210000' },
      { instructionIndex: 1, kind: 'system.transfer', source: '3iYsM1MnhVDSMaCK7hnzo5sntBFJnAeVVpras8F6TuCC', destination: '2Q9WZbjgssyuNA1t5WLHL4SWdCiNAQCTM5FbWtGQtvjt', lamports: '2699120' },
    ],
  });
});

test('pinned SDK reads the synthetic fixture layout', () => {
  for (const bytes of [
    Buffer.from(makeVaultTransaction(SYSTEM_PROGRAM, [k[0]!, k[1]!], [2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0])),
    bytesOf(syntheticTransferChecked.accountDataHex),
  ]) {
    const [sdkAccount, offset] = accounts.VaultTransaction.deserialize(bytes);
    assert.equal(offset, bytes.length);
    assert.deepEqual(sdkAccount.serialize()[0], bytes);
    assert.equal(sdkAccount.message.instructions.length, 1);
  }
});

test('ATA Create accepts the empty payload recognized by the official processor', () => {
  assert.deepEqual(decodeVaultTransaction(makeVaultTransaction(ATA_PROGRAM, [k[0]!, k[1]!, k[2]!, k[3]!, SYSTEM_PROGRAM, TOKEN_PROGRAM], [])), {
    schemaVersion: 1,
    status: 'success',
    actions: [{ instructionIndex: 0, kind: 'ata.create', payer: k[0]!, associatedTokenAccount: k[1]!, walletOwner: k[2]!, mint: k[3]! }],
  });
});

test('real devnet ATA fixture rejects ephemeral signers and its derived instruction rejects Token-2022', () => {
  const fixture = fixtures[1]!;
  const bytes = bytesOf(fixture.accountDataHex);
  assert.equal(fixture.accountAddress, '18PTVHBFMj1nyWaV26u1Q8hSw83djpKLiJfwBtRZmNg');
  assert.equal(fixture.observedSlot, 507998625);
  assert.equal(fixture.creationSlot, 427521772);
  assert.equal(fixture.creationSignature, '4ucjg4jWTgCwzr1sUtyHMrKnj2Boe3Fj29cT3zJ3V7Hqb4QezBTkddJGgXcvX8fq3G5MXLNCnmsbbXUcyrHmjqtg');
  const [sdkAccount, offset] = accounts.VaultTransaction.deserialize(bytes);
  assert.equal(offset, bytes.length);
  assert.deepEqual(sdkAccount.serialize()[0], bytes);
  assert.equal(sdkAccount.message.instructions[0]?.data.length, 0);
  assert.equal(sdkAccount.message.accountKeys[5]?.toBase58(), 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  assert.ok(sdkAccount.ephemeralSignerBumps.length > 0);
  assert.deepEqual(decodeVaultTransaction(bytes), {
    schemaVersion: 1,
    status: 'unsupported',
    error: 'ephemeral_signers',
    unsupportedInstructions: [],
  });
  // Preserve the Token-2022 rejection check independently of the earlier account-level gate.
  const instruction = sdkAccount.message.instructions[0]!;
  const derived = makeVaultTransaction(
    sdkAccount.message.accountKeys[instruction.programIdIndex]!.toBase58(),
    Array.from(instruction.accountIndexes, (index) => sdkAccount.message.accountKeys[index]!.toBase58()),
    Array.from(instruction.data),
  );
  assert.deepEqual(decodeVaultTransaction(derived), {
    schemaVersion: 1,
    status: 'unsupported',
    error: 'unsupported_instruction',
    unsupportedInstructions: [{
      instructionIndex: 0,
      category: 'unsupported_token_program',
      programId: ATA_PROGRAM,
      accountKeys: Array.from(sdkAccount.message.instructions[0]!.accountIndexes, (index) => sdkAccount.message.accountKeys[index]!.toBase58()),
      dataHex: '',
    }],
  });
});
