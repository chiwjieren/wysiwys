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

export const shortAddress = (address: string) =>
  `${address.slice(0, 4)}…${address.slice(-4)}`;

// Label for a member's permissions as offered in the Edit member dialog.
export function permissionChoiceLabel(mask: number) {
  if (mask === (INITIATE | VOTE)) return "Initiate + Vote";
  if (mask === VOTE) return "Vote only";
  if (mask === INITIATE) return "Initiate only";
  const names = [
    [INITIATE, "Initiate"],
    [VOTE, "Vote"],
    [EXECUTE, "Execute"],
  ] as const;
  const held = names.filter(([bit]) => mask & bit).map(([, name]) => name);
  return held.length ? held.join(" + ") : "No permissions";
}

// One sentence for a member edit (built by buildMemberEdit): RemoveMember and
// AddMember of the same wallet is a permission change; AddMember of one wallet
// and RemoveMember of another is a wallet replacement. A threshold change may
// accompany either and keeps its own line.
function memberEditHeadline(actions: readonly sqds.types.ConfigAction[]) {
  const members = actions.filter((a) => a.__kind !== "ChangeThreshold");
  if (members.length !== 2) return undefined;
  const add = members.find((a) => a.__kind === "AddMember");
  const remove = members.find((a) => a.__kind === "RemoveMember");
  if (add?.__kind !== "AddMember" || remove?.__kind !== "RemoveMember")
    return undefined;
  const added = add.newMember.key.toBase58();
  const removed = remove.oldMember.toBase58();
  const permissions = permissionChoiceLabel(add.newMember.permissions.mask);
  return added === removed
    ? {
        text: `Change permissions of ${added} to ${permissions}.`,
        label: "Change permissions",
      }
    : {
        text: `Replace ${removed} with ${added} (${permissions}).`,
        label: "Replace member",
      };
}

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
  // A refused action is always listed on its own, never folded into a headline.
  const headline = refused ? undefined : memberEditHeadline(actions);
  const listLabel = headline
    ? [
        headline.label,
        ...lines
          .filter((_, i) => actions[i].__kind === "ChangeThreshold")
          .map((l) => l.label),
      ].join(", ")
    : lines
        .map((l) => (l.refused ? `${l.label} (guard refuses)` : l.label))
        .join(", ");
  // Actions the app can decode and execute (directly, or through the guard).
  const executable = actions.every((a) =>
    ["AddMember", "RemoveMember", "ChangeThreshold", "SetTimeLock"].includes(
      a.__kind,
    ),
  );
  return {
    lines,
    // Plain-English summary of a member edit; every action stays in `lines`.
    headline,
    // Short description for the transaction list.
    listLabel,
    refused,
    supported: actions.length > 0 && executable && !refused,
  };
}
