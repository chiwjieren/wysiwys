import test from "node:test";
import assert from "node:assert/strict";
import * as sqds from "@sqds/multisig";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  describeConfigActions,
  permissionChoiceLabel,
  shortAddress,
} from "../src/lib/squads/config-actions";
import { buildMemberEdit, planMemberEdit } from "../src/lib/squads/groups";
import {
  MEMBER_NAMES_KEY,
  memberDisplayName,
  readMemberNames,
  saveMemberName,
} from "../src/lib/squads/member-names";

const executor = PublicKey.findProgramAddressSync(
  [Buffer.from("executor")],
  Keypair.generate().publicKey,
)[0];
const [alice, bob, carol, dave] = [0, 1, 2, 3].map(
  () => Keypair.generate().publicKey,
);
const multisig = Keypair.generate().publicKey;
const [vault] = sqds.getVaultPda({ multisigPda: multisig, index: 0 });
const member = (key: PublicKey, mask: number) => ({
  key,
  permissions: { mask },
});
const guardedSquad = {
  members: [
    member(alice, 3),
    member(bob, 3),
    member(carol, 3),
    member(executor, 4),
  ],
  threshold: 3,
  transactionIndex: 7,
  configAuthority: SystemProgram.programId,
};
const ex = executor.toBase58();
const decodeActions = (data: Buffer | Uint8Array) =>
  sqds.generated.configTransactionCreateStruct.deserialize(Buffer.from(data))[0]
    .args.actions;
const kinds = (actions: sqds.types.ConfigAction[]) =>
  actions.map((a) =>
    a.__kind === "AddMember"
      ? `Add ${a.newMember.key.toBase58()} ${a.newMember.permissions.mask}`
      : a.__kind === "RemoveMember"
        ? `Remove ${a.oldMember.toBase58()}`
        : a.__kind === "ChangeThreshold"
          ? `Threshold ${a.newThreshold}`
          : a.__kind,
  );

test("replacing a wallet adds the new wallet with the same permissions, then removes the old", () => {
  const plan = planMemberEdit(guardedSquad, {
    member: carol,
    newWallet: dave,
    executor: ex,
    vault: vault.toBase58(),
  });
  assert.deepEqual(kinds(plan.actions), [
    `Add ${dave.toBase58()} 3`,
    `Remove ${carol.toBase58()}`,
  ]);
  assert.equal(plan.newThreshold, undefined);
  assert.deepEqual(plan.summary, [
    `Replace ${shortAddress(carol.toBase58())} with ${shortAddress(dave.toBase58())} (Initiate + Vote)`,
  ]);
  // A Vote-only member is replaced by a Vote-only wallet.
  const voteOnly = planMemberEdit(
    {
      ...guardedSquad,
      members: [...guardedSquad.members.slice(0, 2), member(carol, 2)],
      threshold: 2,
    },
    { member: carol, newWallet: dave, executor: ex },
  );
  assert.deepEqual(kinds(voteOnly.actions), [
    `Add ${dave.toBase58()} 2`,
    `Remove ${carol.toBase58()}`,
  ]);
});

test("replacing never copies Execute and keeps a standard group executable", () => {
  const standardSquad = {
    members: [member(alice, 7), member(bob, 7), member(carol, 3)],
    threshold: 2,
  };
  const plan = planMemberEdit(standardSquad, {
    member: alice,
    newWallet: dave,
  });
  assert.deepEqual(kinds(plan.actions), [
    `Add ${dave.toBase58()} 3`,
    `Remove ${alice.toBase58()}`,
  ]);
  assert.throws(
    () =>
      planMemberEdit(
        { members: [member(alice, 7), member(carol, 3)], threshold: 1 },
        { member: alice, newWallet: dave },
      ),
    /able to execute/,
  );
});

test("changing permissions removes then re-adds the same wallet", () => {
  const plan = planMemberEdit(
    { ...guardedSquad, threshold: 2 },
    { member: carol, permissions: 1, executor: ex, label: "Member 3" },
  );
  assert.deepEqual(kinds(plan.actions), [
    `Remove ${carol.toBase58()}`,
    `Add ${carol.toBase58()} 1`,
  ]);
  assert.equal(plan.newThreshold, undefined);
  assert.deepEqual(plan.summary, ["Change Member 3 to Initiate only"]);
  const voteOnly = planMemberEdit(guardedSquad, {
    member: carol,
    permissions: 2,
    executor: ex,
  });
  assert.deepEqual(voteOnly.summary, [
    `Change ${shortAddress(carol.toBase58())} to Vote only`,
  ]);
  assert.equal(voteOnly.newThreshold, undefined);
});

test("a permission change that leaves fewer voters lowers the threshold first", () => {
  const plan = planMemberEdit(guardedSquad, {
    member: carol,
    permissions: 1,
    executor: ex,
    label: "Member 3",
  });
  assert.equal(plan.newThreshold, 2);
  assert.deepEqual(kinds(plan.actions), [
    "Threshold 2",
    `Remove ${carol.toBase58()}`,
    `Add ${carol.toBase58()} 1`,
  ]);
  assert.deepEqual(plan.summary, [
    "Change Member 3 to Initiate only",
    "Threshold lowers from 3 to 2",
  ]);
});

test("changing both wallet and permissions builds one add then remove", () => {
  const plan = planMemberEdit(guardedSquad, {
    member: carol,
    newWallet: dave,
    permissions: 2,
    executor: ex,
  });
  assert.deepEqual(kinds(plan.actions), [
    `Add ${dave.toBase58()} 2`,
    `Remove ${carol.toBase58()}`,
  ]);
  assert.deepEqual(plan.summary, [
    `Replace ${shortAddress(carol.toBase58())} with ${shortAddress(dave.toBase58())} (Vote only)`,
  ]);
});

test("member edits refuse the executor, Execute, existing members, off-curve wallets and leaving no proposer or voter", () => {
  const edit = (input: Partial<Parameters<typeof planMemberEdit>[1]>) =>
    planMemberEdit(guardedSquad, {
      member: carol,
      executor: ex,
      vault: vault.toBase58(),
      ...input,
    });
  assert.throws(
    () => edit({ member: executor, permissions: 3 }),
    /guard executor cannot be edited/,
  );
  assert.throws(() => edit({ newWallet: executor }), /guard executor/);
  assert.throws(() => edit({ newWallet: vault }), /vault/);
  assert.throws(
    () => edit({ newWallet: Keypair.generate().publicKey, permissions: 7 }),
    /never Execute/,
  );
  assert.throws(() => edit({ permissions: 4 }), /never Execute/);
  assert.throws(() => edit({ permissions: 0 }), /never Execute/);
  assert.throws(() => edit({ newWallet: bob }), /already a member/);
  assert.throws(() => edit({ newWallet: carol }), /already a member/);
  const offCurve = PublicKey.findProgramAddressSync(
    [Buffer.from("x")],
    SystemProgram.programId,
  )[0];
  assert.throws(() => edit({ newWallet: offCurve }), /wallet address/);
  assert.throws(
    () => edit({ member: Keypair.generate().publicKey, permissions: 2 }),
    /not a member/,
  );
  assert.throws(() => edit({}), /Nothing to change/);
  assert.throws(() => edit({ permissions: 3 }), /Nothing to change/);
  const solo = {
    members: [member(alice, 3), member(bob, 2), member(executor, 4)],
    threshold: 1,
  };
  assert.throws(
    () => planMemberEdit(solo, { member: alice, permissions: 2, executor: ex }),
    /propose and vote/,
  );
  assert.throws(
    () =>
      planMemberEdit(
        { members: [member(alice, 3), member(executor, 4)], threshold: 1 },
        { member: alice, permissions: 1, executor: ex },
      ),
    /propose and vote/,
  );
});

test("buildMemberEdit creates one config transaction and its proposal", () => {
  const edit = buildMemberEdit({
    squad: guardedSquad,
    multisig,
    member: alice,
    edited: carol,
    permissions: 1,
    executor,
  });
  assert.equal(edit.index, 8n);
  assert.equal(edit.instructions.length, 2);
  const actions = decodeActions(edit.instructions[0].data);
  assert.deepEqual(kinds(actions), [
    "Threshold 2",
    `Remove ${carol.toBase58()}`,
    `Add ${carol.toBase58()} 1`,
  ]);
  assert.equal(describeConfigActions(actions, ex).refused, false);
  assert.ok(edit.instructions[1].programId.equals(sqds.PROGRAM_ID));
  // The vault of the group is refused as a member wallet.
  assert.throws(
    () =>
      buildMemberEdit({
        squad: guardedSquad,
        multisig,
        member: alice,
        edited: carol,
        newWallet: vault,
        executor,
      }),
    /vault/,
  );
  assert.throws(
    () =>
      buildMemberEdit({
        squad: {
          ...guardedSquad,
          members: [member(alice, 2), ...guardedSquad.members.slice(1)],
        },
        multisig,
        member: alice,
        edited: carol,
        permissions: 2,
        executor,
      }),
    /cannot propose/,
  );
});

test("review screen describes member edits in plain English", () => {
  const change = describeConfigActions(
    [
      { __kind: "ChangeThreshold", newThreshold: 2 },
      { __kind: "RemoveMember", oldMember: carol },
      {
        __kind: "AddMember",
        newMember: { key: carol, permissions: { mask: 2 } },
      },
    ],
    ex,
  );
  assert.equal(
    change.headline?.text,
    `Change permissions of ${carol.toBase58()} to Vote only.`,
  );
  assert.equal(change.listLabel, "Change permissions, Set threshold to 2");
  assert.equal(change.lines.length, 3);

  const replace = describeConfigActions(
    [
      {
        __kind: "AddMember",
        newMember: { key: dave, permissions: { mask: 3 } },
      },
      { __kind: "RemoveMember", oldMember: carol },
    ],
    ex,
  );
  assert.equal(
    replace.headline?.text,
    `Replace ${carol.toBase58()} with ${dave.toBase58()} (Initiate + Vote).`,
  );
  assert.equal(replace.listLabel, "Replace member");

  // Unrelated actions keep the per-action labels and no headline.
  const plain = describeConfigActions(
    [
      {
        __kind: "AddMember",
        newMember: { key: dave, permissions: { mask: 3 } },
      },
      { __kind: "ChangeThreshold", newThreshold: 2 },
    ],
    ex,
  );
  assert.equal(plain.headline, undefined);
  assert.equal(plain.listLabel, "Add member, Set threshold to 2");

  // A refused action is never summarised away.
  const refused = describeConfigActions(
    [
      { __kind: "RemoveMember", oldMember: carol },
      {
        __kind: "AddMember",
        newMember: { key: carol, permissions: { mask: 7 } },
      },
    ],
    ex,
  );
  assert.equal(refused.headline, undefined);
  assert.equal(refused.listLabel, "Remove member, Add member (guard refuses)");

  assert.equal(permissionChoiceLabel(3), "Initiate + Vote");
  assert.equal(permissionChoiceLabel(2), "Vote only");
  assert.equal(permissionChoiceLabel(1), "Initiate only");
  assert.equal(permissionChoiceLabel(7), "Initiate + Vote + Execute");
});

function memoryStore(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key: string) => (key in data ? data[key] : null),
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
  };
}

test("member names are stored per treasury and wallet in this browser", () => {
  const store = memoryStore();
  const g1 = multisig.toBase58();
  const g2 = Keypair.generate().publicKey.toBase58();
  assert.deepEqual(readMemberNames(store, g1), {});
  saveMemberName(store, g1, alice.toBase58(), "  Alice Ops  ");
  saveMemberName(store, g2, alice.toBase58(), "Other desk");
  assert.deepEqual(readMemberNames(store, g1), {
    [alice.toBase58()]: "Alice Ops",
  });
  assert.equal(readMemberNames(store, g2)[alice.toBase58()], "Other desk");
  assert.ok(MEMBER_NAMES_KEY in store.data);
  assert.equal(MEMBER_NAMES_KEY, "wysiwys.memberNames");
  // Empty clears the name; long names are capped.
  saveMemberName(store, g1, alice.toBase58(), " ");
  assert.deepEqual(readMemberNames(store, g1), {});
  saveMemberName(store, g1, bob.toBase58(), "x".repeat(100));
  assert.equal(readMemberNames(store, g1)[bob.toBase58()].length, 40);
  // Corrupt or unavailable storage reads as empty.
  assert.deepEqual(
    readMemberNames(memoryStore({ [MEMBER_NAMES_KEY]: "{" }), g1),
    {},
  );
  assert.deepEqual(
    readMemberNames(
      {
        getItem: () => {
          throw new Error("blocked");
        },
      },
      g1,
    ),
    {},
  );
});

test("member display names use the saved name and keep the You marker", () => {
  const names = { [alice.toBase58()]: "Alice Ops" };
  assert.equal(
    memberDisplayName(alice.toBase58(), 0, names, bob.toBase58()),
    "Alice Ops",
  );
  assert.equal(
    memberDisplayName(bob.toBase58(), 1, names, bob.toBase58()),
    "Your wallet · You",
  );
  assert.equal(
    memberDisplayName(alice.toBase58(), 0, names, alice.toBase58()),
    "Alice Ops · You",
  );
  assert.equal(
    memberDisplayName(carol.toBase58(), 2, names, bob.toBase58()),
    "Member 3",
  );
});
