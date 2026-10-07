import * as multisig from "@sqds/multisig";
import {
  ComputeBudgetProgram, Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, TransactionInstruction,
} from "@solana/web3.js";
import { expect } from "chai";
import { encodePolicyChangeMarker, policyChangePda } from "@wysiwys/shared";
import { testProvider } from "./helpers/provider";
import { approve, proposePayout, sendWithFreshBlockhash, SQUADS_PROGRAM_ID, type Proposed } from "./helpers/squads";
import { expectError, guardEvents, guardProgram, POLICY_HASH, randomHash, setupGuardedDesk, type GuardedDesk } from "./helpers/guard";

// Voted policy changes: a Squads proposal whose only instruction is the guard's policy change marker,
// applied by apply_policy_change once approved and past max(time lock, POLICY_CHANGE_MIN_DELAY).
// Tests build the guard with `--features short-policy-delay` (minimum delay 2 s).
const MIN_DELAY_MS = 2_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const { Permission, Permissions } = multisig.types;

describe("apply_policy_change", () => {
  const provider = testProvider();
  const connection = provider.connection;
  const program = guardProgram();
  const payer = () => (provider.wallet as unknown as { payer: Keypair }).payer;

  const markerIx = (newHash: Uint8Array, expectedHash: Uint8Array, programId = program.programId) =>
    new TransactionInstruction({
      programId,
      keys: [],
      data: Buffer.from(encodePolicyChangeMarker({ newPolicyHash: newHash, expectedPolicyHash: expectedHash })),
    });

  const proposeChange = (desk: GuardedDesk, newHash: Uint8Array, expectedHash: Uint8Array = POLICY_HASH) =>
    proposePayout(connection, desk, [markerIx(newHash, expectedHash)]);

  const apply = (desk: GuardedDesk, p: Proposed, overrides: Record<string, PublicKey> = {}) =>
    program.methods
      .applyPolicyChange()
      .accountsPartial({
        config: desk.config,
        multisig: desk.multisigPda,
        proposal: p.proposalPda,
        vaultTransaction: p.transactionPda,
        policyChange: policyChangePda(program.programId, desk.multisigPda, p.transactionIndex),
        payer: payer().publicKey,
        systemProgram: SystemProgram.programId,
        ...overrides,
      })
      .rpc({ commitment: "confirmed" });

  const policyHashOf = async (desk: GuardedDesk) =>
    Uint8Array.from((await program.account.guardConfig.fetch(desk.config, "confirmed")).policyHash);

  it("applies an approved change after the waiting period and records it once", async () => {
    const desk = await setupGuardedDesk();
    const next = randomHash();
    const p = await proposeChange(desk, next);
    await approve(connection, desk, p.transactionIndex);
    await sleep(MIN_DELAY_MS + 1_000);
    const sig = await apply(desk, p);

    expect(Buffer.from(await policyHashOf(desk)).toString("hex")).to.equal(Buffer.from(next).toString("hex"));
    const record = await program.account.policyChange.fetch(policyChangePda(program.programId, desk.multisigPda, p.transactionIndex), "confirmed");
    expect(record.multisig.toBase58()).to.equal(desk.multisigPda.toBase58());
    expect(record.txIndex.toString()).to.equal(p.transactionIndex.toString());
    expect(Buffer.from(record.oldPolicyHash).toString("hex")).to.equal(Buffer.from(POLICY_HASH).toString("hex"));
    expect(Buffer.from(record.newPolicyHash).toString("hex")).to.equal(Buffer.from(next).toString("hex"));
    expect(record.appliedAt.toNumber()).to.be.at.least(record.approvedAt.toNumber() + MIN_DELAY_MS / 1000);
    const events = await guardEvents(sig);
    const changed = events.find((e) => e.name === "policyChanged");
    expect(changed, JSON.stringify(events.map((e) => e.name))).to.not.equal(undefined);
    expect(Buffer.from(changed!.data.newPolicyHash).toString("hex")).to.equal(Buffer.from(next).toString("hex"));

    // The PolicyChange account is the consumed marker: a second apply of the same index fails.
    await expectError(apply(desk, p), "already in use");
  });

  it("waits for the Squads time lock when it is longer than the minimum delay", async () => {
    const desk = await setupGuardedDesk({ desk: { timeLock: 30 } });
    const p = await proposeChange(desk, randomHash());
    await approve(connection, desk, p.transactionIndex);
    await sleep(MIN_DELAY_MS + 1_000);
    await expectError(apply(desk, p), "PolicyChangeTooEarly");
  });

  it("refuses proposals that are not approved: active, rejected, cancelled during the wait", async () => {
    const desk = await setupGuardedDesk({ desk: { timeLock: 30 } });
    const active = await proposeChange(desk, randomHash());
    await approve(connection, desk, active.transactionIndex, 2);
    await expectError(apply(desk, active), "PolicyChangeNotApproved");

    const rejected = await proposeChange(desk, randomHash());
    const rejecter = desk.members[0];
    await sendWithFreshBlockhash(
      connection,
      [multisig.instructions.proposalReject({ multisigPda: desk.multisigPda, transactionIndex: rejected.transactionIndex, member: rejecter.publicKey })],
      [rejecter],
    );
    await expectError(apply(desk, rejected), "PolicyChangeNotApproved");

    const cancelled = await proposeChange(desk, randomHash());
    await approve(connection, desk, cancelled.transactionIndex);
    for (const member of desk.members) {
      await sendWithFreshBlockhash(
        connection,
        [multisig.instructions.proposalCancel({ multisigPda: desk.multisigPda, transactionIndex: cancelled.transactionIndex, member: member.publicKey })],
        [member],
      );
    }
    await expectError(apply(desk, cancelled), "PolicyChangeNotApproved");
  });

  it("refuses a change that went stale after a membership change", async () => {
    const desk = await setupGuardedDesk();
    const p = await proposeChange(desk, randomHash());
    await approve(connection, desk, p.transactionIndex);

    // Members add a voter through the guard; Squads marks earlier transactions stale.
    const creator = desk.members[0];
    const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, desk.multisigPda, "confirmed");
    const index = BigInt(ms.transactionIndex.toString()) + 1n;
    await sendWithFreshBlockhash(
      connection,
      [
        multisig.instructions.configTransactionCreate({
          multisigPda: desk.multisigPda, transactionIndex: index, creator: creator.publicKey, rentPayer: creator.publicKey,
          actions: [{ __kind: "AddMember", newMember: { key: Keypair.generate().publicKey, permissions: Permissions.fromPermissions([Permission.Vote]) } }],
        }),
        multisig.instructions.proposalCreate({ multisigPda: desk.multisigPda, transactionIndex: index, creator: creator.publicKey, rentPayer: creator.publicKey }),
      ],
      [creator],
    );
    await approve(connection, desk, index);
    const [configTransaction] = multisig.getTransactionPda({ multisigPda: desk.multisigPda, index });
    const [proposal] = multisig.getProposalPda({ multisigPda: desk.multisigPda, transactionIndex: index });
    await program.methods
      .guardedConfigExecute()
      .accountsPartial({
        config: desk.config, multisig: desk.multisigPda, proposal, configTransaction, executor: desk.executorPda,
        rentPayer: creator.publicKey, systemProgram: SystemProgram.programId, squadsProgram: SQUADS_PROGRAM_ID,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .signers([creator])
      .rpc({ commitment: "confirmed" });

    await sleep(MIN_DELAY_MS + 1_000);
    await expectError(apply(desk, p), "PolicyChangeStale");
  });

  it("refuses a change written against a policy that is no longer current", async () => {
    const desk = await setupGuardedDesk();
    const first = await proposeChange(desk, randomHash());
    const second = await proposeChange(desk, randomHash()); // also expects POLICY_HASH
    await approve(connection, desk, first.transactionIndex);
    await approve(connection, desk, second.transactionIndex);
    await sleep(MIN_DELAY_MS + 1_000);
    await apply(desk, first);
    await expectError(apply(desk, second), "PolicyChangeOutdated");
  });

  it("refuses anything but a single marker instruction to the guard", async () => {
    const desk = await setupGuardedDesk();
    const cases: TransactionInstruction[][] = [
      [markerIx(randomHash(), POLICY_HASH), markerIx(randomHash(), POLICY_HASH)],
      [markerIx(randomHash(), POLICY_HASH, Keypair.generate().publicKey)],
      [new TransactionInstruction({ ...markerIx(randomHash(), POLICY_HASH), keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false }] })],
      [new TransactionInstruction({ programId: program.programId, keys: [], data: Buffer.concat([Buffer.from(encodePolicyChangeMarker({ newPolicyHash: randomHash(), expectedPolicyHash: POLICY_HASH })), Buffer.from([0])]) })],
    ];
    for (const ixs of cases) {
      const p = await proposePayout(connection, desk, ixs);
      await expectError(apply(desk, p), "InvalidPolicyChange");
    }
  });

  it("refuses another multisig's proposal and accounts not owned by Squads", async () => {
    const desk = await setupGuardedDesk();
    const other = await setupGuardedDesk();
    const foreign = await proposeChange(other, randomHash());
    await expectError(apply(desk, foreign), "WrongMultisig");

    const p = await proposeChange(desk, randomHash());
    await expectError(apply(desk, p, { proposal: payer().publicKey }), "NotSquadsAccount");
    // The PolicyChange seed comes from the vault transaction's bytes, so Anchor may refuse on the seed first.
    await expectError(apply(desk, p, { vaultTransaction: payer().publicKey }), "NotSquadsAccount", "ConstraintSeeds");
  });
});
