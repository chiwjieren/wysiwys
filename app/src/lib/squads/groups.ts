import { Buffer } from "buffer";
import * as sqds from "@sqds/multisig";
import type { SquadConfig } from "./sdk";
import { permissionChoiceLabel, shortAddress } from "./config-actions";
import {
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from "@solana/web3.js";

// multisigCreateV2, initialize_guard and the compute budget share one transaction (1232 bytes).
export const GUARDED_GROUP_MAX_INVITES = 10;

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
// New members always get Initiate + Vote, never Execute: in a guarded treasury
// the guard executor stays the sole Execute member (guarded_config_execute
// refuses anything else).
export function buildMemberInvitation({
  multisig,
  creator,
  index,
  newMember,
  executor,
}: {
  multisig: PublicKey;
  creator: PublicKey;
  index: bigint;
  newMember: PublicKey;
  executor?: PublicKey;
}) {
  if (!PublicKey.isOnCurve(newMember.toBytes()) || executor?.equals(newMember))
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

// Squads applies member and threshold changes through config transactions.
// In a guarded treasury the guard executor applies them with
// guarded_config_execute, which only accepts voter changes.
export function membershipChangeNote(config: SquadConfig | undefined) {
  return config?.executor && config.executionMode !== "standard"
    ? "Member changes need the members' vote and are checked by the guard."
    : "Member changes need the members' vote, then execution by an authorized member.";
}

type MemberList = Pick<sqds.accounts.Multisig, "members" | "threshold">;
const holds = (
  member: sqds.accounts.Multisig["members"][number],
  permission: sqds.types.Permission,
) => sqds.types.Permissions.has(member.permissions, permission);

// Checks a removal against the Squads invariants (a remaining proposer, voter
// and executor; threshold <= voters). When the threshold would exceed the
// remaining voters, the same proposal lowers it to the voter count.
export function planMemberRemoval(
  squad: MemberList,
  removed: PublicKey,
  executor?: string,
) {
  if (executor && removed.toBase58() === executor)
    throw new Error("The guard executor cannot be removed.");
  if (!squad.members.some((m) => m.key.equals(removed)))
    throw new Error("This wallet is not a member.");
  const remaining = squad.members.filter((m) => !m.key.equals(removed));
  const remainingVoters = remaining.filter((m) =>
    holds(m, sqds.types.Permission.Vote),
  ).length;
  if (
    !remainingVoters ||
    !remaining.some((m) => holds(m, sqds.types.Permission.Initiate))
  )
    throw new Error(
      "At least one remaining member must be able to propose and vote.",
    );
  if (!remaining.some((m) => holds(m, sqds.types.Permission.Execute)))
    throw new Error("At least one remaining member must be able to execute.");
  return {
    remainingVoters,
    newThreshold:
      squad.threshold > remainingVoters ? remainingVoters : undefined,
  };
}
export function buildMemberRemoval({
  squad,
  multisig,
  member,
  removed,
  executor,
}: {
  squad: MemberList &
    Pick<sqds.accounts.Multisig, "transactionIndex" | "configAuthority">;
  multisig: PublicKey;
  member: PublicKey;
  removed: PublicKey;
  executor?: PublicKey;
}) {
  assertConfigProposer(squad, member);
  const { newThreshold } = planMemberRemoval(
    squad,
    removed,
    executor?.toBase58(),
  );
  const index = BigInt(squad.transactionIndex.toString()) + 1n;
  const actions: sqds.types.ConfigAction[] = [
    // Lowered first so the threshold never exceeds the voters at any step.
    ...(newThreshold === undefined
      ? []
      : [{ __kind: "ChangeThreshold" as const, newThreshold }]),
    { __kind: "RemoveMember", oldMember: removed },
  ];
  return {
    index,
    newThreshold,
    instructions: configProposal(multisig, index, member, actions),
  };
}

type ConfigSquad = MemberList &
  Pick<sqds.accounts.Multisig, "transactionIndex" | "configAuthority">;
function assertConfigProposer(squad: ConfigSquad, member: PublicKey) {
  const proposer = squad.members.find((m) => m.key.equals(member));
  if (!proposer || !holds(proposer, sqds.types.Permission.Initiate))
    throw new Error("Your wallet cannot propose configuration changes.");
  if (!squad.configAuthority.equals(SystemProgram.programId))
    throw new Error(
      "Membership changes require the group's existing configuration authority.",
    );
}
function configProposal(
  multisig: PublicKey,
  index: bigint,
  member: PublicKey,
  actions: sqds.types.ConfigAction[],
) {
  return [
    sqds.instructions.configTransactionCreate({
      multisigPda: multisig,
      transactionIndex: index,
      creator: member,
      rentPayer: member,
      actions,
    }),
    sqds.instructions.proposalCreate({
      multisigPda: multisig,
      transactionIndex: index,
      creator: member,
      rentPayer: member,
      isDraft: false,
    }),
  ];
}

// Permissions a member can be given from the Edit dialog. Never Execute: in a
// guarded treasury the guard executor stays the sole Execute member.
export const MEMBER_PERMISSION_CHOICES = [3, 2, 1] as const;

export type MemberEdit = {
  // The member being edited.
  member: PublicKey;
  // Replacement wallet; omitted when only permissions change.
  newWallet?: PublicKey;
  // New permission mask (Initiate 1, Vote 2); omitted to keep the current one.
  permissions?: number;
  executor?: string;
  vault?: string;
  // Display label for the member in the summary (defaults to a short address).
  label?: string;
};

// Plans one config proposal that replaces a member's wallet and/or changes its
// permissions. Squads applies every action and checks its invariants at the
// end, so a wallet replacement is AddMember(new) then RemoveMember(old) and a
// permission change is RemoveMember(wallet) then AddMember(wallet). The same
// rules as planMemberRemoval apply: a remaining proposer and voter (and, in a
// standard group, executor), and the threshold is lowered first when it would
// exceed the voters.
export function planMemberEdit(squad: MemberList, edit: MemberEdit) {
  const { member, newWallet, executor, vault } = edit;
  const address = member.toBase58();
  if (executor && address === executor)
    throw new Error("The guard executor cannot be edited.");
  const current = squad.members.find((m) => m.key.equals(member));
  if (!current) throw new Error("This wallet is not a member.");
  if (newWallet) {
    const wallet = newWallet.toBase58();
    if (executor && wallet === executor)
      throw new Error("The guard executor cannot be a member wallet.");
    if (vault && wallet === vault)
      throw new Error("The treasury vault cannot be a member wallet.");
    if (!PublicKey.isOnCurve(newWallet.toBytes()))
      throw new Error("Enter the new member's Solana wallet address.");
    if (squad.members.some((m) => m.key.equals(newWallet)))
      throw new Error("This wallet is already a member.");
  }
  const changesPermissions =
    edit.permissions !== undefined &&
    edit.permissions !== current.permissions.mask;
  if (
    changesPermissions &&
    !(MEMBER_PERMISSION_CHOICES as readonly number[]).includes(
      edit.permissions!,
    )
  )
    throw new Error("Members can have Initiate and/or Vote, never Execute.");
  if (!newWallet && !changesPermissions) throw new Error("Nothing to change.");
  // A replacement wallet keeps the old permissions, without Execute.
  const mask = changesPermissions
    ? edit.permissions!
    : current.permissions.mask & 3;
  if (!mask)
    throw new Error("Members can have Initiate and/or Vote, never Execute.");
  const after = squad.members.map((m) =>
    m.key.equals(member)
      ? { key: newWallet ?? member, permissions: { mask } }
      : m,
  );
  const voters = after.filter((m) => m.permissions.mask & 2).length;
  if (!voters || !after.some((m) => m.permissions.mask & 1))
    throw new Error(
      "At least one remaining member must be able to propose and vote.",
    );
  if (!executor && !after.some((m) => m.permissions.mask & 4))
    throw new Error("At least one remaining member must be able to execute.");
  const newThreshold = squad.threshold > voters ? voters : undefined;
  const newMember = { key: newWallet ?? member, permissions: { mask } };
  const actions: sqds.types.ConfigAction[] = [
    // Lowered first so the threshold never exceeds the voters at any step.
    ...(newThreshold === undefined
      ? []
      : [{ __kind: "ChangeThreshold" as const, newThreshold }]),
    ...(newWallet
      ? [
          { __kind: "AddMember" as const, newMember },
          { __kind: "RemoveMember" as const, oldMember: member },
        ]
      : [
          { __kind: "RemoveMember" as const, oldMember: member },
          { __kind: "AddMember" as const, newMember },
        ]),
  ];
  const label = edit.label || shortAddress(address);
  const summary = [
    newWallet
      ? `Replace ${label} with ${shortAddress(newWallet.toBase58())} (${permissionChoiceLabel(mask)})`
      : `Change ${label} to ${permissionChoiceLabel(mask)}`,
    ...(newThreshold === undefined
      ? []
      : [`Threshold lowers from ${squad.threshold} to ${newThreshold}`]),
  ];
  return { actions, summary, newThreshold, voters };
}
export function buildMemberEdit({
  squad,
  multisig,
  member,
  edited,
  newWallet,
  permissions,
  executor,
  vaultIndex = 0,
}: {
  squad: ConfigSquad;
  multisig: PublicKey;
  // The proposing wallet.
  member: PublicKey;
  edited: PublicKey;
  newWallet?: PublicKey;
  permissions?: number;
  executor?: PublicKey;
  vaultIndex?: number;
}) {
  assertConfigProposer(squad, member);
  const [vault] = sqds.getVaultPda({
    multisigPda: multisig,
    index: vaultIndex,
  });
  const plan = planMemberEdit(squad, {
    member: edited,
    newWallet,
    permissions,
    executor: executor?.toBase58(),
    vault: vault.toBase58(),
  });
  const index = BigInt(squad.transactionIndex.toString()) + 1n;
  return {
    index,
    plan,
    instructions: configProposal(multisig, index, member, plan.actions),
  };
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
    /** The policy hash the creator chose (hex); initialize_guard must commit to exactly it. */
    policyHash?: string;
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
  if (
    expected.policyHash &&
    data.subarray(72, 104).toString("hex") !== expected.policyHash
  )
    throw new Error("initialize_guard does not commit to the chosen policy.");
  return { config, guardInstruction: ix };
}

/**
 * Per-field validation for the member address inputs of the create-treasury form. Empty fields are
 * ignored; each other field must be a wallet (on-curve) address that is not yours and not repeated.
 */
export function validateMemberInputs(
  values: string[],
  self: string | undefined,
) {
  const seen = new Set<string>();
  const invitees: string[] = [];
  const errors = values.map((raw): string | null => {
    const value = raw.trim();
    if (!value) return null;
    let key: PublicKey;
    try {
      key = new PublicKey(value);
    } catch {
      return "Enter a valid Solana wallet address.";
    }
    if (!PublicKey.isOnCurve(key.toBytes()))
      return "This is not a wallet address (it is a program-derived account).";
    const base58 = key.toBase58();
    if (self && base58 === self)
      return "This is your wallet; it joins automatically.";
    if (seen.has(base58)) return "This wallet is already added.";
    seen.add(base58);
    invitees.push(base58);
    return null;
  });
  return { invitees, errors, valid: errors.every((e) => e === null) };
}

/**
 * Treasury opened when the app loads: an explicit `?group=` link, else the one used last. Never the
 * deployment's own treasury by default: that is the scripts' test treasury (signed by script keys),
 * opened only from an explicit link.
 */
export function initialTreasury(o: {
  link: string | null;
  remembered: string | null;
  deploymentTreasury: string | null | undefined;
}): string | null {
  if (o.link) return o.link;
  if (o.remembered && o.remembered !== o.deploymentTreasury)
    return o.remembered;
  return null;
}
