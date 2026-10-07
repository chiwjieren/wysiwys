import { sha256 } from "@noble/hashes/sha256";
import { PublicKey } from "@solana/web3.js";
import { SEEDS, txIndexSeed } from "./guard";

// Marker instruction carried by a Squads vault transaction that proposes a policy change.
// Layout: Anchor discriminator || new_policy_hash [32] || expected_policy_hash [32] (72 bytes).
// Pure TypeScript (runs in CRE WASM).

/** First 8 bytes of sha256("global:policy_change_marker"). */
export const POLICY_CHANGE_MARKER_DISCRIMINATOR: Uint8Array = sha256(
  new TextEncoder().encode("global:policy_change_marker"),
).subarray(0, 8);

export const POLICY_CHANGE_MARKER_LEN = 72;

export interface PolicyChangeMarker {
  newPolicyHash: Uint8Array;
  expectedPolicyHash: Uint8Array;
}

const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

export function encodePolicyChangeMarker(m: PolicyChangeMarker): Uint8Array {
  if (m.newPolicyHash.length !== 32) throw new Error("newPolicyHash must be 32 bytes");
  if (m.expectedPolicyHash.length !== 32) throw new Error("expectedPolicyHash must be 32 bytes");
  if (bytesEqual(m.newPolicyHash, m.expectedPolicyHash)) throw new Error("newPolicyHash must differ from expectedPolicyHash");
  const out = new Uint8Array(POLICY_CHANGE_MARKER_LEN);
  out.set(POLICY_CHANGE_MARKER_DISCRIMINATOR, 0);
  out.set(m.newPolicyHash, 8);
  out.set(m.expectedPolicyHash, 40);
  return out;
}

/** null unless exactly 72 bytes, the discriminator matches and the two hashes differ. */
export function decodePolicyChangeMarker(data: Uint8Array): PolicyChangeMarker | null {
  if (data.length !== POLICY_CHANGE_MARKER_LEN) return null;
  if (!bytesEqual(data.subarray(0, 8), POLICY_CHANGE_MARKER_DISCRIMINATOR)) return null;
  const newPolicyHash = data.slice(8, 40);
  const expectedPolicyHash = data.slice(40, 72);
  if (bytesEqual(newPolicyHash, expectedPolicyHash)) return null;
  return { newPolicyHash, expectedPolicyHash };
}

/** PDA of the PolicyChange record: ["policy_change", multisig, tx_index u64 LE]. */
export function policyChangePda(guardProgram: PublicKey, multisig: PublicKey, txIndex: bigint): PublicKey {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode(SEEDS.policyChange), multisig.toBytes(), txIndexSeed(txIndex)],
    guardProgram,
  )[0];
}
