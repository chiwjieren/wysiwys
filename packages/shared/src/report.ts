import { sha256 } from "@noble/hashes/sha256";

// CRE report payload v2 consumed by the guard's on_report. Fixed 117 bytes, little-endian.
// CRE caps the Solana raw report at 265 bytes: 109 bytes forwarder metadata + 32 account hash
// + 4 length prefix + payload, so the payload must stay <= 120 bytes.
export const REPORT_PAYLOAD_LEN = 117;
export const REPORT_VERSION = 2;
export const VERDICT = { APPROVE: 1, REJECT: 2 } as const;
/** Reviewed payment kind. NONE is only valid on a reject verdict. */
export const ACTION_KIND = { NONE: 0, SOL: 1, SPL: 2 } as const;

export interface ReportPayload {
  verdict: 1 | 2;
  reason: number;
  txHash: Uint8Array;
  /** policyHash(): commitment over the policy document and the decoder version. */
  policyHash: Uint8Array;
  actionKind: 0 | 1 | 2;
  /** destinationHash() of the reviewed destination; 32 zero bytes when actionKind is NONE. */
  destinationHash: Uint8Array;
  issuedAt: bigint;
  expiresAt: bigint;
}

const DEST_HASH_DOMAIN = new TextEncoder().encode("wysiwys:dest:v1");

/**
 * sha256("wysiwys:dest:v1" || kind || destination || owner || mint). Same as destination_hash in the guard.
 * SOL: destination = owner = recipient wallet, mint = 32 zero bytes.
 * SPL: destination = token account, owner = its owner wallet, mint = its mint.
 */
export function destinationHash(kind: number, destination: Uint8Array, owner: Uint8Array, mint: Uint8Array): Uint8Array {
  check32("destination", destination);
  check32("owner", owner);
  check32("mint", mint);
  const joined = new Uint8Array(DEST_HASH_DOMAIN.length + 1 + 96);
  joined.set(DEST_HASH_DOMAIN, 0);
  joined[DEST_HASH_DOMAIN.length] = kind;
  joined.set(destination, DEST_HASH_DOMAIN.length + 1);
  joined.set(owner, DEST_HASH_DOMAIN.length + 33);
  joined.set(mint, DEST_HASH_DOMAIN.length + 65);
  return sha256(joined);
}

const TX_HASH_DOMAIN = new TextEncoder().encode("wysiwys:tx:v1");

/** sha256("wysiwys:tx:v1" || vault_transaction || VaultTransaction account data). Same as tx_hash in the guard. */
export function txHash(vaultTransaction: Uint8Array, data: Uint8Array): Uint8Array {
  check32("vaultTransaction", vaultTransaction);
  const joined = new Uint8Array(TX_HASH_DOMAIN.length + 32 + data.length);
  joined.set(TX_HASH_DOMAIN, 0);
  joined.set(vaultTransaction, TX_HASH_DOMAIN.length);
  joined.set(data, TX_HASH_DOMAIN.length + 32);
  return sha256(joined);
}

// Keystone metadata the forwarder passes to on_report. The guard checks workflowOwner.
export const REPORT_METADATA_LEN = 64;

export interface ReportMetadata {
  workflowCid: Uint8Array; // 32
  workflowName: Uint8Array; // 10
  workflowOwner: Uint8Array; // 20
  reportId: Uint8Array; // 2
}

export function encodeReportMetadata(m: ReportMetadata): Uint8Array {
  const parts: [Uint8Array, number, string][] = [
    [m.workflowCid, 32, "workflowCid"], [m.workflowName, 10, "workflowName"],
    [m.workflowOwner, 20, "workflowOwner"], [m.reportId, 2, "reportId"],
  ];
  const out = new Uint8Array(REPORT_METADATA_LEN);
  let off = 0;
  for (const [bytes, len, name] of parts) {
    if (bytes.length !== len) throw new Error(`${name} must be ${len} bytes`);
    out.set(bytes, off);
    off += len;
  }
  return out;
}

function check32(name: string, v: Uint8Array) {
  if (v.length !== 32) throw new Error(`${name} must be 32 bytes`);
}

export function encodeReportPayload(p: ReportPayload): Uint8Array {
  check32("txHash", p.txHash);
  check32("policyHash", p.policyHash);
  check32("destinationHash", p.destinationHash);
  const out = new Uint8Array(REPORT_PAYLOAD_LEN);
  const view = new DataView(out.buffer);
  view.setUint8(0, REPORT_VERSION);
  view.setUint8(1, p.verdict);
  view.setUint16(2, p.reason, true);
  out.set(p.txHash, 4);
  out.set(p.policyHash, 36);
  view.setUint8(68, p.actionKind);
  out.set(p.destinationHash, 69);
  view.setBigInt64(101, p.issuedAt, true);
  view.setBigInt64(109, p.expiresAt, true);
  return out;
}

export function decodeReportPayload(bytes: Uint8Array): ReportPayload {
  if (bytes.length !== REPORT_PAYLOAD_LEN) throw new Error(`payload must be ${REPORT_PAYLOAD_LEN} bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== REPORT_VERSION) throw new Error(`unsupported payload version ${view.getUint8(0)}`);
  const verdict = view.getUint8(1);
  if (verdict !== 1 && verdict !== 2) throw new Error(`invalid verdict ${verdict}`);
  const actionKind = view.getUint8(68);
  if (actionKind > 2) throw new Error(`invalid action kind ${actionKind}`);
  return {
    verdict,
    reason: view.getUint16(2, true),
    txHash: bytes.slice(4, 36),
    policyHash: bytes.slice(36, 68),
    actionKind: actionKind as 0 | 1 | 2,
    destinationHash: bytes.slice(69, 101),
    issuedAt: view.getBigInt64(101, true),
    expiresAt: view.getBigInt64(109, true),
  };
}
