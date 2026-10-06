"use client";
import Link from "next/link";
import { useSquad } from "@/lib/squads/provider";
import { LiveProposal } from "@/components/squads/live-squad";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  AssetIcon,
  Avatar,
  PageHeader,
  Panel,
  StatusBadge,
} from "@/components/design";
import { InfrastructureDialog, SampleDetails } from "@/components/dialogs";
import {
  ClientPaymentEvidence,
  InstructionBreakdown,
  PayoutDetails,
  ReviewProgress,
  TradeComparison,
} from "./review-evidence";
import { figmaAssets } from "@/lib/figma-assets";
import { mockDesk, mockMembers, mockTrades, number } from "@/lib/mock/data";
import { useMockSettlement } from "@/lib/mock/provider";
import {
  canApprove,
  canExecute,
  hasCommittedPayout,
} from "@/lib/mock/settlement";

export function ReviewScreen({ id }: { id: string }) {
  const { mode } = useSquad();
  const { payouts, dispatch, now, loaded, observeReview } = useMockSettlement();
  useEffect(() => observeReview(id), [id, observeReview]);
  const payout = payouts.find((p) => p.id === id);
  const trade = mockTrades.find((t) => t.id === payout?.tradeId);
  if (mode !== "sample") return <LiveProposal id={id} />;
  if (!loaded)
    return (
      <p className="caption" role="status">
        Loading payout…
      </p>
    );
  if (!payout || !trade)
    return (
      <div className="page-stack">
        <PageHeader
          title="Payout not found"
          description="This payout is unavailable in the current sample session."
        />
        <Button asChild variant="secondary" className="w-fit">
          <Link href="/transactions">← Transactions</Link>
        </Button>
      </div>
    );
  const waiting = payout.stage === "decoding" || payout.stage === "unavailable";
  const unavailable = payout.stage === "unavailable";
  const rejected = payout.stage === "rejected";
  const blockedByTrade =
    hasCommittedPayout(trade.id, payouts, id) &&
    (payout.stage === "approved" || payout.stage === "decoding");
  const expired =
    payout.stage === "approved" && Date.parse(payout.expiresAt) <= now;
  const executed = payout.stage === "executed";
  const executing = payout.stage === "executing";
  const title = blockedByTrade
    ? "Trade unavailable for another payout"
    : unavailable
      ? "Verification unavailable"
      : waiting
        ? "Decoding transaction…"
        : rejected
          ? !payout.clientReceived
            ? "No proof, no payout"
            : !payout.destinationMatches
              ? "Payout does not match the trade"
              : "Proposal rejected"
          : expired
            ? "Review expired"
            : executed
              ? "Payout executed"
              : executing
                ? "Executing payout…"
                : "Settlement verified";
  const description = blockedByTrade
    ? "Another payout for this trade is executing or has already executed. No additional payout can execute."
    : unavailable
      ? "RPC sources are unavailable. No guard verdict has been recorded."
      : waiting
        ? "Decoding the payout before checking its trade ticket and client payment."
        : rejected
          ? !payout.clientReceived
            ? "The required client payment has not been received. This review is rejected."
            : !payout.destinationMatches
              ? "The payout destination differs from the verified settlement wallet in the approved trade."
              : "A member rejected this payout proposal. This review is final."
          : expired
            ? "This review has expired. Initiate a new payout proposal."
            : executed
              ? number(trade.payoutAmount) +
                " test USDC sent to " +
                trade.counterparty +
                "'s verified wallet."
              : executing
                ? "Waiting for payout confirmation on Solana Devnet."
                : "Client payment verified. Send " +
                  number(trade.payoutAmount) +
                  " test USDC to " +
                  trade.counterparty +
                  "'s verified wallet.";
  const seconds = Math.max(
    0,
    Math.floor((Date.parse(payout.expiresAt) - now) / 1000),
  );
  const clock =
    Math.floor(seconds / 60) +
    "m " +
    String(seconds % 60).padStart(2, "0") +
    "s";
  const approved = canApprove(payout, now, payouts);
  const ready = canExecute(payout, now, payouts);
  const banner = waiting
    ? "bg-info-bg"
    : rejected || expired || blockedByTrade
      ? "bg-danger-bg"
      : executing
        ? "bg-warning-bg"
        : "bg-success-bg";
  return (
    <div className="page-stack">
      <PageHeader
        title={trade.id + " · " + trade.counterparty}
        description={
          "Trade version " +
          trade.version +
          " · Payout #" +
          (id === "unavailable" ? "104" : id) +
          " · Proposed by Jun Heng"
        }
      >
        <Button asChild variant="secondary" className="w-[184px]">
          <Link href="/transactions">← Transactions</Link>
        </Button>
      </PageHeader>
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,740fr)_minmax(0,356fr)]">
        <div className="space-y-5">
          <div
            className={"space-y-4 rounded-xl p-6 " + banner}
            role="status"
            aria-live="polite"
          >
            <div
              className={
                "flex items-center gap-3 text-base leading-6 font-semibold " +
                (waiting
                  ? "text-info"
                  : rejected || expired || blockedByTrade
                    ? "text-destructive"
                    : executing
                      ? "text-warning"
                      : "text-success")
              }
            >
              <AssetIcon
                size={24}
                src={
                  waiting
                    ? unavailable
                      ? figmaAssets.unavailable.imgIconScan
                      : figmaAssets.decoding.imgIconScan
                    : rejected
                      ? figmaAssets.blocked.imgIconShield2
                      : figmaAssets.review.imgIconShield2
                }
              />
              {title}
            </div>
            <p>{description}</p>
          </div>
          {waiting ? (
            <>
              <ReviewProgress unavailable={unavailable} />
              <Panel className="gap-3">
                <h2>Selected trade ticket</h2>
                <p>
                  {trade.id} · Version {trade.version} · {trade.counterparty}
                  <br />
                  Desk sends {number(trade.payoutAmount)} test USDC to the
                  verified wallet.
                </p>
                <p className="caption">
                  Trade details are read-only. The exact payout and deposit
                  evidence are independently verified.
                </p>
              </Panel>
            </>
          ) : (
            <>
              <ClientPaymentEvidence payout={payout} trade={trade} />
              <TradeComparison payout={payout} trade={trade} />
              <PayoutDetails payout={payout} trade={trade} />
              <InstructionBreakdown payout={payout} trade={trade} />
            </>
          )}
        </div>
        <div className="space-y-5">
          <Panel className="gap-4">
            <h2>Member approvals</h2>
            <p className="text-lg leading-[26px] font-semibold">
              {payout.votes} of 3 approved
            </p>
            <div className="h-px bg-border" />
            {mockMembers.map((member, index) => (
              <div key={member.initials} className="flex items-center gap-3">
                <Avatar initials={member.initials} size={32} />
                <p className="flex-1 text-xs">{member.name}</p>
                <AssetIcon
                  size={18}
                  src={
                    index < payout.votes
                      ? figmaAssets.review.imgIconCheck1
                      : figmaAssets.review.imgIconClock
                  }
                />
              </div>
            ))}
            <p className="caption">
              Guard verdict and member votes are separate.
            </p>
          </Panel>
          <Panel className="gap-4">
            <h2>
              {waiting
                ? unavailable
                  ? "Approval unavailable"
                  : "Waiting for review"
                : rejected || expired || blockedByTrade
                  ? "Execution blocked"
                  : executed
                    ? "Payout complete"
                    : executing
                      ? "Confirming payout"
                      : ready
                        ? "Ready to execute"
                        : "Your approval is needed"}
            </h2>
            <p className="text-muted-foreground">
              {waiting
                ? unavailable
                  ? "The transaction cannot be verified reliably. Approval and execution remain unavailable."
                  : "Wait for client-payment verification, trade matching, and the recorded guard verdict."
                : rejected
                  ? !payout.clientReceived
                    ? "After the client payment confirms, initiate a new payout proposal. This rejected review is final."
                    : "This payout cannot execute, even if all members approve it."
                  : expired
                    ? "Request another review with a new payout proposal."
                    : executed
                      ? payout.tradeSettled
                        ? "Confirmed on Solana Devnet. Trade settlement is complete."
                        : "Confirmed on Solana Devnet. Trade update follows."
                      : executing
                        ? "Payout submitted. Waiting for confirmation."
                        : ready
                          ? "Client payment verified, trade matched, and all three signers approved."
                          : "You are approving this exact payout for the verified trade and client payment."}
            </p>
            {approved ? (
              <>
                <Button onClick={() => dispatch(id, "approve")}>
                  Approve payout
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => dispatch(id, "reject")}
                >
                  Reject proposal
                </Button>
                <p className="text-xs text-warning">
                  Review expires in {clock}
                </p>
              </>
            ) : ready ? (
              <>
                <Button onClick={() => dispatch(id, "execute")}>
                  Execute payout
                </Button>
                <p className="text-xs text-warning">
                  Review expires in {clock}
                </p>
                <p className="caption">
                  The guard checks the exact transaction and bound trade hashes
                  again.
                </p>
              </>
            ) : executed ? (
              <>
                <SampleDetails
                  title="Executed payout"
                  content={
                    <p>
                      Sample Solana payout #{id} · {number(trade.payoutAmount)}{" "}
                      test USDC · Executed.
                    </p>
                  }
                >
                  <Button variant="secondary">View transaction ↗</Button>
                </SampleDetails>
                <p className="caption">Executed today at 10:51</p>
                <StatusBadge
                  tone={payout.tradeSettled ? "success" : "warning"}
                  className="w-[240px]"
                >
                  {payout.tradeSettled
                    ? "Trade SETTLED"
                    : "Trade update pending"}
                </StatusBadge>
                <p className="caption">
                  {payout.tradeSettled
                    ? "Payout confirmed and the trade system marked this ticket SETTLED."
                    : "Payout confirmed. Waiting for the listener to mark the trade SETTLED."}
                </p>
              </>
            ) : (
              <>
                <Button variant="secondary" disabled>
                  {waiting
                    ? unavailable
                      ? "Verification unavailable"
                      : "Review in progress"
                    : executing
                      ? "Confirming payout…"
                      : "Execute unavailable"}
                </Button>
                {unavailable ? (
                  <InfrastructureDialog>
                    <Button
                      variant="link"
                      className="h-auto justify-start p-0 text-xs text-info"
                    >
                      View infrastructure status
                    </Button>
                  </InfrastructureDialog>
                ) : rejected ? (
                  <p className="text-xs text-destructive">
                    Reason: {payout.reason}
                  </p>
                ) : waiting ? (
                  <p className="caption">
                    Approval is unavailable until verification completes.
                  </p>
                ) : null}
              </>
            )}
          </Panel>
          <Panel className="gap-4">
            <h2>Review details</h2>
            <p className="caption">
              {unavailable
                ? "On-chain verdict: not recorded"
                : waiting
                  ? "Verdict: pending"
                  : executed
                    ? "On-chain review: Executed"
                    : "On-chain verdict: " +
                      (rejected ? "rejected" : "approved")}
            </p>
            <p className="caption">Transaction hash · a78d…b12f</p>
            <p className="caption">Policy version 1 · {mockDesk.policyHash}</p>
            <SampleDetails
              title="Review record"
              content={
                <p>
                  Sample review bound to {trade.id}, version {trade.version},
                  and payout #{id}.
                </p>
              }
            >
              <Button
                variant="link"
                className="h-auto justify-start p-0 text-xs leading-[18px] font-normal text-muted-foreground"
              >
                Open in explorer &nbsp; ↗
              </Button>
            </SampleDetails>
            <p className="caption">Trade ref hash · 29b1…9a70</p>
            <p className="caption">Settlement intent · c681…f932</p>
            <p className="caption">
              Expiry is the earlier of review and trade validity.
            </p>
          </Panel>
        </div>
      </div>
    </div>
  );
}
