import { test } from "node:test";
import assert from "node:assert/strict";
import type { PublicKey } from "@solana/web3.js";
import { Listener, type ChainSource } from "../src/listener";
import { createEventParser } from "../src/events";
import { openStore } from "../src/store";
import type { Trigger } from "../src/trigger";
import { PROGRAM_ID, decisionRecorded, guardLogs, idl, key, reviewRequested } from "./helpers";

type Tx = { signature: string; slot: number; logs: string[]; err?: unknown };

/** In-memory chain: txs in chronological order; getSignaturesForAddress pages newest first like the RPC. */
class FakeChain implements ChainSource {
  txs: Tx[] = [];
  calls: { before?: string; until?: string; limit?: number }[] = [];
  logsCallback?: Parameters<ChainSource["onLogs"]>[1];
  missing = new Set<string>();

  async getSignaturesForAddress(_a: PublicKey, o: { before?: string; until?: string; limit?: number } = {}) {
    this.calls.push(o);
    let list = [...this.txs].reverse();
    if (o.before) list = list.slice(list.findIndex((t) => t.signature === o.before) + 1);
    if (o.until) {
      const i = list.findIndex((t) => t.signature === o.until);
      if (i >= 0) list = list.slice(0, i);
    }
    return list
      .slice(0, o.limit ?? 1000)
      .map((t) => ({ signature: t.signature, slot: t.slot, err: t.err ?? null, blockTime: t.slot * 10, memo: null }));
  }

  async getTransaction(sig: string) {
    if (this.missing.has(sig)) return null;
    const t = this.txs.find((x) => x.signature === sig)!;
    return { slot: t.slot, blockTime: t.slot * 10, meta: { err: t.err ?? null, logMessages: t.logs } } as any;
  }

  onLogs(_p: PublicKey, cb: Parameters<ChainSource["onLogs"]>[1]) {
    this.logsCallback = cb;
    return 1;
  }

  async removeOnLogsListener() {}
}

class FakeTrigger implements Trigger {
  sent: string[] = [];
  failNext = 0;
  async send(r: { review: string; multisig: string; txIndex: string }) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("down");
    }
    this.sent.push(`${r.multisig}:${r.txIndex}`);
  }
}

function setup(now = () => 1_000_000) {
  const chain = new FakeChain();
  const store = openStore(":memory:");
  const trigger = new FakeTrigger();
  const listener = new Listener({
    connection: chain, programId: PROGRAM_ID, store, parse: createEventParser(idl, PROGRAM_ID), trigger, now, log: () => {},
  });
  return { chain, store, trigger, listener };
}

const tx = (signature: string, slot: number, lines: string[], err?: unknown): Tx => ({ signature, slot, logs: guardLogs(lines), err });

test("backfill stores events oldest first and moves the cursor to the newest signature", async () => {
  const { chain, store, listener } = setup();
  chain.txs = [tx("a", 1, [reviewRequested(key(1))]), tx("b", 2, [decisionRecorded(key(1), 1)])];
  await listener.backfill();
  assert.equal(store.getReview(key(1).toBase58())!.status, "approved");
  assert.equal(store.getCursor(), "b");
});

test("backfill only fetches signatures after the cursor", async () => {
  const { chain, store, listener } = setup();
  chain.txs = [tx("a", 1, [reviewRequested(key(1))])];
  await listener.backfill();
  chain.txs.push(tx("b", 2, [reviewRequested(key(2), 8)]));
  chain.calls = [];
  await listener.backfill();
  assert.equal(chain.calls[0].until, "a");
  assert.equal(store.listReviews().length, 2);
  assert.equal(store.getCursor(), "b");
});

test("backfill pages past the RPC limit", async () => {
  const { chain, store, listener } = setup();
  for (let i = 0; i < 5; i++) chain.txs.push(tx(`s${i}`, i + 1, [reviewRequested(key(i + 1), i)]));
  listener.pageSize = 2;
  await listener.backfill();
  assert.equal(store.listReviews().length, 5);
  assert.equal(store.getCursor(), "s4");
  assert.ok(chain.calls.length >= 3);
});

test("failed transactions and other programs are ignored", async () => {
  const { chain, store, listener } = setup();
  chain.txs = [tx("a", 1, [reviewRequested(key(1))], { InstructionError: [0, "Custom"] })];
  chain.txs.push({ signature: "b", slot: 2, logs: guardLogs([reviewRequested(key(2))], key(99)) });
  await listener.backfill();
  assert.equal(store.listReviews().length, 0);
  assert.equal(store.getCursor(), "b");
});

test("a transaction the RPC cannot return yet stops the backfill without skipping it", async () => {
  const { chain, store, listener } = setup();
  chain.txs = [tx("a", 1, [reviewRequested(key(1))]), tx("b", 2, [reviewRequested(key(2))])];
  chain.missing.add("b");
  await listener.backfill();
  assert.equal(store.getCursor(), "a");
  assert.ok(listener.health().lastBackfillError);
  chain.missing.clear();
  await listener.backfill();
  assert.equal(store.getCursor(), "b");
  assert.equal(listener.health().lastBackfillError, null);
});

test("an event seen on the WebSocket and again in the backfill is stored and triggered once", async () => {
  const { chain, store, trigger, listener } = setup();
  await listener.start();
  const t = tx("a", 1, [reviewRequested(key(1), 4)]);
  chain.txs.push(t);
  await listener.handleLogs({ signature: "a", err: null, logs: t.logs }, { slot: 1 });
  await listener.tick();
  assert.equal(store.listEvents().length, 1);
  assert.deepEqual(trigger.sent, [`${key(2).toBase58()}:4`]);
  await listener.stop();
});

test("WebSocket logs of failed transactions are ignored", async () => {
  const { store, listener } = setup();
  await listener.handleLogs({ signature: "a", err: { x: 1 }, logs: guardLogs([reviewRequested(key(1))]) }, { slot: 1 });
  assert.equal(store.listReviews().length, 0);
});

test("a failed trigger is retried on the next run", async () => {
  const { chain, store, trigger, listener } = setup();
  chain.txs = [tx("a", 1, [reviewRequested(key(1), 4)])];
  trigger.failNext = 1;
  await listener.tick();
  assert.equal(store.getReview(key(1).toBase58())!.trigger_status, "failed");
  await listener.tick();
  assert.equal(store.getReview(key(1).toBase58())!.trigger_status, "sent");
  assert.equal(trigger.sent.length, 1);
});

test("health is ok after a recent backfill and fails when it is stale", async () => {
  let t = 1_000_000;
  const { listener } = setup(() => t);
  assert.equal(listener.health().ok, false);
  await listener.start();
  assert.equal(listener.health().ok, true);
  t += 121_000;
  assert.equal(listener.health().ok, false);
  await listener.stop();
  assert.equal(listener.health().subscribed, false);
});
