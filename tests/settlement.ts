import * as multisig from "@sqds/multisig";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionMessage, type TransactionInstruction } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import { expect } from "chai";
import { createSettlement, toWire, type Settlement } from "../services/runner/src/settlement";
import { testProvider } from "./helpers/provider";
import { approve, driftStyleIxs, payoutIxs, sendWithFreshBlockhash, usdc } from "./helpers/squads";
import { expectError, guardProgram, statusOf } from "./helpers/guard";
import { approvePayload, deliverReport, setupForwardedDesk, type ForwardedDesk } from "./helpers/forwarder";
import { VERDICT } from "@wysiwys/shared";

const GUARD_SETUP = {
  forwarderProgram: Keypair.generate().publicKey.toBase58(),
  forwarderState: Keypair.generate().publicKey.toBase58(),
  policyHash: "07".repeat(32),
  workflowOwner: "11".repeat(20),
  maxReviewLifetime: "3600",
  reviewDeadlineSecs: "900",
};
const TOKEN = { mint: "J7oqTXmkvHY6E95gD9GBud4N9opBVjjeF1TuMfYiCa1r", symbol: "mUSD", decimals: 6 };

// The app proposes, requests review and executes with instructions the runner prepares.
describe("runner settlement endpoints (instruction builders)", () => {
  const provider = testProvider();
  const connection = provider.connection;
  const program = guardProgram();
  let desk: ForwardedDesk;
  let settlement: Settlement;

  before(async () => {
    desk = await setupForwardedDesk();
    settlement = createSettlement({ connection, programId: program.programId, guardSetup: GUARD_SETUP, token: TOKEN });
  });

  const member = () => desk.members[0];
  const ids = (txIndex: bigint) => ({ multisig: desk.multisigPda.toBase58(), txIndex: txIndex.toString(), member: member().publicKey.toBase58() });

  /** What the app does: vaultTransactionCreate + proposalCreate + runner's request_review, one transaction signed by the member. */
  async function propose(ixs: TransactionInstruction[]) {
    const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, desk.multisigPda, "confirmed");
    const txIndex = BigInt(ms.transactionIndex.toString()) + 1n;
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({ payerKey: desk.vaultPda, recentBlockhash: blockhash, instructions: ixs });
    const requestReview = await settlement.requestReview(ids(txIndex));
    await sendWithFreshBlockhash(
      connection,
      [
        multisig.instructions.vaultTransactionCreate({
          multisigPda: desk.multisigPda, transactionIndex: txIndex, creator: member().publicKey, rentPayer: member().publicKey,
          vaultIndex: 0, ephemeralSigners: 0, transactionMessage: message,
        }),
        multisig.instructions.proposalCreate({
          multisigPda: desk.multisigPda, transactionIndex: txIndex, creator: member().publicKey, rentPayer: member().publicKey,
        }),
        requestReview,
      ],
      [member()],
    );
    const [review] = PublicKey.findProgramAddressSync(
      [Buffer.from("review"), desk.multisigPda.toBuffer(), Buffer.from(new BigUint64Array([txIndex]).buffer)],
      program.programId,
    );
    return { txIndex, review };
  }

  async function execute(txIndex: bigint) {
    const ix = await settlement.guardedExecute(ids(txIndex));
    return sendWithFreshBlockhash(connection, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix], [member()]);
  }

  it("request_review from the runner creates a Pending review in the same transaction as the proposal", async () => {
    const { review } = await propose(payoutIxs(desk, desk.counterpartyAta, usdc(1)));
    expect(statusOf(await program.account.review.fetch(review, "confirmed"))).to.equal("pending");
  });

  it("request_review only lets the member sign and names the proposal accounts", async () => {
    const ix = await settlement.requestReview(ids(5n));
    expect(ix.programId.toBase58()).to.equal(program.programId.toBase58());
    expect(ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).to.deep.equal([member().publicKey.toBase58(), member().publicKey.toBase58()]);
    const [tx] = multisig.getTransactionPda({ multisigPda: desk.multisigPda, index: 5n });
    const [proposal] = multisig.getProposalPda({ multisigPda: desk.multisigPda, transactionIndex: 5n });
    for (const k of [desk.multisigPda, tx, proposal]) expect(ix.keys.some((m) => m.pubkey.equals(k))).to.equal(true);
  });

  it("guarded_execute from the runner pays an approved, voted payment", async () => {
    const amount = usdc(250);
    const { txIndex, review } = await propose(payoutIxs(desk, desk.counterpartyAta, amount));
    await approve(connection, desk, txIndex);
    await deliverReport(desk, review, await approvePayload(desk, review));
    const before = (await getAccount(connection, desk.counterpartyAta)).amount;
    await execute(txIndex);
    expect((await getAccount(connection, desk.counterpartyAta)).amount - before).to.equal(amount);
    expect(statusOf(await program.account.review.fetch(review, "confirmed"))).to.equal("executed");
  });

  it("guarded_execute is refused before the review is approved", async () => {
    const { txIndex } = await propose(payoutIxs(desk, desk.counterpartyAta, usdc(1)));
    await expectError(settlement.guardedExecute(ids(txIndex)), "not approved");
  });

  it("guarded_execute is refused for a rejected review", async () => {
    const { txIndex, review } = await propose(payoutIxs(desk, desk.counterpartyAta, usdc(1)));
    await deliverReport(desk, review, await approvePayload(desk, review, { verdict: VERDICT.REJECT, reason: 8 }));
    await expectError(settlement.guardedExecute(ids(txIndex)), "not approved");
  });

  it("guarded_execute refuses a stored transaction that is not exactly one supported payment", async () => {
    const { txIndex, review } = await propose(driftStyleIxs(desk, usdc(1)));
    // Even with a (wrongly) approving report, the runner will not prepare execution of a multi-instruction payload.
    await deliverReport(desk, review, await approvePayload(desk, review));
    await expectError(settlement.guardedExecute(ids(txIndex)), "supported payment");
  });

  it("SOL transfers use the recipient wallet as the destination", async () => {
    const to = Keypair.generate().publicKey;
    const { txIndex } = await propose([SystemProgram.transfer({ fromPubkey: desk.vaultPda, toPubkey: to, lamports: 1_000 })]);
    const prepared = await settlement.destinationOf(desk.multisigPda.toBase58(), txIndex.toString());
    expect(prepared).to.deep.equal({ kind: "sol", destination: to.toBase58() });
  });

  it("group lookup reports guarded groups and nothing else", async () => {
    const g = await settlement.guardedGroup(desk.multisigPda.toBase58());
    expect(g).to.deep.equal({
      multisig: desk.multisigPda.toBase58(),
      programId: program.programId.toBase58(),
      executorPda: desk.executorPda.toBase58(),
      vaultIndex: 0,
      guardReady: true,
      token: TOKEN,
    });
    expect(await settlement.guardedGroup(Keypair.generate().publicKey.toBase58())).to.equal(null);
  });

  it("toWire produces the app's wire format", async () => {
    const w = toWire(await settlement.requestReview(ids(5n)));
    expect(w.programId).to.equal(program.programId.toBase58());
    expect(Buffer.from(w.data, "base64").length).to.equal(8);
    expect(w.keys[0]).to.have.keys(["pubkey", "isSigner", "isWritable"]);
  });

  it("creates a guarded treasury from the UI: multisigCreateV2 + runner-built initialize_guard in one transaction", async () => {
    const creator = Keypair.generate();
    await sendWithFreshBlockhash(connection, [SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: creator.publicKey, lamports: 1e9 })], [(provider.wallet as any).payer]);
    const createKey = Keypair.generate();
    const [ms] = multisig.getMultisigPda({ createKey: createKey.publicKey });
    const others = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    const prepared = await settlement.prepareGuardedGroup({ multisig: ms.toBase58(), creator: creator.publicKey.toBase58(), createKey: createKey.publicKey.toBase58() });
    expect(prepared.guardReady).to.equal(false);
    expect(prepared.token).to.deep.equal(TOKEN);
    const executor = new PublicKey(prepared.executorPda);
    const ix = prepared.instruction;
    expect(ix.keys.map((k) => [k.isSigner, k.isWritable])).to.deep.equal([[false, false], [true, false], [false, true], [false, false], [true, true], [false, false]]);
    expect(ix.keys[1]!.pubkey.toBase58()).to.equal(createKey.publicKey.toBase58());
    expect(ix.keys[4]!.pubkey.toBase58()).to.equal(creator.publicKey.toBase58());
    const [programConfigPda] = multisig.getProgramConfigPda({});
    const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(connection, programConfigPda);
    const { Permission, Permissions } = multisig.types;
    await sendWithFreshBlockhash(
      connection,
      [
        multisig.instructions.multisigCreateV2({
          treasury: programConfig.treasury, creator: creator.publicKey, multisigPda: ms, configAuthority: null, threshold: 3, timeLock: 0,
          createKey: createKey.publicKey, rentCollector: null,
          members: [
            ...[creator.publicKey, ...others].map((key) => ({ key, permissions: Permissions.fromPermissions([Permission.Initiate, Permission.Vote]) })),
            { key: executor, permissions: Permissions.fromPermissions([Permission.Execute]) },
          ],
        }),
        ix,
      ],
      [creator, createKey],
    );
    const cfg = await program.account.guardConfig.fetch(PublicKey.findProgramAddressSync([Buffer.from("config"), ms.toBuffer()], program.programId)[0]);
    expect(cfg.forwarderProgram.toBase58()).to.equal(GUARD_SETUP.forwarderProgram);
    expect(Buffer.from(cfg.policyHash).toString("hex")).to.equal(GUARD_SETUP.policyHash);
    expect(cfg.reviewDeadlineSecs.toString()).to.equal("900");
    expect((await settlement.guardedGroup(ms.toBase58()))?.guardReady).to.equal(true);
    // A second prepare for the same treasury is refused: the config already exists.
    await expectError(settlement.prepareGuardedGroup({ multisig: ms.toBase58(), creator: creator.publicKey.toBase58(), createKey: createKey.publicKey.toBase58() }), "already");
  });

  it("refuses to prepare a guard config for a multisig that the create key does not derive", async () => {
    const createKey = Keypair.generate();
    await expectError(
      settlement.prepareGuardedGroup({ multisig: Keypair.generate().publicKey.toBase58(), creator: Keypair.generate().publicKey.toBase58(), createKey: createKey.publicKey.toBase58() }),
      "create key",
    );
  });

  it("refuses to prepare when the runner has no guard values", async () => {
    const bare = createSettlement({ connection, programId: program.programId });
    const createKey = Keypair.generate();
    const [ms] = multisig.getMultisigPda({ createKey: createKey.publicKey });
    await expectError(bare.prepareGuardedGroup({ multisig: ms.toBase58(), creator: Keypair.generate().publicKey.toBase58(), createKey: createKey.publicKey.toBase58() }), "not configured");
  });

  it("guarded_config_execute from the runner adds a voter after the members vote", async () => {
    const creator = desk.members[0];
    const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, desk.multisigPda, "confirmed");
    const index = BigInt(ms.transactionIndex.toString()) + 1n;
    const newcomer = Keypair.generate().publicKey;
    const { Permission, Permissions } = multisig.types;
    await sendWithFreshBlockhash(
      connection,
      [
        multisig.instructions.configTransactionCreate({
          multisigPda: desk.multisigPda, transactionIndex: index, creator: creator.publicKey, rentPayer: creator.publicKey,
          actions: [{ __kind: "AddMember", newMember: { key: newcomer, permissions: Permissions.fromPermissions([Permission.Initiate, Permission.Vote]) } }],
        }),
        multisig.instructions.proposalCreate({ multisigPda: desk.multisigPda, transactionIndex: index, creator: creator.publicKey, rentPayer: creator.publicKey }),
      ],
      [creator],
    );
    await approve(connection, desk, index);
    const ix = await settlement.guardedConfigExecute(ids(index));
    expect(ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).to.deep.equal([creator.publicKey.toBase58()]);
    await sendWithFreshBlockhash(connection, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix], [creator]);
    const after = await multisig.accounts.Multisig.fromAccountAddress(connection, desk.multisigPda, "confirmed");
    expect(after.members.some((m) => m.key.equals(newcomer))).to.equal(true);
  });

  it("guarded_config_execute is refused for a payment proposal", async () => {
    const { txIndex } = await propose(payoutIxs(desk, desk.counterpartyAta, usdc(1)));
    await expectError(settlement.guardedConfigExecute(ids(txIndex)), "not a config");
  });
});
