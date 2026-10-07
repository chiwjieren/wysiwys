import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { LiveReviewRunner } from "../src/live-review";
import type { TriggerRequest } from "../src/store";

const LIVE = "LiveForwarder1111111111111111111111111111111";
const ms = Keypair.generate().publicKey.toBase58();

function runner(o: {
  forwarder?: string | null;
  decidedAfter?: number; // decided once isDecided has been called this many times (Infinity = never)
  sendError?: Error;
} = {}) {
  const sent: TriggerRequest[] = [];
  let checks = 0;
  let clock = 0;
  const live = new LiveReviewRunner({
    trigger: { send: async (r) => { if (o.sendError) throw o.sendError; sent.push(r); } },
    forwarderOf: async () => (o.forwarder === undefined ? LIVE : o.forwarder),
    liveForwarder: LIVE,
    isDecided: async () => ++checks > (o.decidedAfter ?? 1),
    timeoutMs: 60_000,
    pollMs: 5_000,
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
  });
  return { live, sent, checks: () => checks };
}

test("re-triggers a pending live review and succeeds once the chain shows the decision", async () => {
  const r = runner({ decidedAfter: 3 });
  const result = await r.live.run({ multisig: ms, txIndex: "4" });
  assert.equal(result.ok, true);
  assert.equal(result.timedOut, false);
  assert.equal(r.sent.length, 1);
  assert.deepEqual({ multisig: r.sent[0]!.multisig, txIndex: r.sent[0]!.txIndex }, { multisig: ms, txIndex: "4" });
  assert.match(result.log.join("\n"), /decided on chain/);
});

test("does not trigger a review that is already decided", async () => {
  const r = runner({ decidedAfter: 0 });
  const result = await r.live.run({ multisig: ms, txIndex: "4" });
  assert.equal(result.ok, true);
  assert.equal(r.sent.length, 0);
  assert.match(result.log.join("\n"), /already decided/);
});

test("refuses a treasury on the other review path (or unguarded) without calling CRE", async () => {
  for (const forwarder of ["SimForwarder111111111111111111111111111111", null]) {
    const r = runner({ forwarder });
    const result = await r.live.run({ multisig: ms, txIndex: "4" });
    assert.equal(result.ok, false);
    assert.equal(r.sent.length, 0);
    assert.match(result.log.join("\n"), /another review path|no guard config/);
  }
});

test("reports a gateway refusal and a missing decision as failures, never as success", async () => {
  const refused = await runner({ sendError: new Error("CRE gateway did not accept the execution (HTTP 400): paused") }).live.run({ multisig: ms, txIndex: "4" });
  assert.equal(refused.ok, false);
  assert.match(refused.log.join("\n"), /did not accept/);

  const r = runner({ decidedAfter: Infinity });
  const silent = await r.live.run({ multisig: ms, txIndex: "4" });
  assert.equal(silent.ok, false);
  assert.equal(silent.timedOut, true);
  assert.equal(r.sent.length, 1);
});

test("rejects malformed identifiers before any read", async () => {
  const r = runner();
  await assert.rejects(r.live.run({ multisig: "nope", txIndex: "4" }), /invalid review identifiers/);
  await assert.rejects(r.live.run({ multisig: ms, txIndex: "0" }), /invalid review identifiers/);
  assert.equal(r.checks(), 0);
});
