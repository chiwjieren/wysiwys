import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, SystemProgram, TransactionMessage } from "@solana/web3.js";
import * as sqds from "@sqds/multisig";
import {
  buildPaymentInstructions,
  buildPaymentProposal,
  previewMessage,
  assertReviewedPreview,
} from "../src/lib/squads/payments";
const vault = Keypair.generate().publicKey,
  recipient = Keypair.generate().publicKey;
test("SOL proposals preserve exact lamports and only create a transaction plus proposal", () => {
  const ix = buildPaymentInstructions({
    vault,
    recipient: recipient.toBase58(),
    amount: "0.000000001",
  });
  assert.equal(ix.length, 1);
  const decoded = SystemProgram.programId.equals(ix[0].programId);
  assert.ok(decoded);
  const multisig = sqds.getMultisigPda({ createKey: recipient })[0];
  const actualVault = sqds.getVaultPda({ multisigPda: multisig, index: 0 })[0];
  const instructions = buildPaymentProposal({
    multisig,
    member: recipient,
    index: 1n,
    vaultIndex: 0,
    message: new TransactionMessage({
      payerKey: actualVault,
      recentBlockhash: recipient.toBase58(),
      instructions: buildPaymentInstructions({
        vault: actualVault,
        recipient: recipient.toBase58(),
        amount: "1",
      }),
    }),
  });
  assert.equal(instructions.length, 2);
  assert.ok(instructions.every((i) => i.programId.equals(sqds.PROGRAM_ID)));
});
test("payment validation rejects invalid recipients, self-transfers and precision loss", () => {
  for (const input of [
    { recipient: "invalid", amount: "1" },
    { recipient: vault.toBase58(), amount: "1" },
    { recipient: recipient.toBase58(), amount: "0.0000000001" },
    { recipient: recipient.toBase58(), amount: "0" },
  ])
    assert.throws(() => buildPaymentInstructions({ vault, ...input }));
});
test("preview rejects empty and lookup-table messages", () => {
  const base = {
    accountKeys: [vault],
    instructions: [],
    addressTableLookups: [],
  };
  assert.equal(previewMessage(base, vault).supported, false);
  assert.equal(
    previewMessage({ ...base, addressTableLookups: [{}] as never[] }, vault)
      .supported,
    false,
  );
});
test("preview describes exact SOL payment and rejects authority instructions", () => {
  const transfer = buildPaymentInstructions({
    vault,
    recipient: recipient.toBase58(),
    amount: "1.25",
  })[0];
  const base = {
    accountKeys: [vault, recipient, SystemProgram.programId],
    instructions: [
      {
        programIdIndex: 2,
        accountIndexes: new Uint8Array([0, 1]),
        data: transfer.data,
      },
    ],
    addressTableLookups: [],
  };
  const preview = previewMessage(base, vault);
  assert.equal(preview.supported, true);
  assert.match(preview.lines[0], /1.25 SOL/);
  assert.match(preview.lines[0], new RegExp(recipient.toBase58()));
  assert.equal(
    previewMessage(
      {
        ...base,
        instructions: [
          { ...base.instructions[0], data: new Uint8Array([4, 0, 0, 0]) },
        ],
      },
      vault,
    ).supported,
    false,
  );
});

test("SPL preview reveals every ATA recipient and rejects unresolved owners", async () => {
  const {
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getAssociatedTokenAddressSync,
  } = await import("@solana/spl-token");
  const mint = Keypair.generate().publicKey,
    source = Keypair.generate().publicKey;
  const instructions = buildPaymentInstructions({
    vault,
    recipient: recipient.toBase58(),
    amount: "1.25",
    token: { mint: mint.toBase58(), source: source.toBase58(), decimals: 6 },
  });
  const compiled = new TransactionMessage({
    payerKey: vault,
    recentBlockhash: recipient.toBase58(),
    instructions,
  }).compileToV0Message();
  const msg = {
    accountKeys: compiled.staticAccountKeys,
    instructions: compiled.compiledInstructions.map((ix) => ({
      programIdIndex: ix.programIdIndex,
      accountIndexes: new Uint8Array(ix.accountKeyIndexes),
      data: ix.data,
    })),
    addressTableLookups: compiled.addressTableLookups,
  };
  assert.equal(previewMessage(msg, vault).supported, false);
  const ctx = {
    accounts: new Map([[source.toBase58(), { owner: vault, mint }]]),
    mints: new Map([[mint.toBase58(), 6]]),
  };
  const preview = previewMessage(msg, vault, ctx);
  assert.equal(preview.supported, true);
  const ata = getAssociatedTokenAddressSync(mint, recipient).toBase58();
  for (const value of [recipient.toBase58(), mint.toBase58(), ata])
    assert.ok(preview.lines[0].includes(value));
  assert.ok(preview.lines[1].includes("1.25 tokens"));
  const standalone = { ...msg, instructions: [msg.instructions[1]] };
  assert.equal(previewMessage(standalone, vault, ctx).supported, false);
  ctx.accounts.set(ata, { owner: recipient, mint });
  assert.equal(previewMessage(standalone, vault, ctx).supported, true);
  ctx.mints.set(mint.toBase58(), 9);
  assert.equal(previewMessage(msg, vault, ctx).supported, false);
});

// Token owners are mutable: a fresh decode must match what the signer reviewed.
test("approval rejects changed recipient details and missing or incomplete previews", () => {
  const reviewed = ["Send 1 token to wallet A."];
  assert.doesNotThrow(() =>
    assertReviewedPreview(reviewed, { supported: true, lines: [...reviewed] }),
  );
  assert.throws(
    () =>
      assertReviewedPreview(reviewed, {
        supported: true,
        lines: ["Send 1 token to wallet B."],
      }),
    /changed/,
  );
  assert.throws(
    () =>
      assertReviewedPreview(undefined, { supported: true, lines: reviewed }),
    /Review/,
  );
  assert.throws(
    () =>
      assertReviewedPreview(reviewed, {
        supported: false,
        lines: reviewed,
        reason: "Owner unavailable",
      }),
    /Owner unavailable/,
  );
});
