import { sha256 } from "@noble/hashes/sha256";

// CRE report payload consumed by the guard's on_report. Fixed 107 bytes, little-endian.
// Sized to fit CRE's 265-byte Solana raw report limit.
export const REPORT_PAYLOAD_LEN = 107;
export const VERDICT = { APPROVE: 1, REJECT: 2 } as const;

export interface ReportPayload {
  verdict: 1 | 2;
  reason: number;
  msgHash: Uint8Array;
  intentHash: Uint8Array;
  policyHash: Uint8Array;
  expiresAt: bigint;
}

export function intentHash(settlementIntentHash: Uint8Array, tradeRefHash: Uint8Array): Uint8Array {
  const joined = new Uint8Array(64);
  joined.set(settlementIntentHash, 0);
  joined.set(tradeRefHash, 32);
  return sha256(joined);
}

function check32(name: string, v: Uint8Array) {
  if (v.length !== 32) throw new Error(`${name} must be 32 bytes`);
}

export function encodeReportPayload(p: ReportPayload): Uint8Array {
  check32("msgHash", p.msgHash);
  check32("intentHash", p.intentHash);
  check32("policyHash", p.policyHash);
  const out = new Uint8Array(REPORT_PAYLOAD_LEN);
  const view = new DataView(out.buffer);
  view.setUint8(0, p.verdict);
  view.setUint16(1, p.reason, true);
  out.set(p.msgHash, 3);
  out.set(p.intentHash, 35);
  out.set(p.policyHash, 67);
  view.setBigInt64(99, p.expiresAt, true);
  return out;
}

export function decodeReportPayload(bytes: Uint8Array): ReportPayload {
  if (bytes.length !== REPORT_PAYLOAD_LEN) throw new Error(`payload must be ${REPORT_PAYLOAD_LEN} bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const verdict = view.getUint8(0);
  if (verdict !== 1 && verdict !== 2) throw new Error(`invalid verdict ${verdict}`);
  return {
    verdict,
    reason: view.getUint16(1, true),
    msgHash: bytes.slice(3, 35),
    intentHash: bytes.slice(35, 67),
    policyHash: bytes.slice(67, 99),
    expiresAt: view.getBigInt64(99, true),
  };
}
