import { Buffer } from "buffer";
import * as sqds from "@sqds/multisig";
import type { SquadConfig } from "./sdk";
import {
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from "@solana/web3.js";

// multisigCreateV2 and initialize_guard share one transaction (1232 bytes).
export const GUARDED_GROUP_MAX_INVITES = 12;

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
  const maxInvites = executor ? GUARDED_GROUP_MAX_INVITES : 19;
  if (members.length > maxInvites)
    throw new Error(
      `Invite up to ${maxInvites} members when creating a group.`,
    );
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

// Standard (unguarded) groups give the creator Squads Execute, bypassing the guard.
// UI creation makes guarded treasuries; standard creation is opt-in.
export function standardGroupsEnabled(flag: string | undefined) {
  return flag === "true";
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

// Anchor `initialize_guard` (packages/shared/idl/wysiwys_guard.json).
export const INITIALIZE_GUARD_DISCRIMINATOR = [
  63, 189, 246, 157, 77, 125, 157, 142,
];
const INITIALIZE_GUARD_LENGTH = 8 + 32 + 32 + 32 + 20 + 8 + 8;
// GuardConfig values from the deployment (hex hashes, decimal i64 strings).
export type GuardInitArgs = {
  forwarderProgram: string;
  forwarderState: string;
  policyHash: string;
  workflowOwner: string;
  maxReviewLifetime: string;
  reviewDeadlineSecs: string;
};
export function encodeInitializeGuardArgs(args: GuardInitArgs) {
  const data = Buffer.alloc(INITIALIZE_GUARD_LENGTH);
  Buffer.from(INITIALIZE_GUARD_DISCRIMINATOR).copy(data, 0);
  new PublicKey(args.forwarderProgram).toBuffer().copy(data, 8);
  new PublicKey(args.forwarderState).toBuffer().copy(data, 40);
  Buffer.from(args.policyHash, "hex").copy(data, 72);
  Buffer.from(args.workflowOwner, "hex").copy(data, 104);
  data.writeBigInt64LE(BigInt(args.maxReviewLifetime), 124);
  data.writeBigInt64LE(BigInt(args.reviewDeadlineSecs), 132);
  return data;
}
// Checks the runner-built initialize_guard before the creator signs it with the
// group creation: exact accounts, flags and PDAs, and (when the deployment pins
// them) the exact forwarder, policy hash and review lifetimes.
export function validateInitializeGuard(
  ix: TransactionInstruction,
  expected: {
    guardProgram: PublicKey;
    multisig: PublicKey;
    createKey: PublicKey;
    creator: PublicKey;
    executor: PublicKey;
    args?: GuardInitArgs;
  },
) {
  const { guardProgram, multisig, createKey, creator, executor } = expected;
  if (
    !ix.programId.equals(guardProgram) ||
    guardProgram.equals(sqds.PROGRAM_ID) ||
    guardProgram.equals(SystemProgram.programId)
  )
    throw new Error("initialize_guard must target the guard program.");
  if (!sqds.getMultisigPda({ createKey })[0].equals(multisig))
    throw new Error("The group address does not match its create key.");
  if (createKey.equals(creator))
    throw new Error("The create key must differ from the creator.");
  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from("config"), multisig.toBuffer()],
    guardProgram,
  );
  const [derivedExecutor] = PublicKey.findProgramAddressSync(
    [Buffer.from("executor"), multisig.toBuffer()],
    guardProgram,
  );
  if (!derivedExecutor.equals(executor))
    throw new Error("The guard executor does not match its derived address.");
  const accounts: [PublicKey, boolean, boolean][] = [
    [multisig, false, false],
    [createKey, true, false],
    [config, false, true],
    [executor, false, false],
    [creator, true, true],
    [SystemProgram.programId, false, false],
  ];
  if (
    ix.keys.length !== accounts.length ||
    ix.keys.some(
      (k, i) =>
        !k.pubkey.equals(accounts[i][0]) ||
        k.isSigner !== accounts[i][1] ||
        k.isWritable !== accounts[i][2],
    )
  )
    throw new Error("initialize_guard has unexpected accounts.");
  const data = Buffer.from(ix.data);
  if (
    data.length !== INITIALIZE_GUARD_LENGTH ||
    INITIALIZE_GUARD_DISCRIMINATOR.some((byte, i) => data[i] !== byte) ||
    data.readBigInt64LE(124) <= 0n ||
    data.readBigInt64LE(132) <= 0n
  )
    throw new Error("Invalid initialize_guard data.");
  if (expected.args && !data.equals(encodeInitializeGuardArgs(expected.args)))
    throw new Error(
      "initialize_guard does not match the deployment guard configuration.",
    );
  return { config, guardInstruction: ix };
}
