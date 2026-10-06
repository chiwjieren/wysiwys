import * as anchor from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { txHash } from "@wysiwys/shared";
import { expect } from "chai";
import { createDesk, payoutIxs, proposePayout, usdc, DeskFixture } from "./helpers/squads";
import { expectError, guardEvents, guardProgram, payer, requestReview, reviewPda, statusOf } from "./helpers/guard";
import { testProvider } from "./helpers/provider";

describe("request_review", () => {
  testProvider();
  const program = guardProgram();
  const connection = program.provider.connection;
  let desk: DeskFixture;

  before(async () => {
    desk = await createDesk(connection, payer(), program.programId);
  });

  const propose = () => proposePayout(connection, desk, payoutIxs(desk, desk.counterpartyAta, usdc(500_000)));

  /** Review PDA the program derives from raw bytes 72..80 of whatever is passed as vault_transaction. */
  async function derivedReviewFor(multisig: PublicKey, account: PublicKey) {
    const data = (await connection.getAccountInfo(account))?.data ?? Buffer.alloc(0);
    const idx = data.length >= 80 ? data.readBigUInt64LE(72) : 0n;
    return reviewPda(multisig, idx);
  }

  const rawRequest = (multisig: PublicKey, vaultTransaction: PublicKey, proposal: PublicKey, review: PublicKey) =>
    program.methods
      .requestReview()
      .accountsPartial({ multisig, vaultTransaction, proposal, review, proposer: desk.members[0].publicKey, payer: payer().publicKey })
      .signers([desk.members[0]])
      .rpc();

  it("creates a Pending review with tx_hash computed on-chain", async () => {
    const p = await propose();
    const { review } = await requestReview(desk, p);
    const r = await program.account.review.fetch(review);
    const vtData = (await connection.getAccountInfo(p.transactionPda))!.data;
    const expected = txHash(p.transactionPda.toBytes(), vtData);
    expect(Buffer.from(r.txHash).toString("hex")).to.equal(Buffer.from(expected).toString("hex"));
    expect(r.actionKind).to.equal(0);
    expect(r.vaultTransaction.toBase58()).to.equal(p.transactionPda.toBase58());
    expect(r.proposal.toBase58()).to.equal(p.proposalPda.toBase58());
    expect(r.multisig.toBase58()).to.equal(desk.multisigPda.toBase58());
    expect(BigInt(r.txIndex.toString())).to.equal(p.transactionIndex);
    expect(statusOf(r)).to.equal("pending");
    expect(r.createdAt.toNumber()).to.be.greaterThan(0);
  });

  it("emits ReviewRequested with the stored fields", async () => {
    const p = await propose();
    const { review, sig } = await requestReview(desk, p);
    const ev = (await guardEvents(sig)).find((e) => e.name === "reviewRequested");
    expect(ev, "ReviewRequested event").to.not.equal(undefined);
    expect(ev!.data.review.toBase58()).to.equal(review.toBase58());
    expect(ev!.data.multisig.toBase58()).to.equal(desk.multisigPda.toBase58());
    expect(BigInt(ev!.data.txIndex.toString())).to.equal(p.transactionIndex);
    const r = await program.account.review.fetch(review);
    expect(Buffer.from(ev!.data.txHash).equals(Buffer.from(r.txHash))).to.equal(true);
  });

  it("rejects a second review for the same tx index", async () => {
    const p = await propose();
    await requestReview(desk, p);
    await expectError(requestReview(desk, p), "already in use");
  });

  it("rejects a vault_transaction not owned by Squads", async () => {
    const p = await propose();
    const fake = payer().publicKey;
    await expectError(
      rawRequest(desk.multisigPda, fake, p.proposalPda, await derivedReviewFor(desk.multisigPda, fake)),
      "NotSquadsAccount",
    );
  });

  it("rejects a Squads Proposal passed as the vault transaction", async () => {
    const p = await propose();
    await expectError(
      rawRequest(desk.multisigPda, p.proposalPda, p.proposalPda, await derivedReviewFor(desk.multisigPda, p.proposalPda)),
      "NotSquadsAccount",
    );
  });

  it("rejects a vault transaction from another multisig", async () => {
    // Fresh desks so no Review exists yet at the index being attacked.
    const mine = await createDesk(connection, payer(), program.programId);
    const other = await createDesk(connection, payer(), program.programId);
    const theirs = await proposePayout(connection, other, payoutIxs(other, other.counterpartyAta, usdc(1)));
    await expectError(
      rawRequest(mine.multisigPda, theirs.transactionPda, theirs.proposalPda, reviewPda(mine.multisigPda, theirs.transactionIndex)),
      "WrongMultisig",
    );
  });

  it("rejects a proposal for a different tx index", async () => {
    const a = await propose();
    const b = await propose();
    await expectError(
      rawRequest(desk.multisigPda, a.transactionPda, b.proposalPda, reviewPda(desk.multisigPda, a.transactionIndex)),
      "WrongTxIndex",
    );
  });

  it("rejects a review requested by anyone other than the vault transaction creator (front-running)", async () => {
    const p = await propose();
    await expectError(requestReview(desk, p, desk.members[1]), "NotProposer");
    await expectError(requestReview(desk, p, Keypair.generate()), "NotProposer");
    // The real proposer can still claim the slot afterwards.
    await requestReview(desk, p);
  });

  it("works for many sequential tx indexes (Demo mode reruns)", async () => {
    const reviews = [];
    for (let i = 0; i < 3; i++) reviews.push((await requestReview(desk, await propose())).review.toBase58());
    expect(new Set(reviews).size).to.equal(3);
  });
});
