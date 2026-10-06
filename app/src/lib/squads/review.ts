import { PublicKey, type Connection } from "@solana/web3.js";
import type { SquadConfig } from "./sdk";

// Guard `Review` account (Anchor). Discriminator pinned to
// packages/shared/idl/wysiwys_guard.json by tests/review.test.ts.
export const REVIEW_DISCRIMINATOR = [124, 63, 203, 215, 226, 30, 222, 15];
export const REVIEW_SIZE = 238;
const STATUSES = ["Pending", "Approved", "Rejected", "Executed"] as const;
export type ReviewStatus = (typeof STATUSES)[number];
export type Review = {
  version: number;
  multisig: PublicKey;
  vaultTransaction: PublicKey;
  proposal: PublicKey;
  txIndex: bigint;
  txHash: Uint8Array;
  status: ReviewStatus;
  reason: number;
  policyHash: Uint8Array;
  actionKind: number;
  destinationHash: Uint8Array;
  issuedAt: number;
  expiresAt: number;
  createdAt: number;
  bump: number;
};

export function decodeReview(data: Uint8Array): Review {
  if (data.length < REVIEW_SIZE)
    throw new Error("Review account is too short.");
  if (REVIEW_DISCRIMINATOR.some((byte, i) => data[i] !== byte))
    throw new Error("Invalid Review account discriminator.");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const key = (offset: number) =>
    new PublicKey(data.slice(offset, offset + 32));
  const status = STATUSES[data[145]];
  if (!status) throw new Error("Invalid Review status.");
  const i64 = (offset: number) => Number(view.getBigInt64(offset, true));
  return {
    version: data[8],
    multisig: key(9),
    vaultTransaction: key(41),
    proposal: key(73),
    txIndex: view.getBigUint64(105, true),
    txHash: data.slice(113, 145),
    status,
    reason: view.getUint16(146, true),
    policyHash: data.slice(148, 180),
    actionKind: data[180],
    destinationHash: data.slice(181, 213),
    issuedAt: i64(213),
    expiresAt: i64(221),
    createdAt: i64(229),
    bump: data[237],
  };
}

export function decodeReviewAccount(
  info: { owner: PublicKey; data: Uint8Array },
  guardProgram: PublicKey,
  multisig: PublicKey,
  index: bigint,
) {
  if (!info.owner.equals(guardProgram))
    throw new Error("Review account is not owned by the guard program.");
  const review = decodeReview(info.data);
  if (!review.multisig.equals(multisig) || review.txIndex !== index)
    throw new Error("Review account binding mismatch.");
  return review;
}

export function reviewPda(
  guardProgram: PublicKey,
  multisig: PublicKey,
  index: bigint,
) {
  const seed = new Uint8Array(8);
  new DataView(seed.buffer).setBigUint64(0, index, true);
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("review"), multisig.toBytes(), seed],
    guardProgram,
  )[0];
}

// Deterministic templates for ReviewReason (packages/shared/src/reasons.ts).
const REASONS = [
  "Within policy",
  "Blocked: the RPC providers did not agree",
  "Blocked: the stored transaction changed after review was requested",
  "Blocked: the payment calls an unknown program",
  "Blocked: the payment contains an unexpected instruction",
  "Blocked: the payment uses an unsupported feature",
  "Blocked: the payment hides an authority change",
  "Blocked: the payment uses a durable nonce",
  "Blocked: the recipient is not on the approved list",
  "Blocked: the recipient owner could not be resolved",
  "Blocked: the token is not allowed",
  "Blocked: the amount is over the per-payment limit",
  "Blocked: the recipient failed sanctions screening",
  "Blocked: the policy changed since review",
];
export function reviewReasonText(code: number) {
  return REASONS[code] ?? `Unknown reason code ${code}`;
}

export type ReviewState =
  "none" | "pending" | "approved" | "rejected" | "executed" | "expired";
export function reviewState(
  review: Review | null | undefined,
  nowSeconds: number,
): ReviewState {
  if (!review) return "none";
  if (review.status === "Approved" && review.expiresAt < nowSeconds)
    return "expired";
  return review.status.toLowerCase() as ReviewState;
}
const LABELS: Record<ReviewState, string> = {
  none: "No review requested",
  pending: "Pending review",
  approved: "Approved",
  rejected: "Rejected",
  executed: "Executed",
  expired: "Expired",
};
export const reviewStateLabel = (state: ReviewState) => LABELS[state];
export const reviewStateTone = (state: ReviewState) =>
  state === "approved" || state === "executed"
    ? ("success" as const)
    : state === "rejected"
      ? ("danger" as const)
      : state === "pending" || state === "expired"
        ? ("warning" as const)
        : ("neutral" as const);

// UX only: guarded_execute enforces the same rules on-chain.
export function executeGate(
  proposalStatus: string,
  review: Review | null | undefined,
  nowSeconds: number,
) {
  const state = reviewState(review, nowSeconds);
  const blocked = (reason: string) => ({ enabled: false, reason });
  if (proposalStatus === "Executed" || state === "executed")
    return blocked("Already executed");
  if (state === "none") return blocked("No review requested");
  if (state === "pending") return blocked("Waiting for the Chainlink review");
  if (state === "rejected")
    return blocked(
      `Rejected by the Chainlink review: ${reviewReasonText(review!.reason).replace(/^Blocked: /, "")}`,
    );
  if (state === "expired") return blocked("Review expired");
  if (proposalStatus !== "Approved")
    return blocked("Waiting for member approvals");
  return { enabled: true, reason: "" };
}

export function isGuarded(
  config: Pick<SquadConfig, "guardProgram" | "executionMode"> | undefined,
) {
  return !!config?.guardProgram && config.executionMode !== "standard";
}

// One finalized getMultipleAccounts for every requested proposal index.
// A missing account means no review was requested; a malformed one throws.
export async function readReviews(
  connection: Pick<Connection, "getMultipleAccountsInfo">,
  guardProgram: PublicKey,
  multisig: PublicKey,
  indices: bigint[],
): Promise<Record<string, Review | null>> {
  if (!indices.length) return {};
  const accounts = await connection.getMultipleAccountsInfo(
    indices.map((index) => reviewPda(guardProgram, multisig, index)),
    "finalized",
  );
  return Object.fromEntries(
    indices.map((index, i) => {
      const info = accounts[i];
      return [
        index.toString(),
        info ? decodeReviewAccount(info, guardProgram, multisig, index) : null,
      ];
    }),
  );
}
