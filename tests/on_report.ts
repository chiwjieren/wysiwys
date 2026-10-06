import * as anchor from "@anchor-lang/core";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { VERDICT } from "@wysiwys/shared";
import { testProvider } from "./helpers/provider";
import { payoutIxs, proposePayout, usdc } from "./helpers/squads";
import { chainNow, expectError, guardEvents, guardProgram, randomHash, requestReview, setupGuardedDesk, statusOf } from "./helpers/guard";
import {
  ForwardedDesk, approvePayload, createForwarderState, deliverReport, forwarderAuthority, forwarderProgram, reportMetadata,
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
    const payload = await approvePayload(review);
    const sig = await deliverReport(desk, review, payload);
    const r = await program.account.review.fetch(review, "confirmed");
    expect(statusOf(r)).to.equal("approved");
    expect(r.reason).to.equal(0);
    expect(r.expiresAt.toNumber()).to.be.greaterThan(Number(await chainNow(connection)));
    const ev = (await guardEvents(sig)).find((e) => e.name === "decisionRecorded");
    expect(ev?.data.review.toBase58()).to.equal(review.toBase58());
    expect(ev?.data.verdict).to.equal(VERDICT.APPROVE);
    // The CRE workflow's computeConfig budget is 290,000 CU for the whole forwarder transaction.
    const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    expect(tx!.meta!.computeUnitsConsumed).to.be.lessThan(290_000);
  });

  it("records a rejection with its reason", async () => {
    const review = await pendingReview();
    await deliverReport(desk, review, await approvePayload(review, { verdict: VERDICT.REJECT, reason: 12 }));
    const r = await program.account.review.fetch(review, "confirmed");
    expect(statusOf(r)).to.equal("rejected");
    expect(r.reason).to.equal(12);
  });

  it("rejects a forwarder state other than the configured one", async () => {
    const review = await pendingReview();
    const otherState = await createForwarderState();
    await expectError(deliverReport(desk, review, await approvePayload(review), { state: otherState }), "InvalidForwarder");
  });

  it("rejects a forwarder state not owned by the configured forwarder program", async () => {
    // Guard configured with the System program as forwarder program; the real state is owned by test_forwarder.
    const forwarderState = await createForwarderState();
    const odd = await setupGuardedDesk({ forwarderProgram: SystemProgram.programId, forwarderState });
    const p = await proposePayout(connection, odd, payoutIxs(odd, odd.counterpartyAta, usdc(1)));
    const { review } = await requestReview(odd, p);
    await expectError(deliverReport({ ...odd, forwarderState }, review, await approvePayload(review)), "InvalidForwarder");
  });

  it("rejects an authority derived for another receiver", async () => {
    const review = await pendingReview();
    await expectError(
      deliverReport(desk, review, await approvePayload(review), { seedProgram: PublicKey.unique() }),
      "InvalidForwarder",
    );
  });

  it("rejects an unsigned authority (direct call)", async () => {
    const review = await pendingReview();
    await expectError(
      program.methods
        .onReport(Buffer.alloc(64), Buffer.from(await approvePayload(review)))
        .accountsPartial({ forwarderState: desk.forwarderState, forwarderAuthority: forwarderAuthority(desk.forwarderState), config: desk.config, review })
        .rpc(),
      "InvalidForwarder",
    );
  });

  it("rejects a report from another workflow owner", async () => {
    const review = await pendingReview();
    await expectError(
      deliverReport(desk, review, await approvePayload(review), { metadata: reportMetadata(new Uint8Array(20).fill(0x22)) }),
      "InvalidWorkflow",
    );
  });

  it("rejects metadata that is not 64 bytes", async () => {
    const review = await pendingReview();
    await expectError(
      deliverReport(desk, review, await approvePayload(review), { metadata: reportMetadata().slice(0, 63) }),
      "InvalidWorkflow",
    );
  });

  it("rejects a msg_hash mismatch", async () => {
    const review = await pendingReview();
    await expectError(deliverReport(desk, review, await approvePayload(review, { msgHash: randomHash() })), "HashMismatch");
  });

  it("rejects an intent hash mismatch", async () => {
    const review = await pendingReview();
    await expectError(deliverReport(desk, review, await approvePayload(review, { intentHash: randomHash() })), "IntentMismatch");
  });

  it("rejects a policy hash different from the config", async () => {
    const review = await pendingReview();
    await expectError(deliverReport(desk, review, await approvePayload(review, { policyHash: randomHash() })), "PolicyMismatch");
  });

  it("rejects malformed payloads", async () => {
    const review = await pendingReview();
    const good = await approvePayload(review);
    await expectError(deliverReport(desk, review, good.slice(0, 106)), "InvalidPayload");
    await expectError(deliverReport(desk, review, Uint8Array.from([...good, 0])), "InvalidPayload");
    const badVerdict = Uint8Array.from(good);
    badVerdict[0] = 3;
    await expectError(deliverReport(desk, review, badVerdict), "InvalidPayload");
    const now = await chainNow(connection);
    await expectError(deliverReport(desk, review, await approvePayload(review, { expiresAt: now - 1n })), "InvalidPayload");
  });

  it("rejects a second report once decided", async () => {
    const review = await pendingReview();
    await deliverReport(desk, review, await approvePayload(review));
    await expectError(
      deliverReport(desk, review, await approvePayload(review, { verdict: VERDICT.REJECT, reason: 2 })),
      "InvalidStatusTransition",
    );
  });
});
