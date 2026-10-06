import anchor, { type Idl } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import idlJson from "@wysiwys/shared/idl/wysiwys_guard.json" with { type: "json" };

export const idl = idlJson as Idl;
export const PROGRAM_ID = new PublicKey(idl.address);
const { BN, BorshCoder } = anchor;
const coder = new BorshCoder(idl);

export const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
export const bytes32 = (n: number) => Array.from(new Uint8Array(32).fill(n));

/** "Program data:" line exactly as Anchor's emit! writes it. */
export function eventLine(name: "ReviewRequested" | "DecisionRecorded" | "Executed", data: Record<string, unknown>): string {
  const disc = idl.events!.find((e) => e.name === name)!.discriminator;
  const body = coder.types.encode(name, data);
  return `Program data: ${Buffer.concat([Buffer.from(disc), body]).toString("base64")}`;
}

/** Logs of one top-level guard invocation wrapping the given lines. */
export function guardLogs(lines: string[], programId: PublicKey = PROGRAM_ID): string[] {
  const id = programId.toBase58();
  return [`Program ${id} invoke [1]`, "Program log: Instruction: RequestReview", ...lines, `Program ${id} success`];
}

export const reviewRequested = (review: PublicKey, txIndex = 7) =>
  eventLine("ReviewRequested", { review, multisig: key(2), tx_index: new BN(txIndex), tx_hash: bytes32(9) });

export const decisionRecorded = (review: PublicKey, verdict = 1, reason = 0) =>
  eventLine("DecisionRecorded", {
    review, verdict, reason, policy_hash: bytes32(3), action_kind: 2,
    destination: key(4), destination_owner: key(5), mint: key(6), expires_at: new BN(1_800_000_000),
  });

export const executed = (review: PublicKey, txIndex = 7) =>
  eventLine("Executed", { review, multisig: key(2), tx_index: new BN(txIndex) });
