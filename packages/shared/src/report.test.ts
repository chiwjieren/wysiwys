import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_KIND, REPORT_PAYLOAD_LEN, REPORT_VERSION, VERDICT, encodeReportPayload, decodeReportPayload, txHash,
  txIndexSeed, GuardErrorCode, ReviewReason, MAX_REASON, REPORT_METADATA_LEN, encodeReportMetadata,
  type ReportPayload,
} from "./index";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const filled = (n: number) => new Uint8Array(32).fill(n);

const spl = (): ReportPayload => ({
  verdict: VERDICT.APPROVE, reason: 0x0102, txHash: filled(1), policyHash: filled(2), actionKind: ACTION_KIND.SPL,
  destination: filled(3), destinationOwner: filled(4), mint: filled(5),
  issuedAt: 0x0102030405060708n, expiresAt: 0x1112131415161718n,
});

test("payload is 181 bytes and fits the 265-byte CRE report with 64 bytes of metadata", () => {
  assert.equal(REPORT_PAYLOAD_LEN, 181);
  assert.ok(REPORT_PAYLOAD_LEN + REPORT_METADATA_LEN <= 265);
});

test("payload v1 has fixed offsets", () => {
  const b = encodeReportPayload(spl());
  assert.equal(b.length, REPORT_PAYLOAD_LEN);
  assert.equal(b[0], REPORT_VERSION);
  assert.equal(b[1], VERDICT.APPROVE);
  assert.deepEqual([...b.subarray(2, 4)], [0x02, 0x01]);
  assert.equal(b[4], 1); assert.equal(b[35], 1);
  assert.equal(b[36], 2); assert.equal(b[67], 2);
  assert.equal(b[68], ACTION_KIND.SPL);
  assert.equal(b[69], 3); assert.equal(b[100], 3);
  assert.equal(b[101], 4); assert.equal(b[132], 4);
  assert.equal(b[133], 5); assert.equal(b[164], 5);
  assert.deepEqual([...b.subarray(165, 173)], [8, 7, 6, 5, 4, 3, 2, 1]);
  assert.deepEqual([...b.subarray(173, 181)], [0x18, 0x17, 0x16, 0x15, 0x14, 0x13, 0x12, 0x11]);
});

test("payload round-trips", () => {
  const p = { ...spl(), verdict: VERDICT.REJECT, reason: 8 } as const;
  const back = decodeReportPayload(encodeReportPayload(p));
  assert.equal(back.verdict, 2); assert.equal(back.reason, 8); assert.equal(back.actionKind, ACTION_KIND.SPL);
  assert.equal(back.issuedAt, p.issuedAt); assert.equal(back.expiresAt, p.expiresAt);
  assert.equal(hex(back.txHash), hex(p.txHash));
  assert.equal(hex(back.destinationOwner), hex(p.destinationOwner));
  assert.equal(hex(back.mint), hex(p.mint));
});

test("decode rejects wrong length and unknown version", () => {
  assert.throws(() => decodeReportPayload(new Uint8Array(180)));
  assert.throws(() => decodeReportPayload(new Uint8Array(182)));
  const b = encodeReportPayload(spl());
  b[0] = 2;
  assert.throws(() => decodeReportPayload(b));
});

test("encode rejects fields of the wrong size", () => {
  assert.throws(() => encodeReportPayload({ ...spl(), mint: new Uint8Array(31) }));
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
