import test from "node:test";
import assert from "node:assert/strict";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
} from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as sqds from "@sqds/multisig";
import {
  buildGuardedPaymentInstruction,
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

function tokenAccountInfo(
  mint: PublicKey,
  owner: PublicKey,
  programOwner = TOKEN_PROGRAM_ID,
) {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount: 0n,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return {
    data,
    owner: programOwner,
    lamports: 2039280,
    executable: false,
  };
}
const fakeRpc = (info: ReturnType<typeof tokenAccountInfo> | null) => ({
  getAccountInfo: async () => info,
});

test("guarded SOL payouts are exactly one System transfer", async () => {
  const ix = await buildGuardedPaymentInstruction(fakeRpc(null), {
    vault,
    recipient: recipient.toBase58(),
    amount: "0.5",
  });
  assert.ok(ix.programId.equals(SystemProgram.programId));
  assert.equal(ix.data.readUInt32LE(0), 2);
  assert.equal(ix.data.readBigUInt64LE(4), 500_000_000n);
});
test("guarded token payouts are one TransferChecked to the recipient's existing token account", async () => {
  const mint = Keypair.generate().publicKey;
  const source = Keypair.generate().publicKey;
  const destination = getAssociatedTokenAddressSync(mint, recipient);
  const ix = await buildGuardedPaymentInstruction(
    fakeRpc(tokenAccountInfo(mint, recipient)),
    {
      vault,
      recipient: recipient.toBase58(),
      amount: "2.5",
      token: { mint: mint.toBase58(), source: source.toBase58(), decimals: 6 },
    },
  );
  assert.ok(ix.programId.equals(TOKEN_PROGRAM_ID));
  assert.equal(ix.data[0], 12);
  assert.equal(ix.data.readBigUInt64LE(1), 2_500_000n);
  assert.equal(ix.data[9], 6);
  assert.ok(ix.keys[0].pubkey.equals(source));
  assert.ok(ix.keys[2].pubkey.equals(destination));
  assert.ok(ix.keys[3].pubkey.equals(vault));
});
test("guarded token payouts never create a missing or mismatched destination account", async () => {
  const mint = Keypair.generate().publicKey;
  const input = {
    vault,
    recipient: recipient.toBase58(),
    amount: "1",
    token: {
      mint: mint.toBase58(),
      source: Keypair.generate().publicKey.toBase58(),
      decimals: 6,
    },
  };
  await assert.rejects(
    buildGuardedPaymentInstruction(fakeRpc(null), input),
    /token account/i,
  );
  await assert.rejects(
    buildGuardedPaymentInstruction(
      fakeRpc(tokenAccountInfo(Keypair.generate().publicKey, recipient)),
      input,
    ),
    /token account/i,
  );
  await assert.rejects(
    buildGuardedPaymentInstruction(
      fakeRpc(tokenAccountInfo(mint, Keypair.generate().publicKey)),
      input,
    ),
    /token account/i,
  );
  await assert.rejects(
    buildGuardedPaymentInstruction(
      fakeRpc(tokenAccountInfo(mint, recipient, Keypair.generate().publicKey)),
      input,
    ),
    /token account/i,
  );
});
