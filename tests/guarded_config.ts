import * as multisig from "@sqds/multisig";
import {
  ComputeBudgetProgram, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram,
} from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import { expect } from "chai";
import { testProvider } from "./helpers/provider";
import {
  approve, executeRemainingAccounts, payoutIxs, proposePayout, sendWithFreshBlockhash, usdc, SQUADS_PROGRAM_ID,
} from "./helpers/squads";
import { expectError, guardProgram, payer, requestReview } from "./helpers/guard";
import { approvePayload, deliverReport, setupForwardedDesk, type ForwardedDesk } from "./helpers/forwarder";

const { Permission, Permissions } = multisig.types;
const voter = () => Permissions.fromPermissions([Permission.Initiate, Permission.Vote]);

describe("guarded_config_execute", () => {
  const provider = testProvider();
  const connection = provider.connection;
  const program = guardProgram();
  let desk: ForwardedDesk;

  beforeEach(async () => {
    desk = await setupForwardedDesk();
  });

  /** Squads config proposal created and voted by the humans, as the app does. */
  async function proposeConfig(actions: multisig.types.ConfigAction[], votes = 3) {
    const creator = desk.members[0];
    const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, desk.multisigPda, "confirmed");
    const index = BigInt(ms.transactionIndex.toString()) + 1n;
    await sendWithFreshBlockhash(
      connection,
      [
        multisig.instructions.configTransactionCreate({ multisigPda: desk.multisigPda, transactionIndex: index, creator: creator.publicKey, rentPayer: creator.publicKey, actions }),
        multisig.instructions.proposalCreate({ multisigPda: desk.multisigPda, transactionIndex: index, creator: creator.publicKey, rentPayer: creator.publicKey }),
      ],
      [creator],
    );
    if (votes) await approve(connection, desk, index, votes);
    return index;
  }

  function executeConfig(index: bigint, overrides: Record<string, PublicKey> = {}, rentPayer: Keypair = desk.members[0]) {
    const [transaction] = multisig.getTransactionPda({ multisigPda: desk.multisigPda, index });
    const [proposal] = multisig.getProposalPda({ multisigPda: desk.multisigPda, transactionIndex: index });
    return program.methods
      .guardedConfigExecute()
      .accountsPartial({
        config: desk.config, multisig: desk.multisigPda, proposal, configTransaction: transaction, executor: desk.executorPda,
        rentPayer: rentPayer.publicKey, systemProgram: SystemProgram.programId, squadsProgram: SQUADS_PROGRAM_ID,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY, ...overrides,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .signers([rentPayer])
      .rpc({ commitment: "confirmed" });
  }

  const members = async () =>
    new Map(
      (await multisig.accounts.Multisig.fromAccountAddress(connection, desk.multisigPda, "confirmed")).members.map((m) => [m.key.toBase58(), m.permissions.mask]),
    );

  it("adds a voter after the members vote", async () => {
    const newcomer = Keypair.generate().publicKey;
    const index = await proposeConfig([{ __kind: "AddMember", newMember: { key: newcomer, permissions: voter() } }]);
    await executeConfig(index);
    const m = await members();
    expect(m.get(newcomer.toBase58())).to.equal(Permission.Initiate | Permission.Vote);
    expect(m.get(desk.executorPda.toBase58())).to.equal(Permission.Execute);
    const proposal = await multisig.accounts.Proposal.fromAccountAddress(connection, multisig.getProposalPda({ multisigPda: desk.multisigPda, transactionIndex: index })[0], "confirmed");
    expect(proposal.status.__kind).to.equal("Executed");
  });

  it("changes the threshold and removes a voter, and payments still work with the new threshold", async () => {
    const removed = desk.members[2];
    const index = await proposeConfig([
      { __kind: "RemoveMember", oldMember: removed.publicKey },
      { __kind: "ChangeThreshold", newThreshold: 2 },
    ]);
    await executeConfig(index);
    const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, desk.multisigPda, "confirmed");
    expect(ms.threshold).to.equal(2);
    expect((await members()).has(removed.publicKey.toBase58())).to.equal(false);

    // A payment now needs 2 votes plus the guard review.
    const p = await proposePayout(connection, desk, payoutIxs(desk, desk.counterpartyAta, usdc(3)));
    const { review } = await requestReview(desk, p);
    await approve(connection, desk, p.transactionIndex, 2);
    await deliverReport(desk, review, await approvePayload(desk, review));
    const before = (await getAccount(connection, desk.counterpartyAta)).amount;
    await program.methods
      .guardedExecute()
      .accountsPartial({
        config: desk.config, review, multisig: desk.multisigPda, proposal: p.proposalPda, vaultTransaction: p.transactionPda,
        destination: desk.counterpartyAta, executor: desk.executorPda, squadsProgram: SQUADS_PROGRAM_ID, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .remainingAccounts(await executeRemainingAccounts(connection, desk, p.transactionIndex))
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .rpc({ commitment: "confirmed" });
    expect((await getAccount(connection, desk.counterpartyAta)).amount - before).to.equal(usdc(3));
  });

  it("changes a member's permissions in one proposal (remove, then re-add the same wallet)", async () => {
    const target = desk.members[1].publicKey;
    const index = await proposeConfig([
      { __kind: "RemoveMember", oldMember: target },
      { __kind: "AddMember", newMember: { key: target, permissions: Permissions.fromPermissions([Permission.Vote]) } },
    ]);
    await executeConfig(index);
    expect((await members()).get(target.toBase58())).to.equal(Permission.Vote);
  });

  it("replaces a member's wallet in one proposal (add the new wallet, then remove the old one)", async () => {
    const oldWallet = desk.members[2].publicKey;
    const newWallet = Keypair.generate().publicKey;
    const index = await proposeConfig([
      { __kind: "AddMember", newMember: { key: newWallet, permissions: voter() } },
      { __kind: "RemoveMember", oldMember: oldWallet },
    ]);
    await executeConfig(index);
    const m = await members();
    expect(m.has(oldWallet.toBase58())).to.equal(false);
    expect(m.get(newWallet.toBase58())).to.equal(Permission.Initiate | Permission.Vote);
    const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, desk.multisigPda, "confirmed");
    expect(ms.threshold).to.equal(3);
  });

  it("sets the time lock", async () => {
    const index = await proposeConfig([{ __kind: "SetTimeLock", newTimeLock: 0 }]);
    await executeConfig(index);
  });

  it("refuses to add a member with Execute (would bypass the guard)", async () => {
    const index = await proposeConfig([
      { __kind: "AddMember", newMember: { key: Keypair.generate().publicKey, permissions: Permissions.fromPermissions([Permission.Vote, Permission.Execute]) } },
    ]);
    await expectError(executeConfig(index), "ConfigActionNotAllowed");
  });

  it("refuses to remove or re-add the guard executor", async () => {
    await expectError(executeConfig(await proposeConfig([{ __kind: "RemoveMember", oldMember: desk.executorPda }])), "ConfigActionNotAllowed");
  });

  it("refuses spending limits and the rent collector", async () => {
    const limit = await proposeConfig([
      {
        __kind: "AddSpendingLimit", createKey: Keypair.generate().publicKey, vaultIndex: 0, mint: desk.mint, amount: 1_000_000,
        period: multisig.types.Period.OneTime, members: [desk.members[0].publicKey], destinations: [],
      },
    ]);
    await expectError(executeConfig(limit), "ConfigActionNotAllowed");
    const collector = await proposeConfig([{ __kind: "SetRentCollector", newRentCollector: desk.members[0].publicKey }]);
    await expectError(executeConfig(collector), "ConfigActionNotAllowed");
  });

  it("refuses a mix of an allowed and a refused action", async () => {
    const index = await proposeConfig([
      { __kind: "ChangeThreshold", newThreshold: 2 },
      { __kind: "SetRentCollector", newRentCollector: desk.members[0].publicKey },
    ]);
    await expectError(executeConfig(index), "ConfigActionNotAllowed");
  });

  it("does nothing without the members' votes (Squads refuses)", async () => {
    const index = await proposeConfig([{ __kind: "ChangeThreshold", newThreshold: 2 }], 2);
    await expectError(executeConfig(index), "InvalidProposalStatus");
  });

  it("refuses a vault transaction passed as a config transaction", async () => {
    const p = await proposePayout(connection, desk, payoutIxs(desk, desk.counterpartyAta, usdc(1)));
    await approve(connection, desk, p.transactionIndex);
    await expectError(executeConfig(p.transactionIndex), "NotSquadsAccount");
  });

  it("refuses a config transaction of another multisig", async () => {
    const other = await setupForwardedDesk();
    const index = await proposeConfig([{ __kind: "ChangeThreshold", newThreshold: 2 }]);
    const [tx] = multisig.getTransactionPda({ multisigPda: desk.multisigPda, index });
    await expectError(executeConfig(index, { config: other.config, multisig: other.multisigPda, executor: other.executorPda, configTransaction: tx }), "WrongMultisig");
  });

  it("refuses a fake instructions sysvar and a CPI target other than Squads", async () => {
    const index = await proposeConfig([{ __kind: "ChangeThreshold", newThreshold: 2 }]);
    await expectError(executeConfig(index, { instructionsSysvar: SYSVAR_CLOCK_PUBKEY }), "InvalidInstructionsSysvar");
    await expectError(executeConfig(index, { squadsProgram: SystemProgram.programId }), "InvalidSquadsProgram");
  });

  it("humans still cannot execute config transactions directly (Squads refuses on chain)", async () => {
    const index = await proposeConfig([{ __kind: "ChangeThreshold", newThreshold: 2 }]);
    const human = desk.members[0];
    const ix = multisig.instructions.configTransactionExecute({
      multisigPda: desk.multisigPda, transactionIndex: index, member: human.publicKey, rentPayer: human.publicKey,
    });
    await expectError(sendWithFreshBlockhash(connection, [ix], [human]), "Unauthorized");
    const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, desk.multisigPda, "confirmed");
    expect(ms.threshold).to.equal(3);
  });

  it("the caller pays any rent; the executor holds nothing", async () => {
    const index = await proposeConfig([{ __kind: "AddMember", newMember: { key: Keypair.generate().publicKey, permissions: voter() } }]);
    const funder = Keypair.generate();
    await sendWithFreshBlockhash(connection, [SystemProgram.transfer({ fromPubkey: payer().publicKey, toPubkey: funder.publicKey, lamports: 1e9 })], [payer()]);
    await executeConfig(index, {}, funder);
    expect(await connection.getBalance(desk.executorPda)).to.equal(0);
  });
});
