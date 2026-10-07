// Guard program contracts shared by the app, runner, workflow and tests.
// Addresses live in deployments/devnet.json, not here.

export const SEEDS = {
  config: "config",
  review: "review",
  executor: "executor",
  forwarder: "forwarder",
  policyChange: "policy_change",
} as const;

export function txIndexSeed(txIndex: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, txIndex, true);
  return out;
}

// Order must match programs/wysiwys_guard/src/errors.rs (Anchor codes start at 6000).
const GUARD_ERRORS = [
  "NotSquadsAccount",
  "WrongMultisig",
  "WrongTxIndex",
  "ReviewMismatch",
  "HashMismatch",
  "NotApproved",
  "Expired",
  "AlreadyExecuted",
  "InvalidStatusTransition",
  "DurableNonceDetected",
  "InvalidPayload",
  "InvalidSquadsProgram",
  "InvalidInstructionsSysvar",
  "PolicyMismatch",
  "InvalidForwarder",
  "InvalidMultisigConfig",
  "ExecutorInMessage",
  "InvalidWorkflow",
  "NotProposer",
  "DestinationChanged",
  "ReviewDeadlinePassed",
  "InvalidConfig",
  "ConfigActionNotAllowed",
] as const;

export type GuardErrorName = (typeof GUARD_ERRORS)[number];

export const GuardErrorCode = Object.fromEntries(
  GUARD_ERRORS.map((name, i) => [name, 6000 + i]),
) as Record<GuardErrorName, number>;

export const ReviewStatus = { Pending: 0, Approved: 1, Rejected: 2, Executed: 3 } as const;
