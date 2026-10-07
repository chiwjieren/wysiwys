import test from "node:test";
import assert from "node:assert/strict";
import * as sqds from "@sqds/multisig";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  GUARD_REFUSES,
  describeConfigActions,
} from "../src/lib/squads/config-actions";
import {
  buildMemberInvitation,
  buildMemberRemoval,
  membershipChangeNote,
  planMemberRemoval,
} from "../src/lib/squads/groups";
import { executionRoute, guardedConfigGate } from "../src/lib/squads/execution";

const executor = PublicKey.findProgramAddressSync(
  [Buffer.from("executor")],
  Keypair.generate().publicKey,
)[0];
const [alice, bob, carol] = [0, 1, 2].map(() => Keypair.generate().publicKey);
const multisig = Keypair.generate().publicKey;
const guarded = {
  multisig: multisig.toBase58(),
  guardProgram: Keypair.generate().publicKey.toBase58(),
  executor: executor.toBase58(),
  vaultIndex: 0,
  settlementEnabled: true,
  executionMode: "guarded" as const,
};
const standard = {
  multisig: multisig.toBase58(),
  vaultIndex: 0,
  settlementEnabled: false,
  executionMode: "standard" as const,
};
const voter = (key: PublicKey) => ({ key, permissions: { mask: 3 } });
const guardedSquad = {
  members: [
    voter(alice),
    voter(bob),
    voter(carol),
    { key: executor, permissions: { mask: 4 } },
  ],
  threshold: 3,
  timeLock: 0,
  transactionIndex: 7,
  staleTransactionIndex: 0,
  configAuthority: SystemProgram.programId,
};
const decodeActions = (data: Buffer | Uint8Array) =>
  sqds.generated.configTransactionCreateStruct.deserialize(Buffer.from(data))[0]
    .args.actions;

test("config actions the guard executes decode clearly and are not flagged", () => {
  const result = describeConfigActions(
    [
      {
        __kind: "AddMember",
        newMember: { key: carol, permissions: { mask: 3 } },
      },
      {
        __kind: "AddMember",
        newMember: { key: bob, permissions: { mask: 2 } },
      },
      { __kind: "RemoveMember", oldMember: alice },
      { __kind: "ChangeThreshold", newThreshold: 2 },
      { __kind: "SetTimeLock", newTimeLock: 3600 },
      { __kind: "SetTimeLock", newTimeLock: 0 },
    ],
    executor.toBase58(),
  );
  assert.equal(result.supported, true);
  assert.equal(result.refused, false);
  assert.deepEqual(
    result.lines.map((l) => l.text),
    [
      `Add member ${carol.toBase58()} with propose and vote permissions.`,
      `Add member ${bob.toBase58()} with vote permission.`,
      `Remove member ${alice.toBase58()}.`,
      "Change required approvals to 2.",
      "Set the time lock to 3600 seconds.",
      "Remove the time lock.",
    ],
  );
  assert.ok(result.lines.every((l) => !l.refused && l.label));
});

test("config actions the guard refuses are flagged", () => {
  const cases: sqds.types.ConfigAction[] = [
    {
      __kind: "AddMember",
      newMember: { key: carol, permissions: { mask: 7 } },
    },
    {
      __kind: "AddMember",
      newMember: { key: carol, permissions: { mask: 4 } },
    },
    {
      __kind: "AddMember",
      newMember: { key: carol, permissions: { mask: 0 } },
    },
    {
      __kind: "AddMember",
      newMember: { key: executor, permissions: { mask: 3 } },
    },
    { __kind: "RemoveMember", oldMember: executor },
    {
      __kind: "AddSpendingLimit",
      createKey: alice,
      vaultIndex: 0,
      mint: PublicKey.default,
      amount: 1,
      period: sqds.types.Period.OneTime,
      members: [alice],
      destinations: [],
    },
    { __kind: "RemoveSpendingLimit", spendingLimit: alice },
    { __kind: "SetRentCollector", newRentCollector: alice },
  ];
  for (const action of cases) {
    const result = describeConfigActions(
      [{ __kind: "ChangeThreshold", newThreshold: 2 }, action],
      executor.toBase58(),
    );
    assert.equal(result.refused, true, action.__kind);
    assert.equal(result.supported, false, action.__kind);
    assert.equal(result.lines[0].refused, false);
    assert.equal(result.lines[1].refused, true);
    assert.equal(result.lines[1].reason, GUARD_REFUSES);
  }
  assert.equal(GUARD_REFUSES, "The guard will refuse this change");
  assert.equal(describeConfigActions([], executor.toBase58()).supported, false);
});

test("standard groups decode the same actions without guard refusals", () => {
  const execute = describeConfigActions([
    {
      __kind: "AddMember",
      newMember: { key: carol, permissions: { mask: 7 } },
    },
  ]);
  assert.equal(execute.refused, false);
  assert.equal(execute.supported, true);
  assert.match(execute.lines[0].text, /propose, vote and execute/);
  const spending = describeConfigActions([
    { __kind: "RemoveSpendingLimit", spendingLimit: alice },
  ]);
  assert.equal(spending.refused, false);
  assert.equal(spending.supported, false);
});

test("guarded invitations grant Initiate and Vote only and never the executor", () => {
  const instructions = buildMemberInvitation({
    multisig,
    creator: alice,
    index: 8n,
    newMember: carol,
    executor,
  });
  const [action] = decodeActions(instructions[0].data);
  assert.equal(action.__kind, "AddMember");
  if (action.__kind === "AddMember") {
    assert.equal(action.newMember.permissions.mask, 3);
    assert.equal(
      sqds.types.Permissions.has(
        action.newMember.permissions,
        sqds.types.Permission.Execute,
      ),
      false,
    );
  }
  assert.equal(
    describeConfigActions(
      decodeActions(instructions[0].data),
      executor.toBase58(),
    ).refused,
    false,
  );
  assert.throws(
    () =>
      buildMemberInvitation({
        multisig,
        creator: alice,
        index: 8n,
        newMember: executor,
        executor,
      }),
    /wallet address/,
  );
});

test("member removal keeps the threshold within the remaining voters", () => {
  assert.deepEqual(
    planMemberRemoval(guardedSquad, carol, executor.toBase58()),
    {
      remainingVoters: 2,
      newThreshold: 2,
    },
  );
  assert.deepEqual(
    planMemberRemoval(
      { ...guardedSquad, threshold: 2 },
      carol,
      executor.toBase58(),
    ),
    { remainingVoters: 2, newThreshold: undefined },
  );
  assert.throws(
    () => planMemberRemoval(guardedSquad, executor, executor.toBase58()),
    /guard executor cannot be removed/,
  );
  assert.throws(
    () =>
      planMemberRemoval(
        guardedSquad,
        Keypair.generate().publicKey,
        executor.toBase58(),
      ),
    /not a member/,
  );
  assert.throws(
    () =>
      planMemberRemoval(
        {
          ...guardedSquad,
          members: [voter(alice), { key: executor, permissions: { mask: 4 } }],
          threshold: 1,
        },
        alice,
        executor.toBase58(),
      ),
    /At least one/,
  );
  // A standard group needs a remaining member with Execute.
  assert.throws(
    () =>
      planMemberRemoval(
        {
          members: [{ key: alice, permissions: { mask: 7 } }, voter(bob)],
          threshold: 1,
        },
        alice,
      ),
    /execute/,
  );

  const removal = buildMemberRemoval({
    squad: guardedSquad,
    multisig,
    member: alice,
    removed: carol,
    executor,
  });
  assert.equal(removal.index, 8n);
  assert.equal(removal.newThreshold, 2);
  assert.equal(removal.instructions.length, 2);
  const actions = decodeActions(removal.instructions[0].data);
  assert.deepEqual(
    actions.map((a) => a.__kind),
    ["ChangeThreshold", "RemoveMember"],
  );
  assert.equal(
    describeConfigActions(actions, executor.toBase58()).refused,
    false,
  );
  assert.throws(
    () =>
      buildMemberRemoval({
        squad: {
          ...guardedSquad,
          members: [
            voter(alice),
            { key: bob, permissions: { mask: 2 } },
            voter(carol),
            { key: executor, permissions: { mask: 4 } },
          ],
        },
        multisig,
        member: bob,
        removed: carol,
        executor,
      }),
    /cannot propose/,
  );
});

test("guarded membership changes are open and described as checked by the guard", () => {
  assert.equal(
    membershipChangeNote(guarded),
    "Member changes need the members' vote and are checked by the guard.",
  );
  assert.match(membershipChangeNote(standard), /authorized member/);
});

test("execute routing: guarded config uses configExecute, guarded vault uses execute, standard is direct", () => {
  assert.equal(executionRoute(guarded, "config"), "configExecute");
  assert.equal(executionRoute(guarded, "vault"), "execute");
  assert.equal(executionRoute(standard, "config"), "standard");
  assert.equal(executionRoute(standard, "vault"), "standard");
  assert.throws(() => executionRoute(guarded, "batch"), /cannot be executed/);
  assert.throws(
    () => executionRoute(guarded, "archived"),
    /cannot be executed/,
  );
  // A guard executor without standard mode never falls back to direct execution.
  assert.equal(
    executionRoute({ ...guarded, executionMode: undefined }, "config"),
    "configExecute",
  );
});

test("guarded config execution waits for an Approved, current proposal and its time lock", () => {
  const approved = { __kind: "Approved" as const, timestamp: 100 };
  const proposal = (status: sqds.accounts.Proposal["status"], index = 5) => ({
    status,
    transactionIndex: index,
  });
  assert.deepEqual(guardedConfigGate(guardedSquad, proposal(approved), 100), {
    enabled: true,
    reason: "",
  });
  assert.match(
    guardedConfigGate(
      guardedSquad,
      proposal({ __kind: "Active", timestamp: 1 }),
      100,
    ).reason,
    /member approvals/,
  );
  assert.match(
    guardedConfigGate(
      guardedSquad,
      proposal({ __kind: "Executed", timestamp: 1 }),
      100,
    ).reason,
    /Already executed/,
  );
  assert.match(
    guardedConfigGate(
      { ...guardedSquad, staleTransactionIndex: 5 },
      proposal(approved),
      100,
    ).reason,
    /stale/,
  );
  assert.match(
    guardedConfigGate(
      { ...guardedSquad, timeLock: 60 },
      proposal(approved),
      159,
    ).reason,
    /time lock/,
  );
  assert.equal(
    guardedConfigGate(
      { ...guardedSquad, timeLock: 60 },
      proposal(approved),
      160,
    ).enabled,
    true,
  );
});
