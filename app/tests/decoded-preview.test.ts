import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  Keypair,
  PublicKey,
  TransactionMessage,
  type AccountInfo,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  MINT_SIZE,
  MintLayout,
  TOKEN_PROGRAM_ID,
  AuthorityType,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as sqds from "@sqds/multisig";
import { txHash } from "@wysiwys/shared";
import { buildPaymentInstructions } from "../src/lib/squads/payments";
import {
  assertReviewedPreview,
  draftVaultTransaction,
  paymentLabel,
  previewVaultTransaction,
} from "../src/lib/squads/decoded-preview";

// Real finalized devnet VaultTransaction accounts captured by the decoder package.
const fixtures = JSON.parse(
  readFileSync(
    new URL(
      "../../packages/decoder/fixtures/real-devnet.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { accountAddress: string; accountDataHex: string }[];
const solFixture = {
  address: new PublicKey(fixtures[0].accountAddress),
  data: Buffer.from(fixtures[0].accountDataHex, "hex"),
};
const unsupportedFixture = {
  address: new PublicKey(fixtures[1].accountAddress),
  data: Buffer.from(fixtures[1].accountDataHex, "hex"),
};
const fixtureVault = new PublicKey(
  "3iYsM1MnhVDSMaCK7hnzo5sntBFJnAeVVpras8F6TuCC",
);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

type Info = AccountInfo<Buffer>;
const rpcWith = (accounts: Map<string, Info>) => ({
  getMultipleAccountsInfo: async (keys: PublicKey[]) =>
    keys.map((k) => accounts.get(k.toBase58()) ?? null),
});
const noAccounts = rpcWith(new Map());
function tokenAccount(mint: PublicKey, owner: PublicKey): Info {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount: 10_000_000n,
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
    owner: TOKEN_PROGRAM_ID,
    lamports: 2039280,
    executable: false,
  };
}
function mintAccount(decimals: number): Info {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 0n,
      decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  return {
    data,
    owner: TOKEN_PROGRAM_ID,
    lamports: 1461600,
    executable: false,
  };
}

test("a stored devnet transaction is described from the decoder output with its tx_hash", async () => {
  const preview = await previewVaultTransaction(
    noAccounts,
    solFixture,
    fixtureVault,
  );
  assert.equal(preview.supported, true, preview.reason);
  assert.equal(preview.decoded?.status, "success");
  assert.equal(
    preview.txHash,
    hex(txHash(solFixture.address.toBytes(), solFixture.data)),
  );
  assert.deepEqual(
    preview.payments.map((p) => [p.asset, p.amount, p.recipient]),
    [
      ["SOL", "0.06821", "F4WKQYkUDBiFxCEMH49NpjjipCeHyG5a45isY8o7wpZ8"],
      ["SOL", "0.00269912", "2Q9WZbjgssyuNA1t5WLHL4SWdCiNAQCTM5FbWtGQtvjt"],
    ],
  );
  assert.match(
    preview.lines[0],
    /^Send 0\.06821 SOL from the treasury vault to F4WK/,
  );
  // The review matches the decoded bytes: still approvable.
  const matching = await previewVaultTransaction(
    noAccounts,
    solFixture,
    fixtureVault,
    txHash(solFixture.address.toBytes(), solFixture.data),
  );
  assert.equal(matching.supported, true);
});

test("a tx_hash that disagrees with the on-chain review blocks approval", async () => {
  const preview = await previewVaultTransaction(
    noAccounts,
    solFixture,
    fixtureVault,
    new Uint8Array(32),
  );
  assert.equal(preview.supported, false);
  assert.match(preview.reason!, /hash/i);
  assert.throws(() => assertReviewedPreview(preview.lines, preview), /hash/i);
});

test("unsupported, malformed and empty transactions block approval", async () => {
  const unsupported = await previewVaultTransaction(
    noAccounts,
    unsupportedFixture,
    fixtureVault,
  );
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.decoded?.status, "unsupported");
  const malformed = await previewVaultTransaction(
    noAccounts,
    { address: solFixture.address, data: solFixture.data.subarray(0, 120) },
    fixtureVault,
  );
  assert.equal(malformed.supported, false);
  assert.equal(malformed.decoded?.status, "malformed");
  // A SOL transfer that is not paid by this treasury's vault is not approvable here.
  const otherVault = await previewVaultTransaction(
    noAccounts,
    solFixture,
    Keypair.generate().publicKey,
  );
  assert.equal(otherVault.supported, false);
  const empty = await previewVaultTransaction(
    noAccounts,
    draftVaultTransaction({
      multisig: Keypair.generate().publicKey,
      creator: fixtureVault,
      index: 1n,
      vaultIndex: 0,
      message: new TransactionMessage({
        payerKey: fixtureVault,
        recentBlockhash: fixtureVault.toBase58(),
        instructions: [],
      }),
    }),
    fixtureVault,
  );
  assert.equal(empty.decoded?.status, "malformed");
  assert.equal(empty.supported, false);
});

test("a draft serialized with the Squads SDK equals the stored account bytes", () => {
  const [stored] = sqds.accounts.VaultTransaction.fromAccountInfo({
    data: solFixture.data,
  } as Info);
  const m = stored.message;
  const keys = m.accountKeys;
  const signer = (i: number) => i < m.numSigners;
  const writable = (i: number) =>
    i < m.numWritableSigners ||
    (i >= m.numSigners && i - m.numSigners < m.numWritableNonSigners);
  const message = new TransactionMessage({
    payerKey: keys[0],
    recentBlockhash: keys[0].toBase58(),
    instructions: m.instructions.map((ix) => ({
      programId: keys[ix.programIdIndex],
      keys: Array.from(ix.accountIndexes, (i) => ({
        pubkey: keys[i],
        isSigner: signer(i),
        isWritable: writable(i),
      })),
      data: Buffer.from(ix.data),
    })),
  });
  const draft = draftVaultTransaction({
    multisig: stored.multisig,
    creator: stored.creator,
    index: BigInt(stored.index.toString()),
    vaultIndex: stored.vaultIndex,
    message,
  });
  assert.equal(draft.address.toBase58(), solFixture.address.toBase58());
  assert.equal(hex(draft.data), hex(solFixture.data));
});

// A guarded token payment draft: one TransferChecked into the recipient's existing account.
const vault = Keypair.generate().publicKey;
const multisig = Keypair.generate().publicKey;
const member = Keypair.generate().publicKey;
const recipient = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const source = Keypair.generate().publicKey;
const destination = getAssociatedTokenAddressSync(mint, recipient);
function tokenDraft(extra: TransactionInstruction[] = []) {
  const transfer = buildPaymentInstructions({
    vault,
    recipient: recipient.toBase58(),
    amount: "2.5",
    token: { mint: mint.toBase58(), source: source.toBase58(), decimals: 6 },
  })[1];
  return draftVaultTransaction({
    multisig,
    creator: member,
    index: 7n,
    vaultIndex: 0,
    message: new TransactionMessage({
      payerKey: vault,
      recentBlockhash: vault.toBase58(),
      instructions: [transfer, ...extra],
    }),
  });
}
const liveAccounts = () =>
  new Map<string, Info>([
    [source.toBase58(), tokenAccount(mint, vault)],
    [mint.toBase58(), mintAccount(6)],
    [destination.toBase58(), tokenAccount(mint, recipient)],
  ]);

test("a token draft shows amount, mint and recipient from the decoded TransferChecked", async () => {
  const preview = await previewVaultTransaction(
    rpcWith(liveAccounts()),
    tokenDraft(),
    vault,
  );
  assert.equal(preview.supported, true, preview.reason);
  assert.deepEqual(preview.payments, [
    {
      asset: "token",
      amount: "2.5",
      rawAmount: "2500000",
      decimals: 6,
      mint: mint.toBase58(),
      recipient: recipient.toBase58(),
      destination: destination.toBase58(),
    },
  ]);
  for (const value of [
    mint.toBase58(),
    recipient.toBase58(),
    destination.toBase58(),
  ])
    assert.ok(preview.lines[0].includes(value));
});

test("live token accounts must confirm the decoded payment", async () => {
  const cases: [string, (a: Map<string, Info>) => void][] = [
    [
      "source not owned by the vault",
      (a) => a.set(source.toBase58(), tokenAccount(mint, recipient)),
    ],
    ["mint decimals differ", (a) => a.set(mint.toBase58(), mintAccount(9))],
    ["destination missing", (a) => a.delete(destination.toBase58())],
    [
      "destination of another mint",
      (a) =>
        a.set(
          destination.toBase58(),
          tokenAccount(Keypair.generate().publicKey, recipient),
        ),
    ],
  ];
  for (const [name, change] of cases) {
    const accounts = liveAccounts();
    change(accounts);
    const preview = await previewVaultTransaction(
      rpcWith(accounts),
      tokenDraft(),
      vault,
    );
    assert.equal(preview.supported, false, name);
  }
  const failing = {
    getMultipleAccountsInfo: async () => {
      throw new Error("rpc down");
    },
  };
  assert.equal(
    (await previewVaultTransaction(failing, tokenDraft(), vault)).supported,
    false,
  );
});

test("a decoded non-payment instruction blocks approval", async () => {
  const hidden = createSetAuthorityInstruction(
    source,
    vault,
    AuthorityType.AccountOwner,
    Keypair.generate().publicKey,
  );
  const preview = await previewVaultTransaction(
    rpcWith(liveAccounts()),
    tokenDraft([hidden]),
    vault,
  );
  assert.equal(preview.supported, false);
  assert.match(preview.reason!, /setAuthority/);
  assert.equal(preview.decoded?.status, "success");
});

test("a standard token payment that creates the recipient account is described in order", async () => {
  const instructions = buildPaymentInstructions({
    vault,
    recipient: recipient.toBase58(),
    amount: "1",
    token: { mint: mint.toBase58(), source: source.toBase58(), decimals: 6 },
  });
  const accounts = liveAccounts();
  accounts.delete(destination.toBase58());
  const preview = await previewVaultTransaction(
    rpcWith(accounts),
    draftVaultTransaction({
      multisig,
      creator: member,
      index: 3n,
      vaultIndex: 0,
      message: new TransactionMessage({
        payerKey: vault,
        recentBlockhash: vault.toBase58(),
        instructions,
      }),
    }),
    vault,
  );
  assert.equal(preview.supported, true, preview.reason);
  assert.match(preview.lines[0], /^Create token account/);
  assert.equal(preview.payments[0].recipient, recipient.toBase58());
});

test("list labels come from decoded actions", async () => {
  const sol = await previewVaultTransaction(
    noAccounts,
    solFixture,
    fixtureVault,
  );
  assert.equal(
    paymentLabel(sol.decoded!, () => "SOL"),
    "Send 0.06821 SOL",
  );
  const token = await previewVaultTransaction(noAccounts, tokenDraft(), vault);
  assert.equal(
    paymentLabel(token.decoded!, (m) =>
      m === mint.toBase58() ? "mUSD" : "SOL",
    ),
    "Send 2.5 mUSD",
  );
  const unsupported = await previewVaultTransaction(
    noAccounts,
    unsupportedFixture,
    fixtureVault,
  );
  assert.equal(
    paymentLabel(unsupported.decoded!, () => "SOL"),
    undefined,
  );
});

// Token owners are mutable: a fresh decode must match what the signer reviewed.
test("approval rejects changed details and missing or incomplete previews", () => {
  const reviewed = ["Send 1 token to wallet A."];
  const fresh = { supported: true, lines: [...reviewed], payments: [] };
  assert.doesNotThrow(() => assertReviewedPreview(reviewed, fresh));
  assert.throws(
    () =>
      assertReviewedPreview(reviewed, {
        ...fresh,
        lines: ["Send 1 token to wallet B."],
      }),
    /changed/,
  );
  assert.throws(() => assertReviewedPreview(undefined, fresh), /Review/);
  assert.throws(
    () =>
      assertReviewedPreview(reviewed, {
        ...fresh,
        supported: false,
        reason: "Owner unavailable",
      }),
    /Owner unavailable/,
  );
});

test("the app no longer carries its own instruction decoder", async () => {
  const payments = await import("../src/lib/squads/payments");
  assert.equal("previewMessage" in payments, false);
  assert.equal("readPaymentPreview" in payments, false);
});

// Policy change markers are not payments: the decoder reports them as unsupported, and the
// app routes them to the policy-change view (readPolicyChange) before any payment gate.
test("a policy change marker is unsupported for payments but still recognised as a policy change", async () => {
  const { buildPolicyChangeInstruction, readPolicyChange } =
    await import("../src/lib/squads/policy");
  const guard = Keypair.generate().publicKey;
  const draft = draftVaultTransaction({
    multisig,
    creator: member,
    index: 9n,
    vaultIndex: 0,
    message: new TransactionMessage({
      payerKey: vault,
      recentBlockhash: vault.toBase58(),
      instructions: [
        buildPolicyChangeInstruction(
          guard,
          new Uint8Array(32).fill(1),
          new Uint8Array(32).fill(2),
        ),
      ],
    }),
  });
  const preview = await previewVaultTransaction(noAccounts, draft, vault);
  assert.equal(preview.supported, false);
  assert.equal(preview.decoded?.status, "unsupported");
  const [stored] = sqds.accounts.VaultTransaction.fromAccountInfo({
    data: Buffer.from(draft.data),
  } as Info);
  assert.equal(
    readPolicyChange(stored.message, guard)?.newPolicyHash,
    "01".repeat(32),
  );
});
