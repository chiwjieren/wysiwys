import * as sqds from "@sqds/multisig";
import { type PublicKey } from "@solana/web3.js";
import type { SquadConfig } from "./sdk";

// UX checks complement Squads' on-chain permission, status and timelock enforcement.
export function assertStandardExecution(
  config: SquadConfig,
  squad: Pick<
    sqds.accounts.Multisig,
    "members" | "threshold" | "timeLock" | "staleTransactionIndex"
  >,
  proposal: Pick<
    sqds.accounts.Proposal,
    "status" | "approved" | "transactionIndex"
  >,
  member: PublicKey,
  now = Math.floor(Date.now() / 1000),
  kind: "vault" | "config" | "batch" = "vault",
) {
  if (
    config.executionMode !== "standard" ||
    config.guardProgram ||
    config.executor
  )
    throw new Error("This group cannot use standard Squads execution.");
  const permission = squad.members.find((m) => m.key.equals(member));
  if (
    !permission ||
    !sqds.types.Permissions.has(
      permission.permissions,
      sqds.types.Permission.Execute,
    )
  )
    throw new Error("Your wallet does not have execution permission.");
  if (proposal.status.__kind !== "Approved")
    throw new Error("The proposal must be approved before execution.");
  // Approved is the canonical on-chain quorum result, even after the threshold changes.
  if (
    kind === "config" &&
    BigInt(proposal.transactionIndex.toString()) <=
      BigInt(squad.staleTransactionIndex.toString())
  )
    throw new Error("This proposal is stale. Create a new proposal.");
  if (
    BigInt(now) <
    BigInt(proposal.status.timestamp.toString()) + BigInt(squad.timeLock)
  )
    throw new Error("The proposal timelock has not elapsed.");
}
