import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_KIND, REPORT_PAYLOAD_LEN, REPORT_VERSION, VERDICT, encodeReportPayload, decodeReportPayload, txHash,
  destinationHash, canonicalJson, policyHash,
  txIndexSeed, GuardErrorCode, ReviewReason, MAX_REASON, REPORT_METADATA_LEN, encodeReportMetadata,
  type ReportPayload,
} from "./index";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const filled = (n: number) => new Uint8Array(32).fill(n);

const spl = (): ReportPayload => ({
  verdict: VERDICT.APPROVE, reason: 0x0102, txHash: filled(1), policyHash: filled(2), actionKind: ACTION_KIND.SPL,
  destinationHash: filled(3), issuedAt: 0x0102030405060708n, expiresAt: 0x1112131415161718n,
});

test("payload v2 is 117 bytes and fits CRE's 265-byte Solana raw report (109 metadata + 32 account hash + 4 length)", () => {
  assert.equal(REPORT_PAYLOAD_LEN, 117);
  assert.ok(109 + 32 + 4 + REPORT_PAYLOAD_LEN <= 265);
});

test("payload v2 has fixed offsets", () => {
  const b = encodeReportPayload(spl());
  assert.equal(b.length, REPORT_PAYLOAD_LEN);
  assert.equal(b[0], REPORT_VERSION);
  assert.equal(REPORT_VERSION, 2);
  assert.equal(b[1], VERDICT.APPROVE);
  assert.deepEqual([...b.subarray(2, 4)], [0x02, 0x01]);
  assert.equal(b[4], 1); assert.equal(b[35], 1);
  assert.equal(b[36], 2); assert.equal(b[67], 2);
  assert.equal(b[68], ACTION_KIND.SPL);
  assert.equal(b[69], 3); assert.equal(b[100], 3);
  assert.deepEqual([...b.subarray(101, 109)], [8, 7, 6, 5, 4, 3, 2, 1]);
  assert.deepEqual([...b.subarray(109, 117)], [0x18, 0x17, 0x16, 0x15, 0x14, 0x13, 0x12, 0x11]);
});

test("payload round-trips", () => {
  const p = { ...spl(), verdict: VERDICT.REJECT, reason: 8 } as const;
  const back = decodeReportPayload(encodeReportPayload(p));
  assert.equal(back.verdict, 2); assert.equal(back.reason, 8); assert.equal(back.actionKind, ACTION_KIND.SPL);
  assert.equal(back.issuedAt, p.issuedAt); assert.equal(back.expiresAt, p.expiresAt);
  assert.equal(hex(back.txHash), hex(p.txHash));
  assert.equal(hex(back.destinationHash), hex(p.destinationHash));
});

test("decode rejects wrong length and unknown version", () => {
  assert.throws(() => decodeReportPayload(new Uint8Array(116)));
  assert.throws(() => decodeReportPayload(new Uint8Array(118)));
  const b = encodeReportPayload(spl());
  b[0] = 1;
  assert.throws(() => decodeReportPayload(b));
});

test("encode rejects fields of the wrong size", () => {
  assert.throws(() => encodeReportPayload({ ...spl(), destinationHash: new Uint8Array(31) }));
});

test("destinationHash binds kind, destination, owner wallet and mint (shared vector with Rust)", () => {
  assert.equal(hex(destinationHash(ACTION_KIND.SPL, filled(3), filled(4), filled(5))),
    "7c55facd8ebf19ba72048503dd3e5852e51992c9d921d14f19eb731a15a4fe27");
  // SOL: owner is the destination wallet, mint is zero.
  assert.equal(hex(destinationHash(ACTION_KIND.SOL, filled(7), filled(7), new Uint8Array(32))),
    "f19d30a01abfca20f15278b788f55568b87bd01ea9834782df2d5b5e84933deb");
  assert.notEqual(hex(destinationHash(ACTION_KIND.SPL, filled(3), filled(9), filled(5))),
    hex(destinationHash(ACTION_KIND.SPL, filled(3), filled(4), filled(5))));
  assert.throws(() => destinationHash(ACTION_KIND.SPL, filled(3), filled(4), new Uint8Array(31)));
});

const policy = { version: 1, salt: "00".repeat(16), b: "2", a: { z: [3, "x"], y: true } };

test("canonicalJson sorts keys at every level with no whitespace", () => {
  assert.equal(canonicalJson(policy), '{"a":{"y":true,"z":[3,"x"]},"b":"2","salt":"00000000000000000000000000000000","version":1}');
  assert.throws(() => canonicalJson({ amount: 1.5 }), /integer/);
  assert.throws(() => canonicalJson({ amount: 2 ** 60 }), /safe integer/);
  assert.throws(() => canonicalJson({ x: undefined }));
});

test("policyHash = sha256('wysiwys:policy:v1' || u32le(len) || decoder_version || sha256(canonical policy)), shared vector", () => {
  assert.equal(hex(policyHash(policy, "@wysiwys/decoder@0.1.0")),
    "5b4651c26ff8387663425539b809e1ea6cf4b1f74a4ea7275cf410e9b4adef9c");
  assert.notEqual(hex(policyHash(policy, "@wysiwys/decoder@0.1.1")), hex(policyHash(policy, "@wysiwys/decoder@0.1.0")));
  assert.notEqual(hex(policyHash({ ...policy, b: "3" }, "@wysiwys/decoder@0.1.0")), hex(policyHash(policy, "@wysiwys/decoder@0.1.0")));
});

test("policyHash requires a versioned policy with a random salt of at least 16 bytes", () => {
  assert.throws(() => policyHash({ version: 1 }, "d"), /salt/);
  assert.throws(() => policyHash({ version: 1, salt: "abcd" }, "d"), /salt/);
  assert.throws(() => policyHash({ salt: "00".repeat(16) }, "d"), /version/);
  assert.throws(() => policyHash(policy, ""), /decoder/);
});

test("txHash is sha256('wysiwys:tx:v1' || vault_transaction || data), shared vector with Rust", () => {
  const abc = new TextEncoder().encode("abc");
  assert.equal(hex(txHash(new Uint8Array(32), abc)), "e239731306bf53ae6cc15109d6a3ef161b7e97b4285c39cca41e4822c41b5954");
  assert.notEqual(hex(txHash(filled(1), abc)), hex(txHash(new Uint8Array(32), abc)));
  assert.throws(() => txHash(new Uint8Array(31), abc));
});

test("metadata is 64 bytes: workflow_cid 32 | workflow_name 10 | workflow_owner 20 | report_id 2", () => {
  const m = encodeReportMetadata({
    workflowCid: new Uint8Array(32).fill(1), workflowName: new Uint8Array(10).fill(2),
    workflowOwner: new Uint8Array(20).fill(3), reportId: new Uint8Array([4, 5]),
  });
  assert.equal(m.length, REPORT_METADATA_LEN);
  assert.equal(m[31], 1); assert.equal(m[32], 2); assert.equal(m[41], 2);
  assert.equal(m[42], 3); assert.equal(m[61], 3); assert.deepEqual([...m.subarray(62)], [4, 5]);
});

test("txIndexSeed is u64 little-endian", () => {
  assert.deepEqual([...txIndexSeed(258n)], [2, 1, 0, 0, 0, 0, 0, 0]);
});

test("error codes follow the Rust enum order", () => {
  assert.equal(GuardErrorCode.NotSquadsAccount, 6000);
  assert.equal(GuardErrorCode.PolicyMismatch, 6013);
  assert.equal(GuardErrorCode.InvalidForwarder, 6014);
  assert.equal(GuardErrorCode.NotProposer, 6018);
  assert.equal(GuardErrorCode.DestinationChanged, 6019);
  assert.equal(GuardErrorCode.ReviewDeadlinePassed, 6020);
  assert.equal(GuardErrorCode.InvalidConfig, 6021);
  assert.equal("IntentMismatch" in GuardErrorCode, false);
});

test("reason codes match AGENTS.md", () => {
  assert.equal(ReviewReason.WITHIN_POLICY, 0);
  assert.equal(ReviewReason.RPC_NO_QUORUM, 1);
  assert.equal(ReviewReason.AUTHORITY_CHANGE_BLOCKED, 6);
  assert.equal(ReviewReason.DESTINATION_NOT_WHITELISTED, 8);
  assert.equal(ReviewReason.POLICY_STALE, 13);
  assert.equal(MAX_REASON, 13);
});
