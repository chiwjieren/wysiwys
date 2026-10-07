import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  sanitizeRunnerStatus,
  sanitizeRunnerReviews,
  fetchRunner,
  reviewsMultisig,
  parseModeSwitch,
  switchRunnerMode,
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

test("runner status exposes the review path mode, never the forwarder or junk modes", () => {
  const base = { ok: true, listener: {}, reviews: {} };
  assert.deepEqual(
    sanitizeRunnerStatus({ ...base, reviewPath: { mode: "live", available: ["live", "simulator", "evil"], forwarder: "CXs" } }).reviewPath,
    { mode: "live", available: ["live", "simulator"] },
  );
  assert.equal(sanitizeRunnerStatus({ ...base, reviewPath: { mode: "evil", available: ["live"] } }).reviewPath, undefined);
  assert.equal(sanitizeRunnerStatus(base).reviewPath, undefined);
});

test("a review path switch needs a known mode and an operator token", () => {
  assert.deepEqual(parseModeSwitch({ mode: "simulator", token: "op" }), { mode: "simulator", token: "op" });
  for (const body of [{ mode: "evil", token: "op" }, { mode: "live", token: "" }, { mode: "live" }, { mode: "live", token: "x".repeat(513) }, null, "live"])
    assert.equal(parseModeSwitch(body), null);
});

async function withRunner(status: number, body: unknown, fn: (seen: { auth?: string; path?: string; body?: string }) => Promise<void>) {
  const seen: { auth?: string; path?: string; body?: string } = {};
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      Object.assign(seen, { auth: req.headers.authorization, path: req.url, body: text });
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const previous = process.env.WYSIWYS_SETTLEMENT_URL;
  process.env.WYSIWYS_SETTLEMENT_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(seen);
  } finally {
    server.close();
    if (previous === undefined) delete process.env.WYSIWYS_SETTLEMENT_URL;
    else process.env.WYSIWYS_SETTLEMENT_URL = previous;
  }
}

test("switching forwards the operator token to the runner and returns only the sanitized path", async () => {
  await withRunner(200, { mode: "simulator", available: ["live", "simulator"], forwarder: "7kuE" }, async (seen) => {
    assert.deepEqual(await switchRunnerMode({ mode: "simulator", token: "op" }), {
      status: 200,
      body: { reviewPath: { mode: "simulator", available: ["live", "simulator"] } },
    });
    assert.equal(seen.auth, "Bearer op");
    assert.equal(seen.path, "/admin/mode");
    assert.deepEqual(JSON.parse(seen.body!), { mode: "simulator" });
  });
});

test("switch failures map to fixed messages and never echo the runner", async () => {
  const cases: Array<[number, string]> = [
    [401, "Operator token rejected."],
    [400, "This runner cannot serve that review path."],
    [503, "Review path switching is not enabled on the runner."],
    [500, "Runner could not switch the review path."],
  ];
  for (const [status, message] of cases) {
    await withRunner(status, { error: "internal https://key@rpc.example" }, async () => {
      assert.deepEqual(await switchRunnerMode({ mode: "live", token: "op" }), { status: status === 500 ? 502 : status, body: { error: message } });
    });
  }
  const previous = process.env.WYSIWYS_SETTLEMENT_URL;
  process.env.WYSIWYS_SETTLEMENT_URL = "http://127.0.0.1:1";
  try {
    assert.deepEqual(await switchRunnerMode({ mode: "live", token: "op" }), { status: 502, body: { error: "Runner is unreachable." } });
  } finally {
    if (previous === undefined) delete process.env.WYSIWYS_SETTLEMENT_URL;
    else process.env.WYSIWYS_SETTLEMENT_URL = previous;
  }
});
