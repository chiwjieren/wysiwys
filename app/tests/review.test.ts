import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  REVIEW_DISCRIMINATOR,
  REVIEW_SIZE,
  decodeReview,
  decodeReviewAccount,
  executeGate,
  isGuarded,
  readReviews,
  reviewPda,
  reviewReasonText,
  reviewState,
  reviewStateLabel,
} from "../src/lib/squads/review";

const multisig = Keypair.generate().publicKey;
const guard = Keypair.generate().publicKey;
const vaultTransaction = Keypair.generate().publicKey;
const proposal = Keypair.generate().publicKey;

function reviewBytes(
  overrides: {
    status?: number;
    reason?: number;
    expiresAt?: bigint;
    index?: bigint;
    multisig?: PublicKey;
    discriminator?: number[];
  } = {},
) {
  const data = new Uint8Array(REVIEW_SIZE);
  const view = new DataView(data.buffer);
  data.set(overrides.discriminator ?? REVIEW_DISCRIMINATOR, 0);
  data[8] = 1;
  data.set((overrides.multisig ?? multisig).toBytes(), 9);
  data.set(vaultTransaction.toBytes(), 41);
  data.set(proposal.toBytes(), 73);
  view.setBigUint64(105, overrides.index ?? 7n, true);
  data.fill(0xaa, 113, 145);
  data[145] = overrides.status ?? 1;
  view.setUint16(146, overrides.reason ?? 0, true);
  data.fill(0xbb, 148, 180);
  data[180] = 2;
  data.fill(0xcc, 181, 213);
  view.setBigInt64(213, 1_700_000_000n, true);
  view.setBigInt64(221, overrides.expiresAt ?? 1_700_000_900n, true);
  view.setBigInt64(229, 1_699_999_000n, true);
  data[237] = 254;
  return data;
}

test("readReviews batches one finalized read and maps missing accounts to null", async () => {
  const calls: { keys: PublicKey[]; commitment: unknown }[] = [];
  const connection = {
    getMultipleAccountsInfo: async (keys: PublicKey[], commitment: unknown) => {
      calls.push({ keys, commitment });
      return [{ owner: guard, data: Buffer.from(reviewBytes()) }, null];
    },
  } as never;
  const reviews = await readReviews(connection, guard, multisig, [7n, 6n]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].commitment, "finalized");
  assert.ok(calls[0].keys[0].equals(reviewPda(guard, multisig, 7n)));
  assert.equal(reviews["7"]?.status, "Approved");
  assert.equal(reviews["6"], null);
  assert.deepEqual(await readReviews(connection, guard, multisig, []), {});
});

test("only guarded groups with a guard program read reviews", () => {
  const base = {
    multisig: multisig.toBase58(),
    vaultIndex: 0,
    settlementEnabled: true,
  };
  assert.equal(
    isGuarded({
      ...base,
      guardProgram: guard.toBase58(),
      executionMode: "guarded",
    }),
    true,
  );
  assert.equal(isGuarded({ ...base, executionMode: "standard" }), false);
  assert.equal(
    isGuarded({
      ...base,
      guardProgram: guard.toBase58(),
      executionMode: "standard",
    }),
    false,
  );
  assert.equal(isGuarded({ ...base, executionMode: "guarded" }), false);
  assert.equal(isGuarded(undefined), false);
});

test("review discriminator matches the guard IDL", () => {
  const idl = JSON.parse(
    readFileSync(
      new URL("../../packages/shared/idl/wysiwys_guard.json", import.meta.url),
      "utf8",
    ),
  );
  const entry = idl.accounts.find((a: { name: string }) => a.name === "Review");
  assert.deepEqual([...REVIEW_DISCRIMINATOR], entry.discriminator);
  assert.equal(REVIEW_SIZE, 238);
});

test("decodeReview parses every field", () => {
  const review = decodeReview(reviewBytes({ status: 2, reason: 8 }));
  assert.equal(review.version, 1);
  assert.ok(review.multisig.equals(multisig));
  assert.ok(review.vaultTransaction.equals(vaultTransaction));
  assert.ok(review.proposal.equals(proposal));
  assert.equal(review.txIndex, 7n);
  assert.equal(review.status, "Rejected");
  assert.equal(review.reason, 8);
  assert.equal(review.actionKind, 2);
  assert.equal(review.issuedAt, 1_700_000_000);
  assert.equal(review.expiresAt, 1_700_000_900);
  assert.equal(review.createdAt, 1_699_999_000);
  assert.equal(review.bump, 254);
  for (const [byte, status] of [
    [0, "Pending"],
    [1, "Approved"],
    [3, "Executed"],
  ] as const)
    assert.equal(decodeReview(reviewBytes({ status: byte })).status, status);
});

test("decodeReview rejects short data, bad discriminators and unknown status", () => {
  assert.throws(() => decodeReview(reviewBytes().subarray(0, 237)));
  assert.throws(() => decodeReview(new Uint8Array(0)));
  assert.throws(() =>
    decodeReview(reviewBytes({ discriminator: [1, 2, 3, 4, 5, 6, 7, 8] })),
  );
  assert.throws(() => decodeReview(reviewBytes({ status: 4 })));
});

test("decodeReviewAccount requires the guard owner and binding", () => {
  const data = reviewBytes();
  const review = decodeReviewAccount(
    { owner: guard, data },
    guard,
    multisig,
    7n,
  );
  assert.equal(review.status, "Approved");
  assert.throws(() =>
    decodeReviewAccount(
      { owner: Keypair.generate().publicKey, data },
      guard,
      multisig,
      7n,
    ),
  );
  assert.throws(() =>
    decodeReviewAccount({ owner: guard, data }, guard, multisig, 8n),
  );
  assert.throws(() =>
    decodeReviewAccount(
      { owner: guard, data },
      guard,
      Keypair.generate().publicKey,
      7n,
    ),
  );
});

test("reviewPda uses review, multisig and the u64 LE index", () => {
  const index = Buffer.alloc(8);
  index.writeBigUInt64LE(258n);
  const [expected] = PublicKey.findProgramAddressSync(
    [Buffer.from("review"), multisig.toBuffer(), index],
    guard,
  );
  assert.ok(reviewPda(guard, multisig, 258n).equals(expected));
});

test("reason codes 0 to 13 have fixed plain-English text", () => {
  const expected = [
    "Within policy",
    "Blocked: the RPC providers did not agree",
    "Blocked: the stored transaction changed after review was requested",
    "Blocked: the payment calls an unknown program",
    "Blocked: the payment contains an unexpected instruction",
    "Blocked: the payment uses an unsupported feature",
    "Blocked: the payment hides an authority change",
    "Blocked: the payment uses a durable nonce",
    "Blocked: the recipient is not on the approved list",
    "Blocked: the recipient owner could not be resolved",
    "Blocked: the token is not allowed",
    "Blocked: the amount is over the per-payment limit",
    "Blocked: the recipient failed sanctions screening",
    "Blocked: the policy changed since review",
  ];
  expected.forEach((text, code) => assert.equal(reviewReasonText(code), text));
  assert.equal(reviewReasonText(99), "Unknown reason code 99");
  for (const text of expected) assert.ok(!text.includes("—"));
});

test("review state treats an approved review past expiry as expired", () => {
  const review = decodeReview(reviewBytes({ expiresAt: 1000n }));
  assert.equal(reviewState(review, 999), "approved");
  assert.equal(reviewState(review, 1001), "expired");
  assert.equal(reviewState(null, 0), "none");
  assert.equal(
    reviewState(decodeReview(reviewBytes({ status: 0 })), 0),
    "pending",
  );
  assert.equal(reviewStateLabel("pending"), "Pending review");
  assert.equal(reviewStateLabel("expired"), "Expired");
  assert.equal(reviewStateLabel("none"), "No review requested");
});

test("execute gate needs Squads approval and an unexpired approved review", () => {
  const approved = decodeReview(reviewBytes({ expiresAt: 2000n }));
  assert.deepEqual(executeGate("Approved", approved, 1000), {
    enabled: true,
    reason: "",
  });
  assert.equal(
    executeGate("Approved", approved, 3000).reason,
    "Review expired",
  );
  assert.equal(
    executeGate("Active", approved, 1000).reason,
    "Waiting for member approvals",
  );
  assert.equal(
    executeGate("Approved", decodeReview(reviewBytes({ status: 0 })), 1000)
      .reason,
    "Waiting for the Chainlink review",
  );
  assert.equal(
    executeGate(
      "Approved",
      decodeReview(reviewBytes({ status: 2, reason: 6 })),
      1000,
    ).reason,
    "Rejected by the Chainlink review: the payment hides an authority change",
  );
  assert.equal(
    executeGate("Approved", null, 1000).reason,
    "No review requested",
  );
  assert.equal(
    executeGate("Executed", decodeReview(reviewBytes({ status: 3 })), 1000)
      .reason,
    "Already executed",
  );
  for (const status of ["Approved", "Active"])
    assert.equal(
      executeGate(status, approved, 1000).enabled,
      status === "Approved",
    );
});
