import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REPORT_PAYLOAD_LEN, VERDICT, encodeReportPayload, decodeReportPayload, intentHash,
  txIndexSeed, GuardErrorCode, ReviewReason, MAX_REASON,
} from "./index";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const filled = (n: number) => new Uint8Array(32).fill(n);

test("payload is 107 bytes with fixed offsets", () => {
  const bytes = encodeReportPayload({
    verdict: VERDICT.APPROVE, reason: 0x0102, msgHash: filled(1), intentHash: filled(2),
    policyHash: filled(3), expiresAt: 0x0102030405060708n,
  });
  assert.equal(bytes.length, REPORT_PAYLOAD_LEN);
  assert.equal(bytes[0], 1);
  assert.deepEqual([...bytes.subarray(1, 3)], [0x02, 0x01]);
  assert.equal(bytes[3], 1); assert.equal(bytes[34], 1);
  assert.equal(bytes[35], 2); assert.equal(bytes[66], 2);
  assert.equal(bytes[67], 3); assert.equal(bytes[98], 3);
  assert.deepEqual([...bytes.subarray(99, 107)], [8, 7, 6, 5, 4, 3, 2, 1]);
});

test("payload round-trips", () => {
  const p = { verdict: VERDICT.REJECT, reason: 12, msgHash: filled(9), intentHash: filled(8), policyHash: filled(7), expiresAt: 1_800_000_000n } as const;
  const back = decodeReportPayload(encodeReportPayload(p));
  assert.equal(back.verdict, 2); assert.equal(back.reason, 12); assert.equal(back.expiresAt, 1_800_000_000n);
  assert.equal(hex(back.msgHash), hex(p.msgHash));
});

test("decode rejects wrong length", () => {
  assert.throws(() => decodeReportPayload(new Uint8Array(106)));
  assert.throws(() => decodeReportPayload(new Uint8Array(108)));
});

test("intentHash is sha256(settlement_intent_hash || trade_ref_hash), shared vector with Rust", () => {
  assert.equal(hex(intentHash(new Uint8Array(32), new Uint8Array(32))),
    "f5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b");
  const a = Uint8Array.from({ length: 32 }, (_, i) => i);
  const b = Uint8Array.from({ length: 32 }, (_, i) => i + 32);
  assert.equal(hex(intentHash(a, b)), "fdeab9acf3710362bd2658cdc9a29e8f9c757fcf9811603a8c447cd1d9151108");
});

test("txIndexSeed is u64 little-endian", () => {
  assert.deepEqual([...txIndexSeed(258n)], [2, 1, 0, 0, 0, 0, 0, 0]);
});

test("error codes follow the Rust enum order", () => {
  assert.equal(GuardErrorCode.NotSquadsAccount, 6000);
  assert.equal(GuardErrorCode.InvalidForwarder, 6015);
  assert.equal(GuardErrorCode.InvalidMultisigConfig, 6016);
  assert.equal(GuardErrorCode.ExecutorInMessage, 6017);
});

test("reason codes match AGENTS.md", () => {
  assert.equal(ReviewReason.WITHIN_POLICY, 0);
  assert.equal(ReviewReason.COUNTERPARTY_LEG_NOT_RECEIVED, 9);
  assert.equal(ReviewReason.DESTINATION_MISMATCH, 12);
  assert.equal(ReviewReason.AUTHORITY_CHANGE_BLOCKED, 15);
  assert.equal(ReviewReason.POLICY_HASH_MISMATCH, MAX_REASON);
});
