import type * as sqds from "@sqds/multisig";

export const GUARD_REFUSES = "The guard will refuse this change";

// Squads permission bits.
const INITIATE = 1;
const VOTE = 2;
const EXECUTE = 4;

export type ConfigActionLine = {
  // Full sentence for the review screen.
  text: string;
  // Short label for the transaction list.
  label: string;
  refused: boolean;
  reason?: string;
};

function permissionText(mask: number) {
  const names = [
    [INITIATE, "propose"],
    [VOTE, "vote"],
    [EXECUTE, "execute"],
  ] as const;
  const held = names.filter(([bit]) => mask & bit).map(([, name]) => name);
  if (!held.length) return "no permissions";
  const list =
    held.length === 1
      ? held[0]
      : `${held.slice(0, -1).join(", ")} and ${held[held.length - 1]}`;
  return `${list} ${held.length === 1 ? "permission" : "permissions"}`;
}

/**
 * Plain-English view of a Squads config transaction. With `executor` (a guarded
 * treasury) it also flags every action `guarded_config_execute` refuses: only
 * AddMember with Initiate and/or Vote (never Execute, never the executor),
 * RemoveMember (never the executor), ChangeThreshold and SetTimeLock pass.
 * The guard enforces this on-chain; the flags only explain it in advance.
 */
export function describeConfigActions(
  actions: readonly sqds.types.ConfigAction[],
  executor?: string,
) {
  const guarded = !!executor;
  const lines = actions.map((action): ConfigActionLine => {
    let text: string;
    let label: string;
    let refused = false;
    switch (action.__kind) {
      case "AddMember": {
        const key = action.newMember.key.toBase58();
        const mask = action.newMember.permissions.mask;
        text = `Add member ${key} with ${permissionText(mask)}.`;
        label = "Add member";
        refused =
          key === executor || mask === 0 || (mask & ~(INITIATE | VOTE)) !== 0;
        break;
      }
      case "RemoveMember": {
        const key = action.oldMember.toBase58();
        text = `Remove member ${key}.`;
        label = "Remove member";
        refused = key === executor;
        break;
      }
      case "ChangeThreshold":
        text = `Change required approvals to ${action.newThreshold}.`;
        label = `Set threshold to ${action.newThreshold}`;
        break;
      case "SetTimeLock":
        text = action.newTimeLock
          ? `Set the time lock to ${action.newTimeLock} seconds.`
          : "Remove the time lock.";
        label = action.newTimeLock
          ? `Time lock ${action.newTimeLock}s`
          : "Remove time lock";
        break;
      case "AddSpendingLimit":
        text = `Add a spending limit on vault ${action.vaultIndex} for mint ${action.mint.toBase58()}.`;
        label = "Add spending limit";
        refused = true;
        break;
      case "RemoveSpendingLimit":
        text = `Remove spending limit ${action.spendingLimit.toBase58()}.`;
        label = "Remove spending limit";
        refused = true;
        break;
      case "SetRentCollector":
        text = action.newRentCollector
          ? `Set the rent collector to ${action.newRentCollector.toBase58()}.`
          : "Remove the rent collector.";
        label = "Set rent collector";
        refused = true;
        break;
      default:
        text = `Configuration action: ${(action as { __kind: string }).__kind}.`;
        label = (action as { __kind: string }).__kind;
        refused = true;
    }
    refused = guarded && refused;
    return refused
      ? { text, label, refused, reason: GUARD_REFUSES }
      : { text, label, refused };
  });
  const refused = lines.some((line) => line.refused);
  // Actions the app can decode and execute (directly, or through the guard).
  const executable = actions.every((a) =>
    ["AddMember", "RemoveMember", "ChangeThreshold", "SetTimeLock"].includes(
      a.__kind,
    ),
  );
  return {
    lines,
    refused,
    supported: actions.length > 0 && executable && !refused,
  };
}
