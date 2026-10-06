import test from "node:test";
import assert from "node:assert/strict";
import * as sqds from "@sqds/multisig";
import { Keypair, PublicKey } from "@solana/web3.js";

const executor = PublicKey.findProgramAddressSync(
  [Buffer.from("test")],
  Keypair.generate().publicKey,
)[0];
import {
  buildGroupCreation,
  buildMemberInvitation,
  memberRole,
  standardGroupConfig,
} from "../src/lib/squads/groups";

test("group creation derives SDK multisig and vault, sets threshold and never grants humans Execute", () => {
  const creator = Keypair.generate().publicKey;
  const createKey = Keypair.generate().publicKey;
  const invitee = Keypair.generate().publicKey;
  const group = buildGroupCreation({
    creator,
    createKey,
    treasury: Keypair.generate().publicKey,
    members: [invitee.toBase58()],
    threshold: 2,
    name: "Desk",
    executor,
  });
  assert.ok(group.multisig.equals(sqds.getMultisigPda({ createKey })[0]));
  assert.ok(
    group.vault.equals(
      sqds.getVaultPda({ multisigPda: group.multisig, index: 0 })[0],
    ),
  );
  const [decoded] = sqds.generated.multisigCreateV2Struct.deserialize(
    group.instruction.data,
  );
  assert.equal(decoded.args.threshold, 2);
  assert.equal(decoded.args.configAuthority, null);
  assert.equal(
    decoded.args.members.filter((m) => m.permissions.mask === 4).length,
    1,
  );
  assert.ok(
    decoded.args.members.every((m) =>
      m.key.equals(executor)
        ? m.permissions.mask === 4
        : m.permissions.mask === 3,
    ),
  );
  assert.throws(
    () =>
      buildGroupCreation({
        creator,
        createKey,
        treasury: invitee,
        members: [creator.toBase58()],
        threshold: 1,
        name: "Desk",
        executor,
      }),
    /duplicate/i,
  );
  assert.throws(
    () =>
      buildGroupCreation({
        creator,
        createKey,
        treasury: invitee,
        members: [],
        threshold: 2,
        name: "Desk",
        executor,
      }),
    /threshold/i,
  );
});
test("member invitations create AddMember governance with propose and vote permissions only", () => {
  const creator = Keypair.generate().publicKey;
  const newMember = Keypair.generate().publicKey;
  const instructions = buildMemberInvitation({
    multisig: Keypair.generate().publicKey,
    creator,
    index: 1n,
    newMember,
  });
  const [decoded] = sqds.generated.configTransactionCreateStruct.deserialize(
    instructions[0].data,
  );
  assert.equal(decoded.args.actions[0].__kind, "AddMember");
  const action = decoded.args.actions[0];
  if (action.__kind === "AddMember")
    assert.equal(action.newMember.permissions.mask, 3);
  assert.equal(instructions.length, 2);
});

test("standard Squads groups let only the creator execute and keep settings controlled by votes", () => {
  const creator = Keypair.generate().publicKey,
    invitee = Keypair.generate().publicKey;
  const group = buildGroupCreation({
    creator,
    createKey: Keypair.generate().publicKey,
    treasury: invitee,
    members: [invitee.toBase58()],
    threshold: 2,
    name: "Team",
  });
  const [decoded] = sqds.generated.multisigCreateV2Struct.deserialize(
    group.instruction.data,
  );
  assert.equal(decoded.args.threshold, 2);
  assert.equal(decoded.args.configAuthority, null);
  assert.equal(decoded.args.members.length, 2);
  assert.equal(
    decoded.args.members.find((m) => m.key.equals(creator))?.permissions.mask,
    7,
  );
  assert.equal(
    decoded.args.members.find((m) => m.key.equals(invitee))?.permissions.mask,
    3,
  );
});

test("standard classification depends on chain executor permissions, not Guard service availability", () => {
  const multisig = Keypair.generate().publicKey.toBase58();
  const humans = [
    { key: Keypair.generate().publicKey, permissions: { mask: 7 } },
    { key: Keypair.generate().publicKey, permissions: { mask: 3 } },
  ];
  assert.equal(
    standardGroupConfig(multisig, humans)?.executionMode,
    "standard",
  );
  assert.equal(
    standardGroupConfig(multisig, [
      ...humans,
      { key: executor, permissions: { mask: 4 } },
    ]),
    null,
  );
  assert.equal(
    standardGroupConfig(multisig, [
      { key: executor, permissions: { mask: 4 } },
    ]),
    null,
  );
});

test("member roles label humans and the guard executor from on-chain permissions", () => {
  const human = Keypair.generate().publicKey.toBase58();
  assert.equal(memberRole(human, 3, executor.toBase58()), "Initiate + Vote");
  assert.equal(
    memberRole(executor.toBase58(), 4, executor.toBase58()),
    "Guard executor (Execute only)",
  );
  assert.equal(memberRole(human, 7), "Initiate + Vote + Execute");
  assert.equal(memberRole(human, 2), "Vote");
  assert.equal(memberRole(human, 0), "No permissions");
  // A configured executor holding extra permissions is not labelled Execute only.
  assert.equal(
    memberRole(executor.toBase58(), 7, executor.toBase58()),
    "Initiate + Vote + Execute",
  );
});
