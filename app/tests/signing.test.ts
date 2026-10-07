import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { assertSameIntent, signAndConfirm, withComputeBudget } from "../src/lib/squads/sdk";

const wallet = Keypair.generate();
const other = Keypair.generate().publicKey;
const blockhash = Keypair.generate().publicKey.toBase58();
const pay = (lamports: number, to: PublicKey = other) =>
  SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: to, lamports });
const isBudget = (ix: TransactionInstruction) => ix.programId.equals(ComputeBudgetProgram.programId);
const message = (ixs: TransactionInstruction[], payer = wallet.publicKey) =>
  new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
/** What Phantom does when it sets its own priority fee: compute budget instructions in front. */
const phantomFee = (ixs: TransactionInstruction[]) => [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 123_456 }),
  ...ixs.filter((ix) => !isBudget(ix)),
];

test("withComputeBudget adds a compute limit and a priority fee in front", () => {
  const out = withComputeBudget([pay(1)]);
  assert.equal(out.length, 3);
  assert.ok(isBudget(out[0]) && isBudget(out[1]));
  assert.deepEqual(new Set(out.slice(0, 2).map((ix) => ix.data[0])), new Set([2, 3])); // SetComputeUnitLimit, SetComputeUnitPrice
  assert.ok(out[2].programId.equals(SystemProgram.programId));
});

test("withComputeBudget never duplicates a compute budget instruction already present", () => {
  const limit = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const out = withComputeBudget([limit, pay(1)]);
  assert.equal(out.filter((ix) => isBudget(ix) && ix.data[0] === 2).length, 1);
  assert.equal(out.filter((ix) => isBudget(ix) && ix.data[0] === 3).length, 1);
  assert.equal(out.filter((ix) => isBudget(ix) && ix.data[0] === 2)[0].data.readUInt32LE(1), 400_000);
});

test("assertSameIntent accepts an identical message and a wallet's fee-only change", () => {
  const ours = withComputeBudget([pay(1)]);
  assertSameIntent(message(ours), message(ours));
  assertSameIntent(message(ours), message(phantomFee(ours)));
  assertSameIntent(message([pay(1)]), message(phantomFee([pay(1)])));
});

test("assertSameIntent refuses any change to what the transaction does", () => {
  const ours = [pay(1)];
  const refused = (signed: TransactionInstruction[], payer?: PublicKey) =>
    assert.throws(() => assertSameIntent(message(ours), message(signed, payer)), /changed the transaction/);
  refused(phantomFee([pay(2)])); // amount
  refused(phantomFee([pay(1, Keypair.generate().publicKey)])); // recipient
  refused([...phantomFee(ours), pay(5)]); // extra instruction
  refused(phantomFee([])); // dropped instruction
  refused([pay(1)], other); // fee payer
  const two = [pay(1), pay(2)];
  assert.throws(() => assertSameIntent(message(two), message([pay(2), pay(1)])), /changed the transaction/); // order
});

test("assertSameIntent refuses a changed blockhash", () => {
  const ours = message([pay(1)]);
  const other = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [pay(1)] }).compileToV0Message();
  assert.throws(() => assertSameIntent(ours, other), /changed the transaction/);
});

function fakeRpc(sent: VersionedTransaction[]) {
  return {
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 500 }),
    sendRawTransaction: async (bytes: Uint8Array) => {
      sent.push(VersionedTransaction.deserialize(bytes));
      return "signature";
    },
    getSignatureStatuses: async () => ({ value: [{ err: null, confirmationStatus: "finalized" }] }),
    getBlockHeight: async () => 1,
  };
}

test("signAndConfirm sends the transaction with our compute budget when the wallet leaves it alone", async () => {
  const sent: VersionedTransaction[] = [];
  await signAndConfirm(fakeRpc(sent) as never, wallet.publicKey, [pay(1)], async (bytes) => {
    const tx = VersionedTransaction.deserialize(bytes);
    tx.sign([wallet]);
    return tx.serialize();
  }, () => {});
  assert.equal(sent.length, 1);
  const ixs = TransactionMessage.decompile(sent[0].message).instructions;
  assert.equal(ixs.filter(isBudget).length, 2);
});

test("signAndConfirm sends the wallet's fee-adjusted transaction, re-signed by additional signers", async () => {
  const sent: VersionedTransaction[] = [];
  const extra = Keypair.generate();
  const ix = SystemProgram.createAccount({ fromPubkey: wallet.publicKey, newAccountPubkey: extra.publicKey, lamports: 1, space: 0, programId: SystemProgram.programId });
  await signAndConfirm(
    fakeRpc(sent) as never,
    wallet.publicKey,
    [ix],
    async (bytes) => {
      // Wallet rewrites the fee instructions and signs its own version.
      const original = VersionedTransaction.deserialize(bytes);
      const decompiled = TransactionMessage.decompile(original.message);
      const changed = new VersionedTransaction(
        new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: decompiled.recentBlockhash, instructions: phantomFee(decompiled.instructions) }).compileToV0Message(),
      );
      changed.sign([wallet]);
      return changed.serialize();
    },
    () => {},
    [extra],
  );
  assert.equal(sent.length, 1);
  const tx = sent[0];
  const budget = TransactionMessage.decompile(tx.message).instructions.filter(isBudget);
  assert.equal(budget.find((b) => b.data[0] === 3)!.data.readBigUInt64LE(1), 123_456n);
  // Both signatures are valid for the message actually sent.
  assert.equal(tx.signatures.filter((s) => s.some((b) => b !== 0)).length, 2);
});
