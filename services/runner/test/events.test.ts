import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventParser } from "../src/events";
import { PROGRAM_ID, decisionRecorded, executed, guardLogs, idl, key, policyChanged, reviewRequested } from "./helpers";

const parse = createEventParser(idl, PROGRAM_ID);

test("parses ReviewRequested into plain JSON fields", () => {
  const [ev] = parse(guardLogs([reviewRequested(key(1), 258)]));
  assert.deepEqual(ev, {
    name: "ReviewRequested",
    review: key(1).toBase58(),
    multisig: key(2).toBase58(),
    txIndex: "258",
    txHash: "09".repeat(32),
  });
});

test("parses DecisionRecorded with destination facts", () => {
  const [ev] = parse(guardLogs([decisionRecorded(key(1), 2, 8)]));
  assert.deepEqual(ev, {
    name: "DecisionRecorded",
    review: key(1).toBase58(),
    verdict: 2,
    reason: 8,
    policyHash: "03".repeat(32),
    actionKind: 2,
    destinationHash: "04".repeat(32),
    expiresAt: "1800000000",
  });
});

test("parses Executed", () => {
  const [ev] = parse(guardLogs([executed(key(1), 3)]));
  assert.deepEqual(ev, { name: "Executed", review: key(1).toBase58(), multisig: key(2).toBase58(), txIndex: "3" });
});

test("keeps several events in log order", () => {
  const evs = parse(guardLogs([decisionRecorded(key(1)), executed(key(1))]));
  assert.deepEqual(evs.map((e) => e.name), ["DecisionRecorded", "Executed"]);
});

test("ignores events emitted by another program", () => {
  assert.deepEqual(parse(guardLogs([reviewRequested(key(1))], key(99))), []);
});

test("ignores logs without events", () => {
  assert.deepEqual(parse(["Program 11111111111111111111111111111111 invoke [1]", "Program 11111111111111111111111111111111 success"]), []);
});

test("parses PolicyChanged", () => {
  const [ev] = parse(guardLogs([policyChanged(11)]));
  assert.deepEqual(ev, {
    name: "PolicyChanged", multisig: key(2).toBase58(), txIndex: "11", oldPolicyHash: "03".repeat(32), newPolicyHash: "05".repeat(32),
  });
});
