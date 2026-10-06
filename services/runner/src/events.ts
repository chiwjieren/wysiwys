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
  destination: string;
  destinationOwner: string;
  mint: string;
  expiresAt: string;
};
export type Executed = { name: "Executed"; review: string; multisig: string; txIndex: string };
export type GuardEvent = ReviewRequested | DecisionRecorded | Executed;

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
        destination: d.destination.toBase58(),
        destinationOwner: d.destination_owner.toBase58(),
        mint: d.mint.toBase58(),
        expiresAt: d.expires_at.toString(),
      };
    case "executed":
    case "Executed":
      return { name: "Executed", review: d.review.toBase58(), multisig: d.multisig.toBase58(), txIndex: d.tx_index.toString() };
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
