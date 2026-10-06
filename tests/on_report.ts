import * as anchor from "@anchor-lang/core";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { ACTION_KIND, VERDICT } from "@wysiwys/shared";
import { testProvider } from "./helpers/provider";
import { payoutIxs, proposePayout, usdc } from "./helpers/squads";
import {
  MAX_REVIEW_LIFETIME, chainNow, expectError, guardEvents, guardProgram, randomHash, requestReview, setupGuardedDesk, statusOf,
} from "./helpers/guard";
import {
  ForwardedDesk, approvePayload, deskDestinationHash, createForwarderState, deliverReport, forwarderAuthority, forwarderProgram, reportMetadata,
  setupForwardedDesk,
} from "./helpers/forwarder";

describe("on_report", () => {
  testProvider();
  const program = guardProgram();
  const connection = program.provider.connection;
  let desk: ForwardedDesk;

  before(async () => {
    desk = await setupForwardedDesk();
  });

  async function pendingReview() {
    const p = await proposePayout(connection, desk, payoutIxs(desk, desk.counterpartyAta, usdc(500_000)));
    return (await requestReview(desk, p)).review;
  }

  it("records an approval from the forwarder and emits DecisionRecorded", async () => {
    const review = await pendingReview();
    const payload = await approvePayload(desk, review);
    const sig = await deliverReport(desk, review, payload);
    const r = await program.account.review.fetch(review, "confirmed");
    expect(statusOf(r)).to.equal("approved");
    expect(r.reason).to.equal(0);
    expect(r.expiresAt.toNumber()).to.be.greaterThan(Number(await chainNow(connection)));
    expect(r.actionKind).to.equal(ACTION_KIND.SPL);
    expect(Buffer.from(r.destinationHash).equals(Buffer.from(deskDestinationHash(desk)))).to.equal(true);
    expect(r.issuedAt.toNumber()).to.be.greaterThan(0);
    const ev = (await guardEvents(sig)).find((e) => e.name === "decisionRecorded");
    expect(ev?.data.review.toBase58()).to.equal(review.toBase58());
    expect(ev?.data.verdict).to.equal(VERDICT.APPROVE);
    expect(Buffer.from(ev?.data.destinationHash).equals(Buffer.from(deskDestinationHash(desk)))).to.equal(true);
    // The CRE workflow's computeConfig budget is 290,000 CU for the whole forwarder transaction.
    const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    expect(tx!.meta!.computeUnitsConsumed).to.be.lessThan(290_000);
  });

  it("records a rejection with its reason", async () => {
    const review = await pendingReview();
    await deliverReport(desk, review, await approvePayload(desk, review, { verdict: VERDICT.REJECT, reason: 12 }));
    const r = await program.account.review.fetch(review, "confirmed");
    expect(statusOf(r)).to.equal("rejected");
    expect(r.reason).to.equal(12);
  });

  it("rejects a forwarder state other than the configured one", async () => {
    const review = await pendingReview();
    const otherState = await createForwarderState();
    await expectError(deliverReport(desk, review, await approvePayload(desk, review), { state: otherState }), "InvalidForwarder");
  });

  it("rejects a forwarder state not owned by the configured forwarder program", async () => {
    // Guard configured with the System program as forwarder program; the real state is owned by test_forwarder.
    const forwarderState = await createForwarderState();
    const odd = await setupGuardedDesk({ forwarderProgram: SystemProgram.programId, forwarderState });
    const p = await proposePayout(connection, odd, payoutIxs(odd, odd.counterpartyAta, usdc(1)));
    const { review } = await requestReview(odd, p);
    await expectError(deliverReport({ ...odd, forwarderState }, review, await approvePayload(odd, review)), "InvalidForwarder");
  });

  it("rejects an authority derived for another receiver", async () => {
    const review = await pendingReview();
    await expectError(
      deliverReport(desk, review, await approvePayload(desk, review), { seedProgram: PublicKey.unique() }),
      "InvalidForwarder",
    );
  });

  it("rejects an unsigned authority (direct call)", async () => {
    const review = await pendingReview();
    await expectError(
      program.methods
        .onReport(Buffer.alloc(64), Buffer.from(await approvePayload(desk, review)))
        .accountsPartial({ forwarderState: desk.forwarderState, forwarderAuthority: forwarderAuthority(desk.forwarderState), config: desk.config, review })
        .rpc(),
      "InvalidForwarder",
    );
  });

  it("rejects a report from another workflow owner", async () => {
    const review = await pendingReview();
    await expectError(
      deliverReport(desk, review, await approvePayload(desk, review), { metadata: reportMetadata(new Uint8Array(20).fill(0x22)) }),
      "InvalidWorkflow",
    );
  });

  it("rejects metadata that is not 64 bytes", async () => {
    const review = await pendingReview();
    await expectError(
      deliverReport(desk, review, await approvePayload(desk, review), { metadata: reportMetadata().slice(0, 63) }),
      "InvalidWorkflow",
    );
  });

  it("rejects a tx_hash mismatch", async () => {
    const review = await pendingReview();
    await expectError(deliverReport(desk, review, await approvePayload(desk, review, { txHash: randomHash() })), "HashMismatch");
  });

  it("rejects an approval window longer than the configured max lifetime", async () => {
    const review = await pendingReview();
    const now = await chainNow(connection);
    await expectError(
      deliverReport(desk, review, await approvePayload(desk, review, { issuedAt: now, expiresAt: now + MAX_REVIEW_LIFETIME + 1n })),
      "InvalidPayload",
    );
  });

  it("rejects a report that arrives after the review deadline", async () => {
    const forwarderState = await createForwarderState();
    const strict = await setupGuardedDesk({ forwarderProgram: forwarderProgram().programId, forwarderState, reviewDeadline: 1n });
    const p = await proposePayout(connection, strict, payoutIxs(strict, strict.counterpartyAta, usdc(1)));
    const { review } = await requestReview(strict, p);
    const createdAt = BigInt((await program.account.review.fetch(review, "confirmed")).createdAt.toString());
    while ((await chainNow(connection)) <= createdAt + 1n) await new Promise((r) => setTimeout(r, 500));
    await expectError(
      deliverReport({ ...strict, forwarderState }, review, await approvePayload(strict, review)),
      "ReviewDeadlinePassed",
    );
  });

  it("rejects an approval without a destination", async () => {
    const review = await pendingReview();
    await expectError(deliverReport(desk, review, await approvePayload(desk, review, { actionKind: ACTION_KIND.NONE })), "InvalidPayload");
  });

  it("rejects a policy hash different from the config", async () => {
    const review = await pendingReview();
    await expectError(deliverReport(desk, review, await approvePayload(desk, review, { policyHash: randomHash() })), "PolicyMismatch");
  });

  it("rejects malformed payloads", async () => {
    const review = await pendingReview();
    const good = await approvePayload(desk, review);
    await expectError(deliverReport(desk, review, good.slice(0, 116)), "InvalidPayload");
    await expectError(deliverReport(desk, review, Uint8Array.from([...good, 0])), "InvalidPayload");
    const badVerdict = Uint8Array.from(good);
    badVerdict[1] = 3;
    await expectError(deliverReport(desk, review, badVerdict), "InvalidPayload");
    const now = await chainNow(connection);
    await expectError(deliverReport(desk, review, await approvePayload(desk, review, { expiresAt: now - 1n })), "InvalidPayload");
  });

  it("rejects a second report once decided", async () => {
    const review = await pendingReview();
    await deliverReport(desk, review, await approvePayload(desk, review));
    await expectError(
      deliverReport(desk, review, await approvePayload(desk, review, { verdict: VERDICT.REJECT, reason: 2 })),
      "InvalidStatusTransition",
    );
  });
});
