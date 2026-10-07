import test from "node:test";
import assert from "node:assert/strict";
import { proposalProgress } from "../src/lib/squads/progress";
import type { Review } from "../src/lib/squads/review";

const NOW = 1_800_000_000;
const review = (status: Review["status"], extra: Partial<Review> = {}) =>
  ({ status, reason: 0, expiresAt: NOW + 600, issuedAt: NOW, createdAt: NOW - 30, ...extra }) as Review;
const states = (steps: ReturnType<typeof proposalProgress>) => steps.map((s) => `${s.key}:${s.state}`);
const base = { kind: "vault" as const, guarded: true, threshold: 3, nowSeconds: NOW };

test("a fresh guarded payment waits on the Chainlink review and the votes at the same time", () => {
  const steps = proposalProgress({ ...base, proposalStatus: "Active", approvals: 1, review: review("Pending") });
  assert.deepEqual(states(steps), ["proposed:done", "review:active", "votes:active", "execute:waiting"]);
  assert.equal(steps.find((s) => s.key === "votes")!.detail, "1 of 3 approved");
});

test("votes can finish before the review", () => {
  const steps = proposalProgress({ ...base, proposalStatus: "Approved", approvals: 3, review: review("Pending") });
  assert.deepEqual(states(steps), ["proposed:done", "review:active", "votes:done", "execute:waiting"]);
});

test("both approvals make execution the active step", () => {
  const steps = proposalProgress({ ...base, proposalStatus: "Approved", approvals: 3, review: review("Approved") });
  assert.deepEqual(states(steps), ["proposed:done", "review:done", "votes:done", "execute:active"]);
  assert.equal(steps.at(-1)!.detail, "Ready to execute");
});

test("an executed payment is complete (also once Squads archived the transaction)", () => {
  for (const kind of ["vault", "archived"] as const)
    assert.deepEqual(
      states(proposalProgress({ ...base, kind, proposalStatus: "Executed", approvals: 3, review: review("Executed") })),
      ["proposed:done", "review:done", "votes:done", "execute:done"],
    );
});

test("a rejected or expired review blocks execution", () => {
  const rejected = proposalProgress({ ...base, proposalStatus: "Active", approvals: 0, review: review("Rejected", { reason: 8 }) });
  assert.deepEqual(states(rejected), ["proposed:done", "review:failed", "votes:active", "execute:failed"]);
  assert.equal(rejected[1]!.detail, "The recipient is not on the approved list");
  const expired = proposalProgress({ ...base, proposalStatus: "Approved", approvals: 3, review: review("Approved", { expiresAt: NOW - 1 }) });
  assert.equal(expired[1]!.state, "failed");
  assert.equal(expired.at(-1)!.state, "failed");
});

test("missing or unreadable reviews are shown as such", () => {
  assert.equal(proposalProgress({ ...base, proposalStatus: "Active", approvals: 0, review: null })[1]!.state, "failed");
  const unreadable = proposalProgress({ ...base, proposalStatus: "Active", approvals: 0, review: undefined })[1]!;
  assert.equal(unreadable.state, "waiting");
  assert.equal(unreadable.detail, "Review unavailable");
});

test("rejected or cancelled proposals stop at the vote", () => {
  for (const proposalStatus of ["Rejected", "Cancelled"])
    assert.deepEqual(
      states(proposalProgress({ ...base, proposalStatus, approvals: 0, review: review("Approved") })).slice(2),
      ["votes:failed", "execute:failed"],
    );
});

test("unguarded payments and config changes have no review step", () => {
  assert.deepEqual(
    states(proposalProgress({ ...base, guarded: false, proposalStatus: "Active", approvals: 1, review: undefined })),
    ["proposed:done", "votes:active", "execute:waiting"],
  );
  const config = proposalProgress({ ...base, kind: "config", proposalStatus: "Executed", approvals: 3, review: undefined });
  assert.deepEqual(states(config), ["proposed:done", "votes:done", "execute:done"]);
  assert.equal(config.at(-1)!.label, "Applied");
});
