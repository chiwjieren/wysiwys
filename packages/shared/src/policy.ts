import { sha256 } from "@noble/hashes/sha256";

// policy_hash stored in GuardConfig and carried in every report. Pure TypeScript (runs in CRE WASM).

/** JSON with keys sorted at every level and no whitespace. Only safe integers; put amounts in strings. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error(`canonicalJson: ${value} is not an integer; use a decimal string`);
    if (!Number.isSafeInteger(value)) throw new Error(`canonicalJson: ${value} is not a safe integer; use a decimal string`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported value of type ${typeof value}`);
}

const POLICY_DOMAIN = new TextEncoder().encode("wysiwys:policy:v1");

/**
 * sha256("wysiwys:policy:v1" || u32le(len(decoder_version)) || decoder_version || sha256(canonicalJson(policy))).
 * The policy stays private (CRE secret); only this commitment is public. It must carry a random `salt`
 * (hex, >= 16 bytes) so the hash cannot be confirmed by guessing whitelist entries.
 */
export function policyHash(policy: Record<string, unknown>, decoderVersion: string): Uint8Array {
  if (typeof policy.version !== "number") throw new Error("policy needs a numeric version");
  if (typeof policy.salt !== "string" || !/^[0-9a-f]{32,}$/i.test(policy.salt)) {
    throw new Error("policy needs a random hex salt of at least 16 bytes");
  }
  if (!decoderVersion) throw new Error("decoder version is required");
  const dv = new TextEncoder().encode(decoderVersion);
  const inner = sha256(new TextEncoder().encode(canonicalJson(policy)));
  const out = new Uint8Array(POLICY_DOMAIN.length + 4 + dv.length + 32);
  out.set(POLICY_DOMAIN, 0);
  new DataView(out.buffer).setUint32(POLICY_DOMAIN.length, dv.length, true);
  out.set(dv, POLICY_DOMAIN.length + 4);
  out.set(inner, POLICY_DOMAIN.length + 4 + dv.length);
  return sha256(out);
}
