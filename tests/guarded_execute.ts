import * as anchor from "@anchor-lang/core";
import * as multisig from "@sqds/multisig";
import {
  ComputeBudgetProgram, Keypair, NONCE_ACCOUNT_LENGTH, PublicKey, SYSVAR_CLOCK_PUBKEY, SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram, Transaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount } from "@solana/spl-token";
import { expect } from "chai";
import { VERDICT } from "@omnicounter/shared";
import { testProvider } from "./helpers/provider";
import {
  approve, executeRemainingAccounts, payoutIxs, proposePayout, sendWithFreshBlockhash, usdc, Proposed, SQUADS_PROGRAM_ID,
} from "./helpers/squads";
import { chainNow, expectError, guardEvents, guardProgram, payer, requestReview, statusOf } from "./helpers/guard";
import { ForwardedDesk, approvePayload, deliverReport, setupForwardedDesk } from "./helpers/forwarder";

describe("guarded_execute", () => {
  testProvider();
  const program = guardProgram();
  const connection = program.provider.connection;
  const AMOUNT = usdc(500_000);
  let desk: ForwardedDesk;

  before(async () => {
    desk = await setupForwardedDesk();
  });

  type Flow = { p: Proposed; review: PublicKey };

  async function flow(opts: { votes?: number; verdict?: "approve" | "reject" | "none"; expiresIn?: bigint } = {}): Promise<Flow> {
    const p = await proposePayout(connection, desk, payoutIxs(desk, desk.counterpartyAta, AMOUNT));
    const { review } = await requestReview(desk, p);
    if ((opts.votes ?? 3) > 0) await approve(connection, desk, p.transactionIndex, opts.votes ?? 3);
    const verdict = opts.verdict ?? "approve";
    if (verdict !== "none") {
      const expiresAt = (await chainNow(connection)) + (opts.expiresIn ?? 600n);
      const overrides = verdict === "reject" ? { verdict: VERDICT.REJECT, reason: 12, expiresAt } : { expiresAt };
      await deliverReport(desk, review, await approvePayload(review, overrides));
    }
    return { p, review };
  }

  async function executeIx(f: Flow, overrides: Record<string, PublicKey> = {}, remaining?: anchor.web3.AccountMeta[]) {
    return program.methods
      .guardedExecute()
      .accountsPartial({
        config: desk.config,
        review: f.review,
        multisig: desk.multisigPda,
        proposal: f.p.proposalPda,
        vaultTransaction: f.p.transactionPda,
        executor: desk.executorPda,
        squadsProgram: SQUADS_PROGRAM_ID,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        ...overrides,
      })
      .remainingAccounts(remaining ?? (await executeRemainingAccounts(connection, desk, f.p.transactionIndex)))
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]);
  }

  const execute = async (f: Flow, overrides: Record<string, PublicKey> = {}, remaining?: anchor.web3.AccountMeta[]) =>
    (await executeIx(f, overrides, remaining)).rpc({ commitment: "confirmed" });

  const reviewStatus = async (review: PublicKey) => statusOf(await program.account.review.fetch(review, "confirmed"));

  it("executes an approved 3 of 3 payout", async () => {
    const f = await flow();
    const before = (await getAccount(connection, desk.counterpartyAta)).amount;
    const sig = await execute(f);
    expect((await getAccount(connection, desk.counterpartyAta)).amount - before).to.equal(AMOUNT);
    expect(await reviewStatus(f.review)).to.equal("executed");
    const proposal = await multisig.accounts.Proposal.fromAccountAddress(connection, f.p.proposalPda, "confirmed");
    expect(proposal.status.__kind).to.equal("Executed");
    const ev = (await guardEvents(sig)).find((e) => e.name === "executed");
    expect(ev?.data.review.toBase58()).to.equal(f.review.toBase58());
    expect(BigInt(ev!.data.txIndex.toString())).to.equal(f.p.transactionIndex);
  });

  it("refuses a Pending review", async () => {
    await expectError(execute(await flow({ verdict: "none" })), "NotApproved");
  });

  it("refuses a Rejected review", async () => {
    await expectError(execute(await flow({ verdict: "reject" })), "NotApproved");
  });

  it("refuses after expiry", async () => {
    const f = await flow({ expiresIn: 3n });
    const expiresAt = BigInt((await program.account.review.fetch(f.review, "confirmed")).expiresAt.toString());
    while ((await chainNow(connection)) <= expiresAt) await new Promise((r) => setTimeout(r, 500));
    await expectError(execute(f), "Expired");
  });

  it("refuses a second execution", async () => {
    const f = await flow();
    await execute(f);
    await expectError(execute(f), "AlreadyExecuted");
  });

  it("refuses a report after execution", async () => {
    const f = await flow();
    await execute(f);
    await expectError(deliverReport(desk, f.review, await approvePayload(f.review)), "InvalidStatusTransition");
  });

  it("refuses a durable nonce transaction", async () => {
    const f = await flow();
    const nonce = Keypair.generate();
    const rent = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
    await sendWithFreshBlockhash(
      connection,
      SystemProgram.createNonceAccount({ fromPubkey: payer().publicKey, noncePubkey: nonce.publicKey, authorizedPubkey: payer().publicKey, lamports: rent }).instructions,
      [payer(), nonce],
    );
    const { nonce: nonceValue } = (await connection.getNonce(nonce.publicKey, "confirmed"))!;
    const guardIx = await (await executeIx(f)).instruction();
    const tx = new Transaction({ feePayer: payer().publicKey, nonceInfo: {
      nonce: nonceValue,
      nonceInstruction: SystemProgram.nonceAdvance({ noncePubkey: nonce.publicKey, authorizedPubkey: payer().publicKey }),
    } }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), guardIx);
    tx.sign(payer());
    await expectError(connection.sendRawTransaction(tx.serialize()), "DurableNonceDetected");
    expect(await reviewStatus(f.review)).to.equal("approved");
  });

  it("refuses a fake instructions sysvar", async () => {
    await expectError(execute(await flow(), { instructionsSysvar: SYSVAR_CLOCK_PUBKEY }), "InvalidInstructionsSysvar");
  });

  it("refuses a CPI target other than Squads", async () => {
    await expectError(execute(await flow(), { squadsProgram: TOKEN_PROGRAM_ID }), "InvalidSquadsProgram");
  });

  it("refuses a review from another multisig", async () => {
    const other = await setupForwardedDesk();
    const p = await proposePayout(connection, other, payoutIxs(other, other.counterpartyAta, usdc(1)));
    const { review } = await requestReview(other, p);
    const mine = await flow();
    await expectError(execute({ ...mine, review }), "WrongMultisig");
  });

  it("refuses accounts that do not match the review", async () => {
    const a = await flow();
    const b = await flow();
    await expectError(execute(a, { vaultTransaction: b.p.transactionPda, proposal: b.p.proposalPda }), "ReviewMismatch");
  });

  it("2 of 3 votes: Squads refuses, review stays Approved, executes after the third vote", async () => {
    const f = await flow({ votes: 2 });
    await expectError(execute(f), "InvalidProposalStatus");
    expect(await reviewStatus(f.review)).to.equal("approved");
    const third = desk.members[2];
    await multisig.rpc.proposalApprove({ connection, feePayer: third, member: third, multisigPda: desk.multisigPda, transactionIndex: f.p.transactionIndex });
    await new Promise((r) => setTimeout(r, 1000));
    await execute(f);
    expect(await reviewStatus(f.review)).to.equal("executed");
  });

  it("truncated remaining accounts: Squads refuses and the review stays Approved", async () => {
    const f = await flow();
    const remaining = await executeRemainingAccounts(connection, desk, f.p.transactionIndex);
    await expectError(execute(f, {}, remaining.slice(0, -1)), "InvalidNumberOfAccounts");
    expect(await reviewStatus(f.review)).to.equal("approved");
  });
});
