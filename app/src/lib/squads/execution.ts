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

// How an approved proposal is executed. Standard groups call Squads directly.
// Guarded treasuries never do: payments go through guarded_execute and config
// changes through guarded_config_execute (the prepare action of the same name).
export function executionRoute(
  config: Pick<SquadConfig, "executionMode">,
  kind: "vault" | "config" | "batch" | "archived",
): "standard" | "execute" | "configExecute" {
  if (config.executionMode === "standard") return "standard";
  if (kind === "vault") return "execute";
  if (kind === "config") return "configExecute";
  throw new Error(
    "This transaction type cannot be executed through the guard.",
  );
}

// UX gate for a guarded config proposal. No Chainlink review is involved; the
// guard checks the actions and Squads checks approval, staleness and time lock.
export function guardedConfigGate(
  squad: Pick<sqds.accounts.Multisig, "timeLock" | "staleTransactionIndex">,
  proposal: Pick<sqds.accounts.Proposal, "status" | "transactionIndex">,
  now = Math.floor(Date.now() / 1000),
) {
  const blocked = (reason: string) => ({ enabled: false, reason });
  if (proposal.status.__kind === "Executed") return blocked("Already executed");
  if (proposal.status.__kind !== "Approved")
    return blocked("Waiting for member approvals");
  if (
    BigInt(proposal.transactionIndex.toString()) <=
    BigInt(squad.staleTransactionIndex.toString())
  )
    return blocked("This proposal is stale. Create a new proposal.");
  if (
    BigInt(now) <
    BigInt(proposal.status.timestamp.toString()) + BigInt(squad.timeLock)
  )
    return blocked("The proposal time lock has not elapsed.");
  return { enabled: true, reason: "" };
}
