import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { ModeSwitch, type ReviewPath } from "../src/mode";
import { createStatusServer } from "../src/server";
import { openStore } from "../src/store";
import type { TriggerRequest } from "../src/store";

const meta = (signature: string, blockTime: number) => ({ signature, idx: 0, slot: 1, blockTime });
const requested = (review: string, txIndex: string) =>
  ({ name: "ReviewRequested", review, multisig: "Ms1", txIndex, txHash: "aa" }) as never;

function path(name: string, calls: string[]): ReviewPath {
  return {
    forwarder: `${name}Forwarder`,
    trigger: { send: async (r: TriggerRequest) => void calls.push(`${name}:send:${r.review}`) },
    review: { run: async (r) => (calls.push(`${name}:run:${r.txIndex}`), { ok: true, exitCode: 0, timedOut: false, durationMs: 1, log: [] }) },
  };
}

test("store keeps settings and re-queues only recent pending reviews", () => {
  const store = openStore(":memory:");
  assert.equal(store.getSetting("reviewMode"), null);
  store.setSetting("reviewMode", "simulator");
  assert.equal(store.getSetting("reviewMode"), "simulator");

  store.applyEvent(requested("Old", "1"), meta("s1", 1_000));
  store.applyEvent(requested("Recent", "2"), meta("s2", 2_000));
  for (const r of ["Old", "Recent"]) store.markTrigger(r, true);
  assert.equal(store.pendingTriggers().length, 0);
  assert.equal(store.requeuePendingSince(1_500), 1);
  assert.deepEqual(store.pendingTriggers().map((r) => r.review), ["Recent"]);
});

test("mode switch delegates to the current path and persists a switch", async () => {
  const store = openStore(":memory:");
  const calls: string[] = [];
  const lines: string[] = [];
  const sw = new ModeSwitch({ paths: { live: path("live", calls), simulator: path("sim", calls) }, store, now: () => 10_000, requeueWindowSecs: 900, log: (l) => lines.push(l) });
  assert.equal(sw.mode, "live", "live is the default when available");
  assert.deepEqual(sw.available, ["live", "simulator"]);
  await sw.send({ review: "R1", multisig: "Ms1", txIndex: "1" });
  await sw.run({ multisig: "Ms1", txIndex: "1" });

  store.applyEvent(requested("Pending", "3"), meta("s3", 9_500));
  store.markTrigger("Pending", true); // skipped under the live path
  sw.set("simulator");
  assert.equal(sw.mode, "simulator");
  assert.equal(store.getSetting("reviewMode"), "simulator");
  assert.deepEqual(store.pendingTriggers().map((r) => r.review), ["Pending"], "the new path gets recent pending reviews");
  await sw.send({ review: "R2", multisig: "Ms1", txIndex: "2" });
  assert.deepEqual(calls, ["live:send:R1", "live:run:1", "sim:send:R2"]);
  assert.match(lines.join("\n"), /review path switched: live -> simulator/);

  // A restart keeps the switched mode.
  assert.equal(new ModeSwitch({ paths: { live: path("live", []), simulator: path("sim", []) }, store }).mode, "simulator");
});

test("mode switch refuses a path that is not configured on this runner", () => {
  const sw = new ModeSwitch({ paths: { simulator: path("sim", []) }, store: openStore(":memory:") });
  assert.equal(sw.mode, "simulator");
  assert.throws(() => sw.set("live"), /not configured/);
  assert.throws(() => sw.set("bogus" as never), /not configured/);
});

async function serve(adminToken: string | null) {
  const store = openStore(":memory:");
  const reviewMode = new ModeSwitch({ paths: { live: path("live", []), simulator: path("sim", []) }, store });
  const server = createStatusServer({
    programId: "Guard111",
    store,
    health: () => ({ ok: true, subscribed: true, lastBackfillAt: 1, lastBackfillError: null, lastLogAt: null, cursor: null }),
    reviewMode,
    adminToken,
    log: () => {},
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown, auth: string | null) =>
    fetch(`${base}/admin/mode`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify(body),
    });
  return { base, post, reviewMode, close: () => server.close() };
}

test("POST /admin/mode switches with the operator token and GET /status shows the path", async () => {
  const s = await serve("op");
  try {
    const before = (await (await fetch(`${s.base}/status`)).json()) as any;
    assert.deepEqual(before.reviewPath, { mode: "live", available: ["live", "simulator"], forwarder: "liveForwarder" });
    const res = await s.post({ mode: "simulator" }, "Bearer op");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { mode: "simulator", available: ["live", "simulator"], forwarder: "simForwarder" });
    assert.equal(s.reviewMode.mode, "simulator");
  } finally {
    s.close();
  }
});

test("POST /admin/mode is fail closed, authenticated and validated", async () => {
  const off = await serve(null);
  try {
    assert.equal((await off.post({ mode: "simulator" }, "Bearer x")).status, 503);
  } finally {
    off.close();
  }
  const s = await serve("op");
  try {
    assert.equal((await s.post({ mode: "simulator" }, null)).status, 401);
    assert.equal((await s.post({ mode: "simulator" }, "Bearer wrong")).status, 401);
    assert.equal((await s.post({ mode: "bogus" }, "Bearer op")).status, 400);
    assert.equal(s.reviewMode.mode, "live");
  } finally {
    s.close();
  }
});
