// CommonJS package: named ESM imports are not detected, so destructure the default export.
import anchor, { type Idl } from "@anchor-lang/core";
import type { PublicKey } from "@solana/web3.js";

// Guard events as plain JSON: pubkeys base58, u64/i64 decimal strings, hashes hex.
export type ReviewRequested = { name: "ReviewRequested"; review: string; multisig: string; txIndex: string; txHash: string };
export type DecisionRecorded = {
  name: "DecisionRecorded";
  review: string;
  verdict: number;
  reason: number;
  policyHash: string;
  actionKind: number;
  destinationHash: string;
  expiresAt: string;
};
export type Executed = { name: "Executed"; review: string; multisig: string; txIndex: string };
/** A voted policy change applied by the guard (no review involved). */
export type PolicyChanged = { name: "PolicyChanged"; multisig: string; txIndex: string; oldPolicyHash: string; newPolicyHash: string };
export type ReviewEvent = ReviewRequested | DecisionRecorded | Executed;
export type GuardEvent = ReviewEvent | PolicyChanged;

const { BorshCoder, EventParser } = anchor;

const hex = (bytes: number[] | Uint8Array) => Buffer.from(bytes).toString("hex");

// Field names follow the raw IDL (snake_case); anchor.workspace camelCases them, the shared IDL does not.
function toGuardEvent(name: string, d: any): GuardEvent | null {
  switch (name) {
    case "reviewRequested":
    case "ReviewRequested":
      return {
        name: "ReviewRequested",
        review: d.review.toBase58(),
        multisig: d.multisig.toBase58(),
        txIndex: d.tx_index.toString(),
        txHash: hex(d.tx_hash),
      };
    case "decisionRecorded":
    case "DecisionRecorded":
      return {
        name: "DecisionRecorded",
        review: d.review.toBase58(),
        verdict: d.verdict,
        reason: d.reason,
        policyHash: hex(d.policy_hash),
        actionKind: d.action_kind,
        destinationHash: hex(d.destination_hash),
        expiresAt: d.expires_at.toString(),
      };
    case "executed":
    case "Executed":
      return { name: "Executed", review: d.review.toBase58(), multisig: d.multisig.toBase58(), txIndex: d.tx_index.toString() };
    case "policyChanged":
    case "PolicyChanged":
      return {
        name: "PolicyChanged",
        multisig: d.multisig.toBase58(),
        txIndex: d.tx_index.toString(),
        oldPolicyHash: hex(d.old_policy_hash),
        newPolicyHash: hex(d.new_policy_hash),
      };
    default:
      return null;
  }
}

/** Returns a parser for transaction logs that yields only events emitted by the guard program. */
export function createEventParser(idl: Idl, programId: PublicKey): (logs: string[]) => GuardEvent[] {
  const parser = new EventParser(programId, new BorshCoder(idl));
  return (logs) => {
    const out: GuardEvent[] = [];
    for (const e of parser.parseLogs(logs)) {
      const ev = toGuardEvent(e.name, e.data);
      if (ev) out.push(ev);
    }
    return out;
  };
}
