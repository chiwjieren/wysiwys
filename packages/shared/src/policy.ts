import { sha256 } from "@noble/hashes/sha256";
import { PublicKey } from "@solana/web3.js";

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

// ---------------------------------------------------------------------------------------------
// Policy document format v1 (binding). parsePolicy is the single validator for every consumer
// (workflow, runner, app, scripts). Error messages name the field and never echo values, because
// the salt and the whitelist are private.
// ---------------------------------------------------------------------------------------------

export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** Instruction names a policy may allow, with the program each one belongs to. */
export const POLICY_INSTRUCTION_PROGRAMS = {
  "system:transfer": SYSTEM_PROGRAM_ID,
  "spl-token:transferChecked": TOKEN_PROGRAM_ID,
} as const;

export type PolicyInstruction = keyof typeof POLICY_INSTRUCTION_PROGRAMS;

export const U64_MAX = 18446744073709551615n;

export interface PolicyMint {
  mint: string;
  decimals: number;
}

export interface PolicyScreening {
  provider: "scorechain";
  blockOn: ["SANCTIONED"];
}

export interface PolicyV1 {
  version: number;
  salt: string;
  allowedPrograms: string[];
  allowedInstructions: PolicyInstruction[];
  allowedMints: PolicyMint[];
  maxAmountPerPayment: string;
  destinationWhitelist: string[];
  screening?: PolicyScreening;
}

/** The registry is the JSON of the Vault DON secret POLICY_DOCUMENTS. */
export type PolicyRegistry = PolicyV1[];

export class PolicyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyFormatError";
  }
}

const REQUIRED_KEYS = [
  "version", "salt", "allowedPrograms", "allowedInstructions", "allowedMints", "maxAmountPerPayment", "destinationWhitelist",
] as const;
const ALLOWED_KEYS: readonly string[] = [...REQUIRED_KEYS, "screening"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Canonical base58 of exactly 32 bytes. */
function isBase58Key(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    return new PublicKey(v).toBase58() === v;
  } catch {
    return false;
  }
}

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new PolicyFormatError(`${where}: unknown key ${JSON.stringify(k)}`);
  }
}

function requireArray(obj: Record<string, unknown>, field: string): unknown[] {
  const v = obj[field];
  if (!Array.isArray(v)) throw new PolicyFormatError(`${field} must be an array`);
  return v;
}

/** Validate an untrusted policy document and return a new plain object with the same keys and values. */
export function parsePolicy(input: unknown): PolicyV1 {
  if (!isRecord(input)) throw new PolicyFormatError("policy must be a JSON object");
  rejectUnknownKeys(input, ALLOWED_KEYS, "policy");
  for (const k of REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, k)) throw new PolicyFormatError(`${k} is required`);
  }

  const version = input.version;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version <= 0) {
    throw new PolicyFormatError("version must be a positive safe integer");
  }

  const salt = input.salt;
  if (typeof salt !== "string" || !/^[0-9a-f]{32,}$/i.test(salt)) {
    throw new PolicyFormatError("salt must be a hex string of at least 32 characters");
  }

  const programs = requireArray(input, "allowedPrograms");
  if (programs.length === 0) throw new PolicyFormatError("allowedPrograms must not be empty");
  const knownPrograms: string[] = Object.values(POLICY_INSTRUCTION_PROGRAMS);
  const allowedPrograms: string[] = [];
  programs.forEach((p, i) => {
    if (typeof p !== "string" || !knownPrograms.includes(p)) {
      throw new PolicyFormatError(`allowedPrograms[${i}] must be the System or the Token program address`);
    }
    if (allowedPrograms.includes(p)) throw new PolicyFormatError(`allowedPrograms[${i}] must be unique`);
    allowedPrograms.push(p);
  });

  const instructions = requireArray(input, "allowedInstructions");
  if (instructions.length === 0) throw new PolicyFormatError("allowedInstructions must not be empty");
  const allowedInstructions: PolicyInstruction[] = [];
  instructions.forEach((ix, i) => {
    if (typeof ix !== "string" || !Object.prototype.hasOwnProperty.call(POLICY_INSTRUCTION_PROGRAMS, ix)) {
      throw new PolicyFormatError(`allowedInstructions[${i}] must be one of ${Object.keys(POLICY_INSTRUCTION_PROGRAMS).join(", ")}`);
    }
    const name = ix as PolicyInstruction;
    if (allowedInstructions.includes(name)) throw new PolicyFormatError(`allowedInstructions[${i}] must be unique`);
    if (!allowedPrograms.includes(POLICY_INSTRUCTION_PROGRAMS[name])) {
      throw new PolicyFormatError(`allowedInstructions[${i}] needs its program listed in allowedPrograms`);
    }
    allowedInstructions.push(name);
  });

  const mints = requireArray(input, "allowedMints");
  if (mints.length === 0 && allowedInstructions.includes("spl-token:transferChecked")) {
    throw new PolicyFormatError("allowedMints may be empty only if spl-token:transferChecked is not in allowedInstructions");
  }
  const allowedMints: PolicyMint[] = [];
  mints.forEach((m, i) => {
    if (!isRecord(m)) throw new PolicyFormatError(`allowedMints[${i}] must be an object`);
    rejectUnknownKeys(m, ["mint", "decimals"], `allowedMints[${i}]`);
    if (!isBase58Key(m.mint)) throw new PolicyFormatError(`allowedMints[${i}].mint must be a base58 32-byte address`);
    if (typeof m.decimals !== "number" || !Number.isInteger(m.decimals) || m.decimals < 0 || m.decimals > 9) {
      throw new PolicyFormatError(`allowedMints[${i}].decimals must be an integer 0..9`);
    }
    if (allowedMints.some((x) => x.mint === m.mint)) throw new PolicyFormatError(`allowedMints[${i}].mint must be unique`);
    allowedMints.push({ mint: m.mint, decimals: m.decimals });
  });

  const cap = input.maxAmountPerPayment;
  if (typeof cap !== "string" || !/^[1-9][0-9]*$/.test(cap) || BigInt(cap) > U64_MAX) {
    throw new PolicyFormatError("maxAmountPerPayment must be a positive decimal string without leading zeros, at most 18446744073709551615");
  }

  const whitelist = requireArray(input, "destinationWhitelist");
  const destinationWhitelist: string[] = [];
  whitelist.forEach((w, i) => {
    if (!isBase58Key(w)) throw new PolicyFormatError(`destinationWhitelist[${i}] must be a base58 32-byte address`);
    if (destinationWhitelist.includes(w)) throw new PolicyFormatError(`destinationWhitelist[${i}] must be unique`);
    destinationWhitelist.push(w);
  });

  const out: PolicyV1 = {
    version, salt, allowedPrograms, allowedInstructions, allowedMints, maxAmountPerPayment: cap, destinationWhitelist,
  };

  if (Object.prototype.hasOwnProperty.call(input, "screening")) {
    const s = input.screening;
    const ok =
      isRecord(s) &&
      Object.keys(s).length === 2 &&
      s.provider === "scorechain" &&
      Array.isArray(s.blockOn) &&
      s.blockOn.length === 1 &&
      s.blockOn[0] === "SANCTIONED";
    if (!ok) throw new PolicyFormatError('screening must be exactly { "provider": "scorechain", "blockOn": ["SANCTIONED"] } or absent');
    out.screening = { provider: "scorechain", blockOn: ["SANCTIONED"] };
  }
  return out;
}
