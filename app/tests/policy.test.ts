import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { encodePolicyChangeMarker, parsePolicy } from "@wysiwys/shared";
import {
  POLICY_CHANGE_MIN_DELAY_SECONDS,
  buildPolicyChangeInstruction,
  diffPolicies,
  isPolicyChangeRecord,
  isPolicyMember,
  parsePolicyRequest,
  policyHashFromGuardConfig,
  policyProgress,
  readPolicyChange,
} from "../src/lib/squads/policy";

const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const key = () => Keypair.generate().publicKey.toBase58();
const mint = key();
const [a, b, c] = [key(), key(), key()];
// A typed Policy v1 document; a key set to undefined is left out (for example no screening).
const policy = (over: Record<string, unknown> = {}) => {
  const doc: Record<string, unknown> = {
    version: 1, salt: "ab".repeat(16), allowedPrograms: [SYSTEM, TOKEN],
    allowedInstructions: ["system:transfer", "spl-token:transferChecked"], allowedMints: [{ mint, decimals: 6 }],
    maxAmountPerPayment: "100000000000", destinationWhitelist: [a, c],
    screening: { provider: "scorechain", blockOn: ["SANCTIONED"] }, ...over,
  };
  for (const k of Object.keys(doc)) if (doc[k] === undefined) delete doc[k];
  return parsePolicy(doc);
};
const token = { mint, symbol: "mUSD", decimals: 6 };

test("diff names the version, whitelist, cap, mint, instruction and screening changes in plain words", () => {
  const lines = diffPolicies(
    policy(),
    policy({
      version: 2, destinationWhitelist: [a, b], maxAmountPerPayment: "200000000000",
      allowedInstructions: ["spl-token:transferChecked"], allowedPrograms: [TOKEN], screening: undefined,
    }),
    token,
  );
  assert.deepEqual(lines, [
    "Policy version 1 → 2",
    `Adds 1 address to the whitelist: ${b}`,
    `Removes 1 address from the whitelist: ${c}`,
    "Raises the per-payment cap from 100,000 to 200,000 mUSD",
    "Stops allowing SOL transfers",
    "Turns off sanctions screening",
  ]);
});

test("diff lowers caps, adds mints and turns screening on", () => {
  const other = key();
  const lines = diffPolicies(
    policy({ screening: undefined }),
    policy({ version: 3, maxAmountPerPayment: "5000000", allowedMints: [{ mint, decimals: 6 }, { mint: other, decimals: 9 }], screening: { provider: "scorechain", blockOn: ["SANCTIONED"] } }),
    token,
  );
  assert.deepEqual(lines, [
    "Policy version 1 → 3",
    // Two allowed tokens: the cap can only be stated in base units, so both units are shown.
    "Lowers the per-payment cap from 100,000 mUSD to 5,000,000 base units",
    `Allows token ${other} (9 decimals)`,
    "Turns on sanctions screening",
  ]);
});

test("without the current document the diff describes the proposed policy", () => {
  const lines = diffPolicies(null, policy({ version: 4 }), token);
  assert.deepEqual(lines, [
    "Policy version 4 (the current document is not on file, so this is the full proposed policy)",
    "Whitelist: 2 addresses",
    "Per-payment cap: 100,000 mUSD",
    `Allowed tokens: ${mint}`,
    "Allowed payments: SOL transfers, token transfers",
    "Sanctions screening: on",
  ]);
});

const guard = Keypair.generate().publicKey;
const hash = (n: number) => new Uint8Array(32).fill(n);

test("the marker instruction is one guard instruction with no accounts carrying new and expected hashes", () => {
  const ix = buildPolicyChangeInstruction(guard, hash(2), hash(1));
  assert.equal(ix.programId.toBase58(), guard.toBase58());
  assert.deepEqual(ix.keys, []);
  assert.deepEqual(Uint8Array.from(ix.data), encodePolicyChangeMarker({ newPolicyHash: hash(2), expectedPolicyHash: hash(1) }));
});

test("reads a policy change from a stored message only when it is exactly one marker to the guard", () => {
  const vault = Keypair.generate().publicKey;
  const data = Array.from(encodePolicyChangeMarker({ newPolicyHash: hash(2), expectedPolicyHash: hash(1) }));
  const message = (o: Partial<{ accountKeys: PublicKey[]; instructions: unknown[]; addressTableLookups: unknown[] }> = {}) => ({
    accountKeys: [vault, guard],
    instructions: [{ programIdIndex: 1, accountIndexes: [], data }],
    addressTableLookups: [],
    ...o,
  });
  const change = readPolicyChange(message() as never, guard);
  assert.equal(change?.newPolicyHash, "02".repeat(32));
  assert.equal(change?.expectedPolicyHash, "01".repeat(32));
  for (const bad of [
    message({ instructions: [{ programIdIndex: 1, accountIndexes: [], data }, { programIdIndex: 1, accountIndexes: [], data }] }),
    message({ accountKeys: [vault, Keypair.generate().publicKey] }),
    message({ instructions: [{ programIdIndex: 1, accountIndexes: [0], data }] }),
    message({ addressTableLookups: [{}] }),
    message({ instructions: [{ programIdIndex: 1, accountIndexes: [], data: data.slice(0, 71) }] }),
  ])
    assert.equal(readPolicyChange(bad as never, guard), null);
});

test("reads the current policy hash from GuardConfig account data", () => {
  const data = new Uint8Array(200);
  data.set(hash(7), 104);
  assert.equal(policyHashFromGuardConfig(data), "07".repeat(32));
  assert.equal(policyHashFromGuardConfig(new Uint8Array(100)), null);
});

test("only members who can propose or vote may read and propose policies", () => {
  const member = Keypair.generate().publicKey;
  const members = [
    { key: member, permissions: { mask: 3 } },
    { key: Keypair.generate().publicKey, permissions: { mask: 4 } }, // executor
  ];
  assert.equal(isPolicyMember(members, member.toBase58()), true);
  assert.equal(isPolicyMember(members, members[1]!.key.toBase58()), false);
  assert.equal(isPolicyMember(members, key()), false);
});

test("policy change progress: votes, waiting period, applied", () => {
  const base = { proposalStatus: "Active", approvals: 1, threshold: 3, approvedAt: null as number | null, timeLock: 0, applied: false, nowSeconds: 1_000 };
  const states = (o: Partial<typeof base> & Record<string, unknown>) =>
    policyProgress({ ...base, ...o }).map((s) => `${s.key}:${s.state}`);
  assert.deepEqual(states({}), ["proposed:done", "votes:active", "wait:waiting", "applied:waiting"]);

  const waiting = policyProgress({ ...base, proposalStatus: "Approved", approvals: 3, approvedAt: 900 });
  assert.deepEqual(waiting.map((s) => `${s.key}:${s.state}`), ["proposed:done", "votes:done", "wait:active", "applied:waiting"]);
  assert.match(waiting[2]!.detail, /^Waiting period ends at /);

  const ready = policyProgress({ ...base, proposalStatus: "Approved", approvals: 3, approvedAt: 1_000 - POLICY_CHANGE_MIN_DELAY_SECONDS });
  assert.deepEqual(ready.map((s) => `${s.key}:${s.state}`), ["proposed:done", "votes:done", "wait:done", "applied:active"]);
  assert.equal(ready[3]!.detail, "Ready to apply");

  // The Squads time lock counts when it is longer than the minimum delay.
  const locked = policyProgress({ ...base, proposalStatus: "Approved", approvals: 3, approvedAt: 0, timeLock: 5_000 });
  assert.equal(locked[2]!.state, "active");

  assert.deepEqual(states({ proposalStatus: "Cancelled" }), ["proposed:done", "votes:failed", "wait:failed", "applied:failed"]);
  assert.equal(policyProgress({ ...base, proposalStatus: "Cancelled" })[1]!.detail, "Cancelled");
  assert.deepEqual(states({ proposalStatus: "Approved", approvals: 3, approvedAt: 0, applied: true }), ["proposed:done", "votes:done", "wait:done", "applied:done"]);
});

test("policy requests: current, read and submit with strict fields", () => {
  const multisig = key();
  assert.deepEqual(parsePolicyRequest({ action: "current", multisig }), { action: "current", multisig });
  // A proposal read names the proposal; the server reads its marker on chain for the hashes.
  assert.deepEqual(parsePolicyRequest({ action: "read", multisig, index: "7" }), { action: "read", multisig, index: "7" });
  const document = policy();
  assert.deepEqual(parsePolicyRequest({ action: "submit", multisig, document }), { action: "submit", multisig, document });
  for (const bad of [
    null, { action: "delete", multisig }, { action: "current", multisig: "nope" }, { action: "read", multisig, hash: "xyz" },
    { action: "submit", multisig }, { action: "current", multisig, extra: 1 },
    { action: "read", multisig, hash: "ab".repeat(32) }, { action: "read", multisig, index: "0" }, { action: "read", multisig, index: "x" },
  ])
    assert.throws(() => parsePolicyRequest(bad));
});

test("the policy route refuses unsigned requests", async () => {
  const { POST } = await import("../src/app/api/policy/route");
  const origin = "http://127.0.0.1:3000";
  const res = await POST(new Request(`${origin}/api/policy`, {
    method: "POST",
    headers: { origin, host: "127.0.0.1:3000", "content-type": "application/json" },
    body: JSON.stringify({ action: "current", multisig: key() }),
  }));
  assert.equal(res.status, 401);
});

test("a vault record is a policy change only when its message is the guard marker", () => {
  const vault = Keypair.generate().publicKey;
  const data = Array.from(encodePolicyChangeMarker({ newPolicyHash: hash(2), expectedPolicyHash: hash(1) }));
  const record = (programIdIndex: number, kind = "vault") => ({
    kind,
    transaction: { message: { accountKeys: [vault, guard], instructions: [{ programIdIndex, accountIndexes: [], data }], addressTableLookups: [] } },
  });
  assert.equal(isPolicyChangeRecord(record(1) as never, guard.toBase58()), true);
  assert.equal(isPolicyChangeRecord(record(0) as never, guard.toBase58()), false);
  assert.equal(isPolicyChangeRecord(record(1) as never, undefined), false);
  assert.equal(isPolicyChangeRecord({ kind: "config" } as never, guard.toBase58()), false);
});
