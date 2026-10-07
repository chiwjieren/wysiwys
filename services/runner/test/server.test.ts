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

test("config takes guard values and token from deployments/devnet.json for new treasuries", () => {
  const dep = { programId: "P1", guard: { forwarderProgram: "F", forwarderState: "S", policyHash: "ab", workflowOwner: "cd", maxReviewLifetime: "3600", reviewDeadlineSecs: "900" }, token: { name: "Mock USD", symbol: "mUSD", decimals: 6, uri: "" }, mint: "M" };
  const cfg = loadConfig({}, (p) => (p.endsWith("devnet.json") ? JSON.stringify(dep) : null));
  assert.deepEqual(cfg.guardSetup, dep.guard);
  assert.deepEqual(cfg.token, { mint: "M", symbol: "mUSD", decimals: 6 });
  assert.equal(loadConfig({}, () => null).guardSetup, null);
});

test("config enables the CRE gateway trigger only with a workflow id and a signing key", () => {
  const key = `0x${"11".repeat(32)}`;
  const id = "ab".repeat(32);
  assert.equal(loadConfig({}, () => null).gateway, null);
  assert.equal(loadConfig({ CRE_WORKFLOW_ID: id }, () => null).gateway, null);
  assert.deepEqual(loadConfig({ CRE_WORKFLOW_ID: id, CRE_GATEWAY_PRIVATE_KEY: key }, () => null).gateway, {
    url: "https://01.gateway.zone-a.cre.chain.link",
    workflowId: id,
    privateKey: key,
  });
  assert.equal(
    loadConfig({ CRE_WORKFLOW_ID: id, CRE_GATEWAY_PRIVATE_KEY: key, CRE_GATEWAY_URL: "https://gw.example" }, () => null).gateway?.url,
    "https://gw.example",
  );
});

test("config reads both review paths' forwarders from deployments/devnet.json", () => {
  const forwarders = { simulator: { program: "SimF", state: "SimS" }, live: { program: "LiveF", state: "LiveS" } };
  const cfg = loadConfig({}, (p) => (p.endsWith("devnet.json") ? JSON.stringify({ programId: "P1", forwarders }) : null));
  assert.deepEqual(cfg.forwarders, forwarders);
  assert.equal(loadConfig({}, () => null).forwarders, null);
});

test("config falls back to the shared IDL address and public devnet RPC", () => {
  const cfg = loadConfig({}, () => null);
  assert.equal(cfg.programId, "9wCcjb74o2cWcFx8GimQQMcR1nJay9X86v1JiyV9kwya");
  assert.equal(cfg.rpcUrl, "https://api.devnet.solana.com");
  assert.equal(cfg.port, 8787);
  assert.equal(cfg.triggerUrl, null);
  assert.equal(cfg.wsUrl, null);
});

test("config uses HELIUS_DEVNET_WS_URL for the WebSocket when set", () => {
  const cfg = loadConfig({ HELIUS_DEVNET_WS_URL: "wss://ws.example/?api-key=x" }, () => null);
  assert.equal(cfg.wsUrl, "wss://ws.example/?api-key=x");
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

test("config reads the settlement token; empty means unset (routes fail closed)", () => {
  assert.equal(loadConfig({ SETTLEMENT_TOKEN: "s3cr3t" }, () => null).settlementToken, "s3cr3t");
  assert.equal(loadConfig({ SETTLEMENT_TOKEN: "" }, () => null).settlementToken, null);
});

// ---------------------------------------------------------------- settlement routes

import { SettlementError, type Settlement } from "../src/settlement";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";

const ix = new TransactionInstruction({
  programId: new PublicKey("9wCcjb74o2cWcFx8GimQQMcR1nJay9X86v1JiyV9kwya"),
  keys: [{ pubkey: PublicKey.default, isSigner: false, isWritable: true }],
  data: Buffer.from([1, 2, 3]),
});

function fakeSettlement(calls: string[]): Settlement {
  return {
    requestReview: async (input: any) => (calls.push(`propose:${input.txIndex}`), ix),
    guardedExecute: async (input: any) => {
      calls.push(`execute:${input.txIndex}`);
      if (input.txIndex === "9") throw new SettlementError(409, "review is not approved");
      if (input.txIndex === "8") throw new Error("rpc exploded with https://secret.example/?api-key=x");
      return ix;
    },
    destinationOf: async () => ({ kind: "spl", destination: "x" }),
    guardedConfigExecute: async (input: any) => (calls.push(`config:${input.txIndex}`), ix),
    prepareGuardedGroup: async (input: any) => {
      calls.push(`prepareGroup:${input.multisig}`);
      if (input.multisig === "Exists") throw new SettlementError(409, "guard config already exists for this multisig");
      return { multisig: input.multisig, programId: "P", executorPda: "E", vaultIndex: 0, guardReady: false as const, instruction: ix };
    },
    guardedGroup: async (ms: string) =>
      ms === "Guarded1111111111111111111111111111111111111"
        ? { multisig: ms, programId: "P", executorPda: "E", vaultIndex: 0, guardReady: true as const }
        : null,
  };
}

async function serveSettlement(token: string | null, rateLimitPerMinute = 100) {
  const calls: string[] = [];
  const store = openStore(":memory:");
  const server = createStatusServer({
    programId: "Guard111",
    store,
    health: () => ({ ok: true, subscribed: true, lastBackfillAt: 1, lastBackfillError: null, lastLogAt: null, cursor: null }),
    settlement: fakeSettlement(calls),
    settlementToken: token,
    rateLimitPerMinute,
    log: () => {},
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, auth: string | null = `Bearer ${token}`) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { base, post, calls, close: () => server.close() };
}

const ids = { multisig: "Ms1", txIndex: "3", member: "Mem1" };

test("settlement routes fail closed (503) when no token is configured", async () => {
  const s = await serveSettlement(null);
  try {
    assert.equal((await s.post("/frontend/propose", ids, "Bearer anything")).status, 503);
    assert.deepEqual(s.calls, []);
  } finally {
    s.close();
  }
});

test("settlement routes reject a missing or wrong bearer token (401)", async () => {
  const s = await serveSettlement("tok");
  try {
    assert.equal((await s.post("/frontend/propose", ids, null)).status, 401);
    assert.equal((await s.post("/frontend/propose", ids, "Bearer nope")).status, 401);
    assert.equal((await fetch(`${s.base}/frontend/groups/Guarded1111111111111111111111111111111111111`)).status, 401);
    assert.deepEqual(s.calls, []);
  } finally {
    s.close();
  }
});

test("POST /frontend/propose returns the request_review instruction in wire format", async () => {
  const s = await serveSettlement("tok");
  try {
    const res = await s.post("/frontend/propose", ids);
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.guardInstruction.programId, "9wCcjb74o2cWcFx8GimQQMcR1nJay9X86v1JiyV9kwya");
    assert.equal(body.guardInstruction.data, Buffer.from([1, 2, 3]).toString("base64"));
    assert.deepEqual(body.guardInstruction.keys, [{ pubkey: PublicKey.default.toBase58(), isSigner: false, isWritable: true }]);
    assert.deepEqual(s.calls, ["propose:3"]);
  } finally {
    s.close();
  }
});

test("POST /frontend/execute maps settlement errors to their status and hides internal errors", async () => {
  const s = await serveSettlement("tok");
  try {
    assert.equal((await s.post("/frontend/execute", ids)).status, 200);
    const notReady = await s.post("/frontend/execute", { ...ids, txIndex: "9" });
    assert.equal(notReady.status, 409);
    assert.equal(((await notReady.json()) as any).error, "review is not approved");
    const boom = await s.post("/frontend/execute", { ...ids, txIndex: "8" });
    assert.equal(boom.status, 502);
    assert.doesNotMatch(await boom.text(), /api-key|secret/);
  } finally {
    s.close();
  }
});

test("POST /frontend/config-execute returns the guarded_config_execute instruction", async () => {
  const s = await serveSettlement("tok");
  try {
    const res = await s.post("/frontend/config-execute", ids);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).guardInstruction.programId, "9wCcjb74o2cWcFx8GimQQMcR1nJay9X86v1JiyV9kwya");
    assert.deepEqual(s.calls, ["config:3"]);
  } finally {
    s.close();
  }
});

test("settlement routes reject bad JSON and oversized bodies", async () => {
  const s = await serveSettlement("tok");
  try {
    assert.equal((await s.post("/frontend/propose", "{not json")).status, 400);
    assert.equal((await s.post("/frontend/propose", { ...ids, pad: "x".repeat(3000) })).status, 413);
  } finally {
    s.close();
  }
});

test("GET /frontend/groups/:multisig returns guarded groups, 404 otherwise; POST prepare returns initialize_guard", async () => {
  const s = await serveSettlement("tok");
  try {
    const auth = { authorization: "Bearer tok" };
    const ok = await fetch(`${s.base}/frontend/groups/Guarded1111111111111111111111111111111111111`, { headers: auth });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as any).executorPda, "E");
    assert.equal((await fetch(`${s.base}/frontend/groups/Other`, { headers: auth })).status, 404);
    const prep = await s.post("/frontend/groups/prepare", { multisig: "New1", creator: "C", createKey: "K" });
    assert.equal(prep.status, 200);
    const body: any = await prep.json();
    assert.equal(body.executorPda, "E");
    assert.equal(body.guardReady, false);
    assert.equal(body.guardInstruction.programId, "9wCcjb74o2cWcFx8GimQQMcR1nJay9X86v1JiyV9kwya");
    assert.equal(body.instruction, undefined);
    assert.equal((await s.post("/frontend/groups/prepare", { multisig: "Exists", creator: "C", createKey: "K" })).status, 409);
  } finally {
    s.close();
  }
});

test("settlement routes are rate limited per client", async () => {
  const s = await serveSettlement("tok", 2);
  try {
    assert.equal((await s.post("/frontend/propose", ids)).status, 200);
    assert.equal((await s.post("/frontend/propose", ids)).status, 200);
    assert.equal((await s.post("/frontend/propose", ids)).status, 429);
  } finally {
    s.close();
  }
});

// ---------------------------------------------------------------- POST /review

async function serveReview(token: string | null) {
  const runs: unknown[] = [];
  const server = createStatusServer({
    programId: "Guard111",
    store: openStore(":memory:"),
    health: () => ({ ok: true, subscribed: true, lastBackfillAt: 1, lastBackfillError: null, lastLogAt: null, cursor: null }),
    review: {
      run: async (r: any) => {
        runs.push(r);
        if (r.txIndex === "x") throw new Error("invalid review identifiers");
        return { ok: r.txIndex !== "13", exitCode: r.txIndex === "13" ? 1 : 0, timedOut: false, durationMs: 5, log: ["[USER LOG] ok"] };
      },
    },
    reviewToken: token,
    log: () => {},
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown, auth: string | null = `Bearer ${token}`) =>
    fetch(`${base}/review`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify(body),
    });
  return { post, runs, close: () => server.close() };
}

test("POST /review runs the simulation and returns its sanitized result", async () => {
  const s = await serveReview("rt");
  try {
    const res = await s.post({ multisig: "Ms1", txIndex: "7", extra: "ignored" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, exitCode: 0, timedOut: false, durationMs: 5, log: ["[USER LOG] ok"] });
    assert.deepEqual(s.runs, [{ multisig: "Ms1", txIndex: "7" }]);
    const failed = await s.post({ multisig: "Ms1", txIndex: "13" });
    assert.equal(failed.status, 502);
    assert.equal(((await failed.json()) as any).ok, false);
  } finally {
    s.close();
  }
});

test("POST /review is fail closed and authenticated", async () => {
  const none = await serveReview(null);
  try {
    assert.equal((await none.post({ multisig: "Ms1", txIndex: "7" }, "Bearer x")).status, 503);
  } finally {
    none.close();
  }
  const s = await serveReview("rt");
  try {
    assert.equal((await s.post({ multisig: "Ms1", txIndex: "7" }, null)).status, 401);
    assert.equal((await s.post({ multisig: "Ms1", txIndex: "x" })).status, 400);
    assert.equal(s.runs.length, 1);
  } finally {
    s.close();
  }
});

test("config reads the CRE runner settings", () => {
  const off = loadConfig({}, () => null);
  assert.equal(off.cre, null);
  const cfg = loadConfig(
    { CRE_PROJECT_DIR: "/w/cre", CRE_WORKFLOW: "review", CRE_TARGET: "staging-settings", CRE_BROADCAST: "false", REVIEW_TOKEN: "rt" },
    () => null,
  );
  assert.deepEqual(cfg.cre, { command: ["cre"], projectDir: "/w/cre", workflow: "review", target: "staging-settings", broadcast: false, timeoutMs: 300000 });
  assert.equal(cfg.reviewToken, "rt");
  assert.equal(loadConfig({ CRE_PROJECT_DIR: "/w/cre" }, () => null).cre!.broadcast, true);
});
