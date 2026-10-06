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

// The app proposes, requests review and executes with instructions the runner prepares.
describe("runner settlement endpoints (instruction builders)", () => {
  const provider = testProvider();
  const connection = provider.connection;
  const program = guardProgram();
  let desk: ForwardedDesk;
  let settlement: Settlement;

  before(async () => {
    desk = await setupForwardedDesk();
    settlement = createSettlement({ connection, programId: program.programId });
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
    });
    expect(await settlement.guardedGroup(Keypair.generate().publicKey.toBase58())).to.equal(null);
  });

  it("toWire produces the app's wire format", async () => {
    const w = toWire(await settlement.requestReview(ids(5n)));
    expect(w.programId).to.equal(program.programId.toBase58());
    expect(Buffer.from(w.data, "base64").length).to.equal(8);
    expect(w.keys[0]).to.have.keys(["pubkey", "isSigner", "isWritable"]);
  });
});
