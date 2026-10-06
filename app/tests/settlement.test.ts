import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canApprove,
  canExecute,
  transitionPayout,
  canInitiateTrade,
  getPayoutStatus,
} from "../src/lib/mock/settlement";
import type { PayoutView, ReviewStage } from "../src/lib/mock/types";

const now = Date.parse("2026-10-06T02:42:00Z");
const payout: PayoutView = {
  id: "104",
  tradeId: "OTC-10428",
  stage: "approved",
  votes: 2,
  clientReceived: true,
  destinationMatches: true,
  expiresAt: "2026-10-06T02:56:32Z",
  tradeSettled: false,
};
test("verified payout accepts the final member vote", () => {
  assert.equal(canApprove(payout, now), true);
  assert.equal(transitionPayout(payout, "approve", now).votes, 3);
});
test("decoding, rejected and unavailable reviews cannot be approved or executed", () => {
  for (const stage of [
    "decoding",
    "rejected",
    "unavailable",
  ] as ReviewStage[]) {
    const blocked = { ...payout, stage, votes: 3 };
    assert.equal(canApprove(blocked, now), false);
    assert.equal(canExecute(blocked, now), false);
    assert.deepEqual(transitionPayout(blocked, "approve", now), blocked);
  }
});
test("client proof, wallet match and expiry gate approval and execution", () => {
  for (const blocked of [
    { ...payout, clientReceived: false },
    { ...payout, destinationMatches: false },
    { ...payout, expiresAt: "invalid" },
    { ...payout, expiresAt: new Date(now).toISOString() },
  ]) {
    assert.equal(canApprove(blocked, now), false);
    assert.equal(canExecute({ ...blocked, votes: 3 }, now), false);
  }
});
test("execution requires exactly three votes and cannot be repeated", () => {
  assert.equal(canExecute(payout, now), false);
  const ready = { ...payout, votes: 3 };
  assert.equal(canExecute(ready, now), true);
  const executing = transitionPayout(ready, "execute", now);
  assert.equal(executing.stage, "executing");
  assert.deepEqual(transitionPayout(executing, "execute", now), executing);
});
test("a rejected review is final even if verification later completes", () => {
  const rejected = transitionPayout(payout, "reject", now);
  assert.equal(rejected.stage, "rejected");
  assert.deepEqual(
    transitionPayout(rejected, "verificationComplete", now),
    rejected,
  );
});
test("payout execution and trade settlement are separate transitions", () => {
  const executed = transitionPayout(
    { ...payout, stage: "executing", votes: 3 },
    "executionConfirmed",
    now,
  );
  assert.equal(executed.stage, "executed");
  assert.equal(executed.tradeSettled, false);
  assert.equal(
    transitionPayout(executed, "tradeSettled", now).tradeSettled,
    true,
  );
  assert.equal(
    transitionPayout(payout, "tradeSettled", now).tradeSettled,
    false,
  );
});
import { mockTrades } from "../src/lib/mock/data";

test("a trade with executing or executed payout cannot be initiated again", () => {
  const trade = mockTrades[0];
  assert.equal(canInitiateTrade(trade, [], now), true);
  for (const stage of ["executing", "executed"] as ReviewStage[]) {
    assert.equal(canInitiateTrade(trade, [{ ...payout, stage }], now), false);
  }
  assert.equal(
    canInitiateTrade({ ...trade, status: "Expired" }, [], now),
    false,
  );
  assert.equal(
    canInitiateTrade({ ...trade, status: "Cancelled" }, [], now),
    false,
  );
});
test("a sibling payout cannot execute after another payout starts execution", () => {
  const ready = { ...payout, id: "105", votes: 3 };
  for (const stage of ["executing", "executed"] as ReviewStage[]) {
    assert.equal(canExecute(ready, now, [{ ...payout, stage }, ready]), false);
  }
});
test("lists show verification, rejection, confirmation and expiry honestly", () => {
  assert.equal(
    getPayoutStatus({ ...payout, stage: "decoding" }, now),
    "Decoding",
  );
  assert.equal(
    getPayoutStatus({ ...payout, stage: "rejected" }, now),
    "Blocked",
  );
  assert.equal(
    getPayoutStatus({ ...payout, stage: "executing", votes: 3 }, now),
    "Confirming",
  );
  assert.equal(
    getPayoutStatus({ ...payout, expiresAt: new Date(now).toISOString() }, now),
    "Expired",
  );
  assert.equal(
    getPayoutStatus({ ...payout, stage: "executed", tradeSettled: false }, now),
    "Executed",
  );
  assert.equal(
    getPayoutStatus({ ...payout, stage: "executed", tradeSettled: true }, now),
    "Settled",
  );
});
