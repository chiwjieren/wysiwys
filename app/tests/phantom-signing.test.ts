import test from "node:test";
import assert from "node:assert/strict";
import {
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { signAndConfirm } from "../src/lib/squads/sdk";

test("Phantom-style automatic priority fees do not cause an otherwise unchanged payment to be rejected", async () => {
  const wallet = Keypair.generate();
  const recipient = Keypair.generate().publicKey;
  const blockhash = Keypair.generate().publicKey.toBase58();
  let walletModified = false;
  let sent = false;
  const payment = SystemProgram.transfer({
    fromPubkey: wallet.publicKey,
    toPubkey: recipient,
    lamports: 200000000,
  });
  const rpc = {
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }),
    sendRawTransaction: async (bytes: Uint8Array) => {
      const signed = VersionedTransaction.deserialize(bytes);
      const decoded = TransactionMessage.decompile(signed.message);
      const business = decoded.instructions.filter(
        (ix) => !ix.programId.equals(ComputeBudgetProgram.programId),
      );
      assert.equal(business.length, 1);
      assert.deepEqual(business[0].data, payment.data);
      assert.deepEqual(business[0].keys, payment.keys);
      sent = true;
      return "signature";
    },
    getSignatureStatuses: async () => ({
      value: [{ err: null, confirmationStatus: "finalized" }],
    }),
  };
  await signAndConfirm(
    rpc as never,
    wallet.publicKey,
    [payment],
    async (bytes) => {
      let transaction = VersionedTransaction.deserialize(bytes);
      const message = TransactionMessage.decompile(transaction.message);
      const feeSet = message.instructions.some(
        (ix) =>
          ix.programId.equals(ComputeBudgetProgram.programId) &&
          [2, 3].includes(ix.data[0]),
      );
      // Model Phantom's documented behavior, independently of the app helper.
      if (
        !feeSet &&
        transaction.signatures.every((signature) =>
          signature.every((byte) => byte === 0),
        )
      ) {
        walletModified = true;
        message.instructions.unshift(
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
        );
        transaction = new VersionedTransaction(message.compileToV0Message());
      }
      transaction.sign([wallet]);
      return transaction.serialize();
    },
    () => {},
  );
  assert.equal(walletModified, false);
  assert.equal(sent, true);
});

test("already specified compute budgets and partially signed creation messages stay unchanged", async () => {
  for (const partial of [false, true]) {
    const wallet = Keypair.generate();
    const extra = Keypair.generate();
    const blockhash = Keypair.generate().publicKey.toBase58();
    const instructions = partial
      ? [
          SystemProgram.transfer({
            fromPubkey: extra.publicKey,
            toPubkey: wallet.publicKey,
            lamports: 1,
          }),
        ]
      : [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
          SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: extra.publicKey,
            lamports: 1,
          }),
        ];
    const original = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions,
    })
      .compileToV0Message()
      .serialize();
    const rpc = {
      getLatestBlockhash: async () => ({
        blockhash,
        lastValidBlockHeight: 100,
      }),
      sendRawTransaction: async () => "signature",
      getSignatureStatuses: async () => ({
        value: [{ err: null, confirmationStatus: "finalized" }],
      }),
    };
    await signAndConfirm(
      rpc as never,
      wallet.publicKey,
      instructions,
      async (bytes) => {
        const transaction = VersionedTransaction.deserialize(bytes);
        assert.deepEqual(transaction.message.serialize(), original);
        transaction.sign([wallet]);
        return transaction.serialize();
      },
      () => {},
      partial ? [extra] : [],
    );
  }
});
