import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import {
  sanitizeRunnerStatus,
  sanitizeRunnerReviews,
  fetchRunner,
  reviewsMultisig,
} from "../src/lib/runner/server";

test("runner status keeps only the public health fields", () => {
  const status = sanitizeRunnerStatus({
    ok: true,
    programId: "secret-ish",
    listener: {
      ok: true,
      subscribed: true,
      lastBackfillAt: 1_700_000_000_000,
      lastBackfillError: "connect ECONNREFUSED https://key@rpc.example",
      lastLogAt: 5,
      cursor: "abc",
    },
    reviews: { pending: 2, approved: 3, rejected: "x", executed: -1 },
  });
  assert.deepEqual(status, {
    configured: true,
    reachable: true,
    ok: true,
    listener: {
      subscribed: true,
      lastBackfillAt: 1_700_000_000_000,
      backfillFailed: true,
      backfillMessage: "The last backfill failed.",
    },
    reviews: { pending: 2, approved: 3, rejected: 0, executed: 0 },
  });
  assert.ok(!JSON.stringify(status).includes("rpc.example"));
});

test("runner status tolerates missing or malformed fields", () => {
  assert.deepEqual(sanitizeRunnerStatus(null), {
    configured: true,
    reachable: true,
    ok: false,
    listener: {
      subscribed: false,
      lastBackfillAt: null,
      backfillFailed: false,
      backfillMessage: null,
    },
    reviews: { pending: 0, approved: 0, rejected: 0, executed: 0 },
  });
  assert.equal(sanitizeRunnerStatus({ ok: "yes" }).ok, false);
});

test("runner reviews are filtered to the multisig and sanitized", () => {
  const multisig = Keypair.generate().publicKey.toBase58();
  const other = Keypair.generate().publicKey.toBase58();
  const review = Keypair.generate().publicKey.toBase58();
  const row = {
    review,
    multisig,
    tx_index: "12",
    status: "rejected",
    reason: 8,
    tx_hash: "ab",
    tx_signature: "sig",
    updated_at: 1_700_000_000,
    trigger_status: "sent",
    trigger_attempts: 1,
    trigger_error: "http://runner.internal failed",
  };
  const result = sanitizeRunnerReviews(
    {
      reviews: [
        row,
        { ...row, multisig: other },
        { ...row, status: "weird" },
        { ...row, tx_index: "1e3" },
        { ...row, review: "not a key" },
        { ...row, reason: null, status: "pending", trigger_status: "bogus" },
      ],
    },
    multisig,
  );
  assert.deepEqual(result, [
    {
      review,
      txIndex: "12",
      status: "rejected",
      reason: 8,
      updatedAt: 1_700_000_000,
      triggerStatus: "sent",
    },
    {
      review,
      txIndex: "12",
      status: "pending",
      reason: null,
      updatedAt: 1_700_000_000,
      triggerStatus: "none",
    },
  ]);
  assert.deepEqual(sanitizeRunnerReviews({}, multisig), []);
  assert.deepEqual(sanitizeRunnerReviews(null, multisig), []);
});

test("the reviews proxy filters to the requested treasury only", () => {
  const multisig = Keypair.generate().publicKey.toBase58();
  assert.equal(
    reviewsMultisig(
      new URL(`http://localhost/api/runner/reviews?multisig=${multisig}`),
    ),
    multisig,
  );
  for (const bad of [
    "",
    "?multisig=",
    "?multisig=nope",
    `?multisig=${multisig}0`,
    `?multisig=%20${multisig}`,
  ])
    assert.equal(
      reviewsMultisig(new URL(`http://localhost/api/runner/reviews${bad}`)),
      null,
    );
});

test("fetchRunner reports unconfigured and unreachable runners", async () => {
  const previous = process.env.WYSIWYS_SETTLEMENT_URL;
  try {
    delete process.env.WYSIWYS_SETTLEMENT_URL;
    assert.deepEqual(await fetchRunner("/status"), { kind: "unconfigured" });
    process.env.WYSIWYS_SETTLEMENT_URL = "http://127.0.0.1:1";
    assert.deepEqual(await fetchRunner("/status"), { kind: "unreachable" });
    process.env.WYSIWYS_SETTLEMENT_URL = "not a url";
    assert.deepEqual(await fetchRunner("/status"), { kind: "unreachable" });
  } finally {
    if (previous === undefined) delete process.env.WYSIWYS_SETTLEMENT_URL;
    else process.env.WYSIWYS_SETTLEMENT_URL = previous;
  }
});
