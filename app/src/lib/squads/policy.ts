import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  decodePolicyChangeMarker,
  encodePolicyChangeMarker,
  parsePolicy,
  type PolicyV1,
} from "@wysiwys/shared";
import type { ProgressStep, StepState } from "./progress";

// Voted policy changes in the app: plain-words diff of two Policy v1 documents, the marker instruction a
// policy change proposal stores, and the progress of such a proposal. Pure functions; chain reads live in
// the provider and the pages.

/** Minimum wait after approval (guard POLICY_CHANGE_MIN_DELAY in programs/wysiwys_guard/src/constants.rs). */
export const POLICY_CHANGE_MIN_DELAY_SECONDS = 300;

const INSTRUCTION_LABELS: Record<string, string> = {
  "system:transfer": "SOL transfers",
  "spl-token:transferChecked": "token transfers",
};

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;
const groupThousands = (value: string) => {
  const [whole, fraction] = value.split(".");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${grouped}.${fraction}` : grouped;
};
function fromBaseUnits(raw: string, decimals: number) {
  const padded = raw.padStart(decimals + 1, "0");
  const value = decimals
    ? `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`.replace(
        /\.?0+$/,
        "",
      )
    : padded;
  return groupThousands(value);
}

export type PolicyToken = { mint: string; symbol: string; decimals: number };

/** The cap in the treasury token's units when the policy allows exactly that token, else in base units. */
function capLabel(policy: PolicyV1, token?: PolicyToken) {
  const only =
    policy.allowedMints.length === 1 ? policy.allowedMints[0] : undefined;
  return token && only?.mint === token.mint
    ? `${fromBaseUnits(policy.maxAmountPerPayment, token.decimals)} ${token.symbol}`
    : `${groupThousands(policy.maxAmountPerPayment)} base units`;
}

/** What a policy change does, in plain words. Without the current document, describes the proposed one. */
export function diffPolicies(
  current: PolicyV1 | null,
  next: PolicyV1,
  token?: PolicyToken,
): string[] {
  if (!current)
    return [
      `Policy version ${next.version} (the current document is not on file, so this is the full proposed policy)`,
      `Whitelist: ${plural(next.destinationWhitelist.length, "address", "addresses")}`,
      `Per-payment cap: ${capLabel(next, token)}`,
      `Allowed tokens: ${next.allowedMints.map((m) => m.mint).join(", ") || "none"}`,
      `Allowed payments: ${next.allowedInstructions.map((i) => INSTRUCTION_LABELS[i] ?? i).join(", ")}`,
      `Sanctions screening: ${next.screening ? "on" : "off"}`,
    ];
  const lines = [`Policy version ${current.version} → ${next.version}`];
  const added = next.destinationWhitelist.filter(
    (w) => !current.destinationWhitelist.includes(w),
  );
  const removed = current.destinationWhitelist.filter(
    (w) => !next.destinationWhitelist.includes(w),
  );
  if (added.length)
    lines.push(
      `Adds ${plural(added.length, "address", "addresses")} to the whitelist: ${added.join(", ")}`,
    );
  if (removed.length)
    lines.push(
      `Removes ${plural(removed.length, "address", "addresses")} from the whitelist: ${removed.join(", ")}`,
    );
  const before = BigInt(current.maxAmountPerPayment);
  const after = BigInt(next.maxAmountPerPayment);
  if (before !== after) {
    const from = capLabel(current, token);
    const to = capLabel(next, token);
    const unit = (label: string) => label.slice(label.indexOf(" "));
    // Drop the unit from the old value only when both values use the same unit.
    const fromText =
      unit(from) === unit(to) ? from.slice(0, from.indexOf(" ")) : from;
    lines.push(
      `${after > before ? "Raises" : "Lowers"} the per-payment cap from ${fromText} to ${to}`,
    );
  }
  for (const m of next.allowedMints) {
    const old = current.allowedMints.find((x) => x.mint === m.mint);
    if (!old) lines.push(`Allows token ${m.mint} (${m.decimals} decimals)`);
    else if (old.decimals !== m.decimals)
      lines.push(
        `Changes token ${m.mint} decimals from ${old.decimals} to ${m.decimals}`,
      );
  }
  for (const m of current.allowedMints)
    if (!next.allowedMints.some((x) => x.mint === m.mint))
      lines.push(`Stops allowing token ${m.mint}`);
  for (const i of next.allowedInstructions)
    if (!current.allowedInstructions.includes(i))
      lines.push(`Allows ${INSTRUCTION_LABELS[i] ?? i}`);
  for (const i of current.allowedInstructions)
    if (!next.allowedInstructions.includes(i))
      lines.push(`Stops allowing ${INSTRUCTION_LABELS[i] ?? i}`);
  if (!current.screening && next.screening)
    lines.push("Turns on sanctions screening");
  if (current.screening && !next.screening)
    lines.push("Turns off sanctions screening");
  return lines;
}

/** The only instruction of a policy change proposal: the guard marker (never executed). */
export function buildPolicyChangeInstruction(
  guard: PublicKey,
  newPolicyHash: Uint8Array,
  expectedPolicyHash: Uint8Array,
) {
  return new TransactionInstruction({
    programId: guard,
    keys: [],
    data: Buffer.from(
      encodePolicyChangeMarker({ newPolicyHash, expectedPolicyHash }),
    ),
  });
}

const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

type StoredMessage = {
  accountKeys: PublicKey[];
  instructions: {
    programIdIndex: number;
    accountIndexes: ArrayLike<number>;
    data: ArrayLike<number>;
  }[];
  addressTableLookups: unknown[];
};

/** The proposed hashes when a stored vault transaction is exactly one marker instruction to the guard. */
export function readPolicyChange(message: StoredMessage, guard: PublicKey) {
  if (
    message.addressTableLookups.length ||
    message.instructions.length !== 1 ||
    message.accountKeys.length !== 2
  )
    return null;
  const [ix] = message.instructions;
  if (
    !message.accountKeys[ix!.programIdIndex]?.equals(guard) ||
    ix!.accountIndexes.length
  )
    return null;
  const marker = decodePolicyChangeMarker(Uint8Array.from(ix!.data));
  return marker
    ? {
        newPolicyHash: hex(marker.newPolicyHash),
        expectedPolicyHash: hex(marker.expectedPolicyHash),
      }
    : null;
}

/** GuardConfig.policy_hash: discriminator (8) | multisig | forwarder_program | forwarder_state | policy_hash. */
export function policyHashFromGuardConfig(data: Uint8Array) {
  return data.length >= 136 ? hex(data.subarray(104, 136)) : null;
}

/** Members who can propose or vote (Initiate or Vote permission) may read and propose policies. */
export function isPolicyMember(
  members: { key: PublicKey; permissions: { mask: number } }[],
  wallet: string,
) {
  return members.some(
    (m) => m.key.toBase58() === wallet && (m.permissions.mask & 3) !== 0,
  );
}

/** Progress of a policy change proposal: Proposed, Member approvals, Waiting period, Applied. */
export function policyProgress(o: {
  proposalStatus: string;
  approvals: number;
  threshold: number | null;
  /** Squads Approved timestamp (unix seconds), null before approval. */
  approvedAt: number | null;
  timeLock: number;
  applied: boolean;
  nowSeconds: number;
}): ProgressStep[] {
  const step = (
    key: ProgressStep["key"],
    label: string,
    state: StepState,
    detail: string,
  ): ProgressStep => ({ key, label, state, detail });
  const stopped =
    o.proposalStatus === "Rejected" || o.proposalStatus === "Cancelled";
  const approved =
    o.applied ||
    ["Approved", "Executing", "Executed"].includes(o.proposalStatus);
  const votes = stopped
    ? step("votes", "Member approvals", "failed", o.proposalStatus)
    : approved
      ? step("votes", "Member approvals", "done", "Approved")
      : step(
          "votes",
          "Member approvals",
          o.proposalStatus === "Draft" ? "waiting" : "active",
          o.threshold
            ? `${Math.min(o.approvals, o.threshold)} of ${o.threshold} approved`
            : `${o.approvals} approved`,
        );
  const delay = Math.max(o.timeLock, POLICY_CHANGE_MIN_DELAY_SECONDS);
  const readyAt = o.approvedAt === null ? null : o.approvedAt + delay;
  const waited = o.applied || (readyAt !== null && o.nowSeconds >= readyAt);
  const wait = stopped
    ? step("wait", "Waiting period", "failed", "Cannot apply")
    : waited
      ? step("wait", "Waiting period", "done", "Waiting period passed")
      : readyAt !== null && approved
        ? step(
            "wait",
            "Waiting period",
            "active",
            `Waiting period ends at ${new Date(readyAt * 1000).toLocaleTimeString()}`,
          )
        : step(
            "wait",
            "Waiting period",
            "waiting",
            `${Math.round(delay / 60)} min after approval; members can cancel`,
          );
  const applied = o.applied
    ? step("applied", "Applied", "done", "Policy updated")
    : stopped
      ? step("applied", "Applied", "failed", "Cannot apply")
      : waited && approved
        ? step("applied", "Applied", "active", "Ready to apply")
        : step("applied", "Applied", "waiting", "Needs the vote and the wait");
  return [
    step("proposed", "Proposed", "done", "Stored in Squads"),
    votes,
    wait,
    applied,
  ];
}

export type PolicyRequest =
  | { action: "current"; multisig: string }
  | { action: "read"; multisig: string; hash: string; base?: string }
  | { action: "submit"; multisig: string; document: PolicyV1 };

/** Body of POST /api/policy (wallet-signed): the treasury's current policy, a stored document, or a submission. */
export function parsePolicyRequest(input: unknown): PolicyRequest {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid policy request.");
  const o = input as Record<string, unknown>;
  const multisig = new PublicKey(String(o.multisig ?? "")).toBase58();
  if (o.multisig !== multisig) throw new Error("Invalid multisig.");
  const keys = Object.keys(o).sort().join(",");
  if (o.action === "current" && keys === "action,multisig")
    return { action: "current", multisig };
  const isHash = (v: unknown): v is string =>
    typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
  if (o.action === "read" && keys === "action,hash,multisig" && isHash(o.hash))
    return { action: "read", multisig, hash: o.hash };
  if (
    o.action === "read" &&
    keys === "action,base,hash,multisig" &&
    isHash(o.hash) &&
    isHash(o.base)
  )
    return { action: "read", multisig, hash: o.hash, base: o.base };
  if (o.action === "submit" && keys === "action,document,multisig")
    return { action: "submit", multisig, document: parsePolicy(o.document) };
  throw new Error("Invalid policy request.");
}

/** Whether a proposal record is a policy change (its vault transaction is the guard marker). */
export function isPolicyChangeRecord(
  record: { kind: string; transaction?: unknown },
  guardProgram: string | undefined,
) {
  const message =
    record.kind === "vault"
      ? (record.transaction as { message?: StoredMessage } | null)?.message
      : undefined;
  return (
    !!guardProgram &&
    !!message &&
    readPolicyChange(message, new PublicKey(guardProgram)) !== null
  );
}
