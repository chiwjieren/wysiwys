import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createStatusServer } from "../src/server";
import { loadConfig } from "../src/config";
import { openStore } from "../src/store";

async function serve(ok: boolean) {
  const store = openStore(":memory:");
  store.applyEvent(
    { name: "ReviewRequested", review: "Rev1", multisig: "Ms1", txIndex: "7", txHash: "ab".repeat(32) },
    { signature: "s1", idx: 0, slot: 1, blockTime: 100 },
  );
  const server = createStatusServer({
    programId: "Guard111",
    store,
    health: () => ({ ok, subscribed: ok, lastBackfillAt: 1, lastBackfillError: null, lastLogAt: null, cursor: "s1" }),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => server.close() };
}

test("GET /status is 200 with health, program and counts when healthy", async () => {
  const { base, close } = await serve(true);
  try {
    const res = await fetch(`${base}/status`);
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.programId, "Guard111");
    assert.deepEqual(body.reviews, { pending: 1 });
    assert.equal(body.listener.cursor, "s1");
  } finally {
    close();
  }
});

test("GET /status is 503 when the listener is unhealthy (fail closed, visible)", async () => {
  const { base, close } = await serve(false);
  try {
    const res = await fetch(`${base}/status`);
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as any).ok, false);
  } finally {
    close();
  }
});

test("GET /reviews returns review history, newest first, with a capped limit", async () => {
  const { base, close } = await serve(true);
  try {
    const res = await fetch(`${base}/reviews?limit=5000`);
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.reviews[0].review, "Rev1");
    assert.equal(body.reviews[0].status, "pending");
  } finally {
    close();
  }
});

test("unknown routes are 404", async () => {
  const { base, close } = await serve(true);
  try {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally {
    close();
  }
});

test("config takes the program id from deployments/devnet.json when present", () => {
  const cfg = loadConfig({}, (p) => (p.endsWith("devnet.json") ? JSON.stringify({ programId: "FromDeployments111" }) : null));
  assert.equal(cfg.programId, "FromDeployments111");
});

test("config falls back to the shared IDL address and public devnet RPC", () => {
  const cfg = loadConfig({}, () => null);
  assert.equal(cfg.programId, "9wCcjb74o2cWcFx8GimQQMcR1nJay9X86v1JiyV9kwya");
  assert.equal(cfg.rpcUrl, "https://api.devnet.solana.com");
  assert.equal(cfg.port, 8787);
  assert.equal(cfg.triggerUrl, null);
});

test("config reads RPC, port, DB path and trigger settings from env", () => {
  const cfg = loadConfig(
    {
      HELIUS_DEVNET_RPC_URL: "https://rpc.example/?api-key=x",
      PORT: "9000",
      RUNNER_DB_PATH: "/tmp/r.db",
      CRE_TRIGGER_URL: "https://cre.example/trigger",
      CRE_TRIGGER_TOKEN: "tok",
    },
    () => null,
  );
  assert.equal(cfg.rpcUrl, "https://rpc.example/?api-key=x");
  assert.equal(cfg.port, 9000);
  assert.equal(cfg.dbPath, "/tmp/r.db");
  assert.equal(cfg.triggerUrl, "https://cre.example/trigger");
  assert.equal(cfg.triggerToken, "tok");
});
