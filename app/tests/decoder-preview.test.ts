import test from "node:test";
import assert from "node:assert/strict";
import * as sqds from "@sqds/multisig";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { decodeVaultTransaction } from "@wysiwys/decoder";
import { txHash } from "@wysiwys/shared";
import { previewVaultTransaction } from "../src/lib/squads/payments";

const vault = Keypair.generate().publicKey;
const recipient = Keypair.generate().publicKey;
function account(ephemeral = false, extraAccount = false) {
  return sqds.accounts.VaultTransaction.fromArgs({
    multisig: Keypair.generate().publicKey,
    creator: Keypair.generate().publicKey,
    index: 1,
    bump: 1,
    vaultIndex: 0,
    vaultBump: 1,
    ephemeralSignerBumps: new Uint8Array(ephemeral ? [1] : []),
    message: {
      numSigners: 1,
      numWritableSigners: 1,
      numWritableNonSigners: 1,
      accountKeys: [vault, recipient, SystemProgram.programId],
      instructions: [
        {
          programIdIndex: 2,
          accountIndexes: new Uint8Array(extraAccount ? [0, 1, 0] : [0, 1]),
          data: SystemProgram.transfer({
            fromPubkey: vault,
            toPubkey: recipient,
            lamports: 1250000000n,
          }).data,
        },
      ],
      addressTableLookups: [],
    },
  }).serialize()[0];
}
test("stored payment preview exposes the shared decoder JSON and renders its exact amount and destination", () => {
  const bytes = account();
  const preview = previewVaultTransaction(bytes, vault);
  assert.deepEqual(preview.decoder, decodeVaultTransaction(bytes));
  assert.equal(preview.supported, true);
  assert.match(preview.lines[0], /1.25 SOL/);
  assert.ok(preview.lines[0].includes(recipient.toBase58()));
});
test("stored previews preserve account-level decoder rejections, including ephemeral signers and trailing bytes", () => {
  for (const bytes of [
    account(true),
    Buffer.concat([account(), Buffer.from([0])]),
  ]) {
    const preview = previewVaultTransaction(bytes, vault);
    assert.equal(preview.supported, false);
    assert.deepEqual(preview.decoder, decodeVaultTransaction(bytes));
    assert.deepEqual(preview.lines, []);
  }
});
test("decoder success does not authorize a payment from another vault", () => {
  const preview = previewVaultTransaction(
    account(),
    Keypair.generate().publicKey,
  );
  assert.equal(preview.decoder?.status, "success");
  assert.equal(preview.supported, false);
});

test("a stored preview checks the canonical transaction hash before decoding", () => {
  const data = account();
  const address = Keypair.generate().publicKey;
  const binding = { address, hash: txHash(address.toBytes(), data) };
  assert.equal(
    previewVaultTransaction(data, vault, undefined, binding).supported,
    true,
  );
  const changed = new Uint8Array(data);
  changed[changed.length - 1] ^= 1;
  const preview = previewVaultTransaction(changed, vault, undefined, binding);
  assert.equal(preview.supported, false);
  assert.equal(preview.decoder, undefined);
  assert.match(preview.reason!, /changed/);
});

test("a decoded SOL transfer with extra accounts remains unavailable for approval", () => {
  const preview = previewVaultTransaction(account(false, true), vault);
  assert.equal(preview.decoder?.status, "success");
  assert.equal(preview.supported, false);
});
