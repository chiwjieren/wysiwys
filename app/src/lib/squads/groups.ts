import * as sqds from "@sqds/multisig";
import type { SquadConfig } from "./sdk";
import { PublicKey } from "@solana/web3.js";

const permissions = () =>
  sqds.types.Permissions.fromPermissions([
    sqds.types.Permission.Initiate,
    sqds.types.Permission.Vote,
  ]);
export function buildGroupCreation({
  creator,
  createKey,
  treasury,
  members,
  threshold,
  name,
  executor,
}: {
  creator: PublicKey;
  createKey: PublicKey;
  treasury: PublicKey;
  members: string[];
  threshold: number;
  name: string;
  executor?: PublicKey;
}) {
  if (!name.trim() || name.trim().length > 80)
    throw new Error("Enter a group name of up to 80 characters.");
  if (members.length > 19)
    throw new Error("Invite up to 19 members when creating a group.");
  const keys = [creator, ...members.map((address) => new PublicKey(address))];
  if (keys.some((key) => !PublicKey.isOnCurve(key.toBytes())))
    throw new Error("Members must be Solana wallet addresses.");
  if (new Set(keys.map((key) => key.toBase58())).size !== keys.length)
    throw new Error("Duplicate member wallet.");
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > keys.length)
    throw new Error("Choose a threshold between 1 and the member count.");
  const [multisig] = sqds.getMultisigPda({ createKey });
  if (executor && PublicKey.isOnCurve(executor.toBytes()))
    throw new Error(
      "A registered guard executor is required to create the group.",
    );
  const [vault] = sqds.getVaultPda({ multisigPda: multisig, index: 0 });
  return {
    multisig,
    vault,
    instruction: sqds.instructions.multisigCreateV2({
      treasury,
      creator,
      multisigPda: multisig,
      configAuthority: null,
      threshold,
      // Standard groups have one human executor; guarded groups retain the sole PDA executor.
      members: [
        ...keys.map((key) => ({
          key,
          permissions:
            !executor && key.equals(creator)
              ? sqds.types.Permissions.all()
              : permissions(),
        })),
        ...(executor
          ? [
              {
                key: executor,
                permissions: sqds.types.Permissions.fromPermissions([
                  sqds.types.Permission.Execute,
                ]),
              },
            ]
          : []),
      ],
      timeLock: 0,
      createKey,
      rentCollector: null,
      memo: name.trim(),
    }),
  };
}
export function buildMemberInvitation({
  multisig,
  creator,
  index,
  newMember,
}: {
  multisig: PublicKey;
  creator: PublicKey;
  index: bigint;
  newMember: PublicKey;
}) {
  if (!PublicKey.isOnCurve(newMember.toBytes()))
    throw new Error("Enter the member's Solana wallet address.");
  return [
    sqds.instructions.configTransactionCreate({
      multisigPda: multisig,
      transactionIndex: index,
      creator,
      rentPayer: creator,
      actions: [
        {
          __kind: "AddMember",
          newMember: { key: newMember, permissions: permissions() },
        },
      ],
    }),
    sqds.instructions.proposalCreate({
      multisigPda: multisig,
      transactionIndex: index,
      creator,
      rentPayer: creator,
      isDraft: false,
    }),
  ];
}

// Display label for a member's on-chain Squads permission mask.
export function memberRole(address: string, mask: number, executor?: string) {
  if (executor && address === executor && mask === 4)
    return "Guard executor (Execute only)";
  const names = [
    [1, "Initiate"],
    [2, "Vote"],
    [4, "Execute"],
  ] as const;
  const held = names.filter(([bit]) => mask & bit).map(([, name]) => name);
  return held.length ? held.join(" + ") : "No permissions";
}

// Classify from finalized account permissions; an unavailable Guard must never be a standard fallback.
export function standardGroupConfig(
  multisig: string,
  members: sqds.accounts.Multisig["members"],
): SquadConfig | null {
  const executors = members.filter((m) =>
    sqds.types.Permissions.has(m.permissions, sqds.types.Permission.Execute),
  );
  if (
    !executors.length ||
    executors.some((m) => !PublicKey.isOnCurve(m.key.toBytes()))
  )
    return null;
  return {
    multisig,
    vaultIndex: 0,
    settlementEnabled: false,
    executionMode: "standard",
  };
}
