import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/store";
import type { DecisionRecorded, Executed, PolicyChanged, ReviewRequested } from "../src/events";

const R = "Review1111111111111111111111111111111111111";
const requested: ReviewRequested = { name: "ReviewRequested", review: R, multisig: "Ms11", txIndex: "7", txHash: "ab".repeat(32) };
const decided = (verdict: number, reason = 0): DecisionRecorded => ({
  name: "DecisionRecorded", review: R, verdict, reason, policyHash: "03".repeat(32), actionKind: 2,
  destinationHash: "04".repeat(32), expiresAt: "1800000000",
});
const executed: Executed = { name: "Executed", review: R, multisig: "Ms11", txIndex: "7" };
const meta = (signature: string, idx = 0, blockTime = 100) => ({ signature, idx, slot: 1, blockTime });

test("ReviewRequested creates a pending review", () => {
  const s = openStore(":memory:");
  assert.equal(s.applyEvent(requested, meta("s1")), true);
  assert.deepEqual(s.getReview(R), {
    review: R, multisig: "Ms11", tx_index: "7", status: "pending", reason: null, tx_hash: requested.txHash,
    tx_signature: "s1", updated_at: 100, trigger_status: "none", trigger_attempts: 0, trigger_error: null,
  });
});

test("the same event (signature, idx) is stored once", () => {
  const s = openStore(":memory:");
  assert.equal(s.applyEvent(requested, meta("s1")), true);
  assert.equal(s.applyEvent(requested, meta("s1")), false);
  assert.equal(s.listEvents().length, 1);
});

test("status moves pending -> approved -> executed with reason and signature", () => {
  const s = openStore(":memory:");
  s.applyEvent(requested, meta("s1"));
  s.applyEvent(decided(1), meta("s2", 0, 110));
  assert.equal(s.getReview(R)!.status, "approved");
  s.applyEvent(executed, meta("s3", 0, 120));
  const r = s.getReview(R)!;
  assert.equal(r.status, "executed");
  assert.equal(r.reason, 0);
  assert.equal(r.tx_signature, "s3");
  assert.equal(r.updated_at, 120);
});

test("a reject verdict records the reason", () => {
  const s = openStore(":memory:");
  s.applyEvent(requested, meta("s1"));
  s.applyEvent(decided(2, 8), meta("s2"));
  assert.equal(s.getReview(R)!.status, "rejected");
  assert.equal(s.getReview(R)!.reason, 8);
});

test("out of order: later events never regress and identifiers are filled in", () => {
  const s = openStore(":memory:");
  s.applyEvent(executed, meta("s3", 0, 120));
  s.applyEvent(decided(1), meta("s2", 0, 110));
  s.applyEvent(requested, meta("s1", 0, 100));
  const r = s.getReview(R)!;
  assert.equal(r.status, "executed");
  assert.equal(r.tx_hash, requested.txHash);
  assert.equal(r.multisig, "Ms11");
  assert.equal(r.tx_signature, "s3");
});

test("pendingTriggers lists pending reviews not yet triggered, and failed ones for retry", () => {
  const s = openStore(":memory:");
  s.applyEvent(requested, meta("s1"));
  assert.deepEqual(s.pendingTriggers(), [{ review: R, multisig: "Ms11", txIndex: "7" }]);
  s.markTrigger(R, false, "connect ECONNREFUSED");
  assert.equal(s.getReview(R)!.trigger_status, "failed");
  assert.equal(s.getReview(R)!.trigger_attempts, 1);
  assert.equal(s.getReview(R)!.trigger_error, "connect ECONNREFUSED");
  assert.equal(s.pendingTriggers().length, 1);
  s.markTrigger(R, true);
  assert.equal(s.getReview(R)!.trigger_status, "sent");
  assert.equal(s.getReview(R)!.trigger_attempts, 2);
  assert.deepEqual(s.pendingTriggers(), []);
});

test("decided or executed reviews are never triggered", () => {
  const s = openStore(":memory:");
  s.applyEvent(requested, meta("s1"));
  s.applyEvent(decided(2, 8), meta("s2"));
  assert.deepEqual(s.pendingTriggers(), []);
});

test("cursor persists the last processed signature", () => {
  const s = openStore(":memory:");
  assert.equal(s.getCursor(), null);
  s.setCursor("sig9");
  assert.equal(s.getCursor(), "sig9");
});

test("listReviews returns newest first and counts", () => {
  const s = openStore(":memory:");
  s.applyEvent(requested, meta("s1", 0, 100));
  s.applyEvent({ ...requested, review: "Other", txIndex: "8" }, meta("s2", 0, 200));
  assert.deepEqual(s.listReviews(10).map((r) => r.review), ["Other", R]);
  assert.deepEqual(s.counts(), { pending: 2 });
});

test("a review stops being retried after the maximum number of trigger attempts", () => {
  const s = openStore(":memory:");
  s.applyEvent(requested, meta("s1"));
  for (let i = 0; i < 4; i++) s.markTrigger(R, false, "fail");
  assert.equal(s.pendingTriggers(5).length, 1);
  s.markTrigger(R, false, "fail");
  assert.deepEqual(s.pendingTriggers(5), []);
  assert.equal(s.getReview(R)!.trigger_attempts, 5);
});

test("PolicyChanged goes to the activity feed without creating a review", () => {
  const s = openStore(":memory:");
  const ev: PolicyChanged = { name: "PolicyChanged", multisig: "Ms11", txIndex: "11", oldPolicyHash: "03".repeat(32), newPolicyHash: "05".repeat(32) };
  assert.equal(s.applyEvent(ev, meta("p1")), true);
  assert.equal(s.applyEvent(ev, meta("p1")), false);
  assert.deepEqual(s.listReviews(), []);
  const [row] = s.listEvents();
  assert.equal(row!.name, "PolicyChanged");
  assert.equal(row!.review, "policy_change:Ms11:11");
});

test("stores policy documents per multisig and hash", () => {
  const s = openStore(":memory:");
  assert.equal(s.getPolicy("Ms11", "aa"), null);
  s.putPolicy({ hash: "aa", multisig: "Ms11", document: '{"version":2}', createdAt: 5 });
  s.putPolicy({ hash: "aa", multisig: "Ms11", document: '{"version":2}', createdAt: 6 }); // idempotent
  assert.equal(s.getPolicy("Ms11", "aa"), '{"version":2}');
  assert.equal(s.getPolicy("Other", "aa"), null, "a document is only served for its own multisig");
});
