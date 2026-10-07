"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { Button } from "@/components/ui/button";
import {
  Panel,
  PageHeader,
  StatusBadge,
  Avatar,
  AssetIcon,
} from "@/components/design";
import { useSquad } from "@/lib/squads/provider";
import {
  readProposal,
  actionsForMember,
  type ProposalRecord,
} from "@/lib/squads/sdk";
import { readPaymentPreview, type PaymentPreview } from "@/lib/squads/payments";
import {
  assertStandardExecution,
  guardedConfigGate,
} from "@/lib/squads/execution";
import {
  describeConfigActions,
  GUARD_REFUSES,
} from "@/lib/squads/config-actions";
import { memberDisplayName, useMemberNames } from "@/lib/squads/member-names";
import {
  executeGate,
  isGuarded,
  readReviews,
  reviewPda,
  reviewReasonText,
  type Review,
} from "@/lib/squads/review";
import { figmaAssets } from "@/lib/figma-assets";
import {
  Explorer,
  SquadFeedback,
  EmptyState,
  ProposalStatus,
  ReviewBadge,
} from "./treasury-ui";
import { proposalProgress } from "@/lib/squads/progress";
import { ProgressTracker } from "./progress-tracker";

const PROGRAM_NAMES: Record<string, string> = {
  "11111111111111111111111111111111": "System program",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "Token program",
};
// Fast refresh while a proposal is moving; slow once it can no longer change.
const LIVE_MS = 5000;
const SETTLED_MS = 30000;
export function LiveProposal({ id }: { id: string }) {
  const { config, snapshot, account, error, busy, vote, execute } = useSquad();
  const { names } = useMemberNames(config?.multisig);
  const [record, setRecord] = useState<ProposalRecord | null>();
  const [readError, setReadError] = useState("");
  const [decoded, setDecoded] = useState<PaymentPreview>();
  // On-chain guard Review: undefined = not loaded or unreadable, null = none.
  const [review, setReview] = useState<Review | null>();
  const guarded = isGuarded(config);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  // The snapshot refreshes in the background; reading it through a ref keeps those refreshes from
  // restarting (and blanking) this page.
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const hasSnapshot = !!snapshot;
  const loaded = useRef(false);
  // Clear only when a different proposal or treasury opens.
  useEffect(() => {
    loaded.current = false;
    setRecord(undefined);
    setDecoded(undefined);
    setReview(undefined);
    setReadError("");
    setUpdatedAt(null);
    setRefreshFailed(false);
  }, [config?.multisig, id]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      if (!config) return;
      let settled = false;
      try {
        if (
          !/^\d{1,20}$/.test(id) ||
          BigInt(id) < 1n ||
          BigInt(id) > 18446744073709551615n
        )
          throw new Error("Invalid proposal index.");
        const rpc = new Connection(
          new URL("/api/squads/rpc", window.location.origin).toString(),
          "finalized",
        );
        const result = await readProposal(rpc, config, BigInt(id));
        const vault = snapshotRef.current?.vault;
        const preview =
          result?.kind === "vault" && vault
            ? await readPaymentPreview(rpc, result.transaction.message, vault)
            : undefined;
        let onChainReview: Review | null | undefined;
        if (isGuarded(config))
          try {
            onChainReview = (
              await readReviews(
                rpc,
                new PublicKey(config.guardProgram!),
                new PublicKey(config.multisig),
                [BigInt(id)],
              )
            )[id];
          } catch {
            onChainReview = undefined;
          }
        const status = result?.proposal.status.__kind;
        settled =
          !result ||
          result.kind === "archived" ||
          status === "Executed" ||
          status === "Rejected" ||
          status === "Cancelled" ||
          onChainReview?.status === "Rejected";
        if (!cancelled) {
          loaded.current = true;
          setDecoded(preview);
          setRecord(result);
          setReview(onChainReview);
          setReadError("");
          setRefreshFailed(false);
          setUpdatedAt(Date.now());
        }
      } catch (e) {
        if (!cancelled) {
          // Keep what is on screen during a failed refresh; only a first load shows the error.
          if (loaded.current) setRefreshFailed(true);
          else
            setReadError(
              e instanceof Error ? e.message : "Could not load this proposal.",
            );
        }
      }
      if (!cancelled) timer = setTimeout(() => void load(), settled ? SETTLED_MS : LIVE_MS);
    }
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // The snapshot is read through snapshotRef; only its first arrival reloads (for the vault).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, id, hasSnapshot]);
  // Config actions of a guarded treasury are also checked against what
  // guarded_config_execute accepts, so refused changes are flagged up front.
  const configActions =
    record?.kind === "config"
      ? describeConfigActions(
          record.transaction.actions,
          guarded ? config?.executor : undefined,
        )
      : undefined;
  const configLines = configActions?.lines.map((l) => l.text) ?? [];
  const flags = configActions?.lines.map((l) => l.reason) ?? [];
  const supported = configActions
    ? configActions.supported
    : !!decoded?.supported;
  const lines =
    record?.kind === "vault"
      ? (decoded?.lines ?? [])
      : record?.kind === "batch"
        ? [
            `Batch of ${record.transaction.size} transactions. ${record.transaction.executedTransactionIndex} executed.`,
          ]
        : record?.kind === "archived"
          ? [
              "Squads clears stored payment instructions after execution. View the transaction account’s on-chain history for the original payment.",
            ]
          : configLines;
  const permissions =
    record && snapshot
      ? actionsForMember(
          snapshot.squad,
          record.proposal,
          account ? new PublicKey(account.publicKey) : undefined,
        )
      : { approve: false, reject: false, cancel: false };
  const standard = config?.executionMode === "standard";
  let executionIssue = "Connect with an authorized executor to continue.";
  if (standard && config && snapshot && record && account) {
    try {
      assertStandardExecution(
        config,
        snapshot.squad,
        record.proposal,
        new PublicKey(account.publicKey),
        undefined,
        record.kind === "archived" ? "vault" : record.kind,
      );
      executionIssue = "";
    } catch (e) {
      executionIssue =
        e instanceof Error ? e.message : "Execution is unavailable.";
    }
  }
  const enabled =
    !!account && !!snapshot && !!record && !error && !readError && !busy;
  const guardedConfig = guarded && record?.kind === "config";
  const configGate =
    guardedConfig && record && snapshot
      ? guardedConfigGate(
          snapshot.squad,
          record.proposal,
          Math.floor(Date.now() / 1000),
        )
      : { enabled: false, reason: "Loading the group" };
  const gate =
    guarded && record
      ? review === undefined
        ? { enabled: false, reason: "The on-chain review could not be read" }
        : executeGate(record.proposal.status.__kind, review, Date.now() / 1000)
      : { enabled: true, reason: "" };
  const reviewAddress =
    guarded && config
      ? reviewPda(
          new PublicKey(config.guardProgram!),
          new PublicKey(config.multisig),
          BigInt(/^\d{1,20}$/.test(id) ? id : "0"),
        ).toBase58()
      : "";
  return (
    <div className="page-stack">
      <PageHeader
        title={`Proposal #${id}`}
        description={
          record?.kind === "config"
            ? "Review a proposed change to your group."
            : record?.kind === "batch"
              ? "Review a batch of treasury transactions."
              : "Understand the payment before you approve."
        }
      >
        <Button variant="secondary" asChild>
          <Link href="/transactions">← Transactions</Link>
        </Button>
      </PageHeader>
      <SquadFeedback />
      {readError && (
        <p role="alert" className="text-destructive">
          {readError}
        </p>
      )}
      {!config ? (
        <Panel>
          <EmptyState title="Open the proposal’s treasury">
            Select its group before reviewing this payment.
          </EmptyState>
        </Panel>
      ) : record === undefined && !readError ? (
        <Panel className="gap-4">
          <div role="status" className="flex items-center gap-4">
            <AssetIcon src={figmaAssets.decoding.imgIconScan} size={40} />
            <div>
              <h2>Decoding transaction…</h2>
              <p className="text-muted-foreground">
                Reading the stored instructions, accounts and payment details.
              </p>
            </div>
          </div>
        </Panel>
      ) : record === null ? (
        <Panel>
          <EmptyState title="Proposal not found">
            Refresh the treasury or check the proposal number.
          </EmptyState>
        </Panel>
      ) : null}
      {record && (
        <ProgressTracker
          steps={proposalProgress({
            kind: record.kind,
            guarded,
            proposalStatus: record.proposal.status.__kind,
            approvals: record.proposal.approved.length,
            threshold: snapshot?.squad.threshold ?? null,
            review,
            nowSeconds: Date.now() / 1000,
          })}
          updatedAt={updatedAt}
        />
      )}
      {refreshFailed && (
        <p className="caption" role="status">
          Live updates paused: the last refresh failed. Retrying.
        </p>
      )}
      {record && (
        <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[2.08fr_1fr]">
          <div className="min-w-0 space-y-5">
            {guarded &&
              (record.kind === "vault" || record.kind === "archived") && (
                <Panel className="gap-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2>On-chain review</h2>
                    <ReviewBadge review={review} />
                  </div>
                  {review === undefined ? (
                    <p className="text-muted-foreground">
                      The guard Review account could not be read. Refresh to try
                      again.
                    </p>
                  ) : review === null ? (
                    <p className="text-muted-foreground">
                      No review requested. The guard has no Review account for
                      this proposal, so it cannot be executed.
                    </p>
                  ) : review.status === "Pending" ? (
                    <p>
                      Review requested. Waiting for the Chainlink workflow to
                      record a verdict on-chain.
                    </p>
                  ) : (
                    <>
                      <p className="font-medium">
                        {reviewReasonText(review.reason)}
                      </p>
                      {review.expiresAt > 0 && review.status === "Approved" && (
                        <p className="caption">
                          {review.expiresAt < Date.now() / 1000
                            ? "Verdict expired "
                            : "Verdict valid until "}
                          {new Date(review.expiresAt * 1000).toLocaleString()}
                        </p>
                      )}
                    </>
                  )}
                  <p className="caption">
                    Recorded by the guard program from the Chainlink CRE report.
                    This is the authoritative verdict.{" "}
                    <Explorer address={reviewAddress} />
                  </p>
                </Panel>
              )}
            <div
              className={`rounded-xl p-6 ${supported || record.kind === "archived" ? "bg-success-bg" : "bg-danger-bg"}`}
            >
              <div className="flex items-center gap-3">
                <AssetIcon src={figmaAssets.review.imgIconShield2} size={24} />
                <h2>
                  {record.kind === "archived"
                    ? "Payment executed"
                    : configActions?.refused
                      ? GUARD_REFUSES
                      : supported
                        ? guarded && record.kind !== "config"
                          ? "Transaction decoded (preview)"
                          : "Transaction decoded"
                        : "Unable to fully decode"}
                </h2>
              </div>
              <p className="mt-3">
                {record.kind === "archived"
                  ? "This proposal has completed. Its stored payment details have been cleared by Squads."
                  : supported
                    ? "Read the exact stored actions below before signing your approval."
                    : record.kind === "batch"
                      ? "Batch approval is unavailable until every payment can be fully decoded."
                      : configActions?.refused
                        ? "This proposal includes a change the guard does not execute. Reject it and propose a supported change."
                        : decoded?.reason ||
                          "This configuration action is not supported by the preview."}
              </p>
              <p className="caption mt-3">
                {standard
                  ? "Decoded from the stored Squads transaction."
                  : record.kind === "config"
                    ? "Decoded from the stored Squads config transaction. The guard checks every action on-chain."
                    : "Local decoder preview. It never overrides the on-chain review verdict."}
              </p>
            </div>
            <Panel className="gap-5">
              <h2>
                {record.kind === "vault"
                  ? "Decoded payment"
                  : record.kind === "batch"
                    ? "Transaction batch"
                    : record.kind === "archived"
                      ? "Completed payment"
                      : "Proposed settings change"}
              </h2>
              {configActions?.headline && (
                <p className="break-words font-medium">
                  {configActions.headline.text}
                </p>
              )}
              {lines.map((line, i) => (
                <div key={i}>
                  <p className="[overflow-wrap:anywhere]">{line}</p>
                  {flags[i] && (
                    <p className="text-xs font-medium text-destructive">
                      {flags[i]}
                    </p>
                  )}
                </div>
              ))}
              {!lines.length && (
                <p className="text-muted-foreground">
                  No readable actions available.
                </p>
              )}
            </Panel>
            <Panel className="gap-5">
              <h2>Instruction breakdown</h2>
              {lines.map((line, i) => (
                <div className="flex items-start gap-3 border-t pt-4" key={i}>
                  <AssetIcon
                    src={figmaAssets.review.imgIconCheck}
                    size={20}
                    className="mt-0.5"
                  />
                  <div className="min-w-0">
                    <p className="font-medium">
                      {String(i + 1).padStart(2, "0")} ·{" "}
                      {record.kind === "config"
                        ? "Group configuration"
                        : "Payment instruction"}
                    </p>
                    <p className="mt-1 text-muted-foreground [overflow-wrap:anywhere]">
                      {line}
                    </p>
                    {flags[i] && (
                      <p className="mt-1 text-xs font-medium text-destructive">
                        {flags[i]}
                      </p>
                    )}
                  </div>
                </div>
              ))}
              <details className="group border-t pt-4">
                <summary className="flex w-fit cursor-pointer list-none items-center gap-2 rounded-md text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                  <span
                    aria-hidden="true"
                    className="transition-transform group-open:rotate-90"
                  >
                    ›
                  </span>
                  Technical details
                </summary>
                <dl className="mt-4 space-y-4">
                  <div className="space-y-1">
                    <dt className="caption">Stored transaction account</dt>
                    <dd>
                      <Explorer
                        full
                        address={record.transactionAddress.toBase58()}
                      />
                    </dd>
                  </div>
                  {record.kind === "vault" &&
                    record.transaction.message.instructions.map((ix, i) => {
                      const program =
                        record.transaction.message.accountKeys[
                          ix.programIdIndex
                        ]?.toBase58() || "Unknown";
                      return (
                        <div key={i} className="space-y-1">
                          <dt className="caption">
                            Instruction {i + 1} ·{" "}
                            {PROGRAM_NAMES[program] ?? "Program"}
                          </dt>
                          <dd className="space-y-2">
                            <Explorer full address={program} />
                            <code className="block break-all rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
                              {Array.from(ix.data, (b) =>
                                b.toString(16).padStart(2, "0"),
                              ).join("")}
                            </code>
                          </dd>
                        </div>
                      );
                    })}
                </dl>
              </details>
            </Panel>
          </div>
          <div className="min-w-0 space-y-5">
            <Panel className="gap-4">
              <h2>Member approvals</h2>
              <p className="font-medium">
                Approved: {record.proposal.approved.length} /{" "}
                {snapshot?.squad.threshold ?? "—"}
              </p>
              <div>
                <ProposalStatus status={record.proposal.status.__kind} />
              </div>
              {snapshot?.squad.members
                .filter((m) => !!(m.permissions.mask & 2))
                .map((m) => {
                  // Numbered as on the Members page (human members in order).
                  const i = snapshot.squad.members
                    .filter((h) => h.key.toBase58() !== config?.executor)
                    .findIndex((h) => h.key.equals(m.key));
                  const approved = record.proposal.approved.some((k) =>
                      k.equals(m.key),
                    ),
                    rejected = record.proposal.rejected.some((k) =>
                      k.equals(m.key),
                    );
                  return (
                    <div
                      className="flex items-center gap-3 border-t pt-3"
                      key={m.key.toBase58()}
                    >
                      <Avatar
                        initials={m.key.toBase58().slice(0, 2)}
                        size={32}
                      />
                      <p className="flex-1 text-xs">
                        {memberDisplayName(
                          m.key.toBase58(),
                          i,
                          names,
                          account?.address,
                        )}
                      </p>
                      <span
                        className={`text-xs ${approved ? "text-success" : rejected ? "text-destructive" : "text-muted-foreground"}`}
                      >
                        {approved
                          ? "Approved"
                          : rejected
                            ? "Rejected"
                            : "Pending"}
                      </span>
                    </div>
                  );
                })}
            </Panel>
            <Panel className="gap-4">
              <h2>
                {permissions.approve ? "Your approval is needed" : "Your vote"}
              </h2>
              <p className="text-muted-foreground">
                Approve only after checking every decoded action and
                destination.
              </p>
              <Button
                disabled={!enabled || !permissions.approve || !supported}
                onClick={() => void vote(BigInt(id), "approve", lines)}
              >
                Approve proposal
              </Button>
              <Button
                variant="secondary"
                disabled={!enabled || !permissions.reject}
                onClick={() => void vote(BigInt(id), "reject")}
              >
                Reject proposal
              </Button>
              {permissions.cancel && (
                <Button
                  variant="secondary"
                  disabled={!enabled}
                  onClick={() => void vote(BigInt(id), "cancel")}
                >
                  Vote to cancel
                </Button>
              )}
              {!account && (
                <p className="caption">Connect with a member wallet to vote.</p>
              )}
            </Panel>
            <Panel className="gap-4">
              <h2>
                {standard
                  ? "Execution"
                  : record.kind === "config"
                    ? "Guard check"
                    : "Guard review"}
              </h2>
              <div>
                {standard ? (
                  <StatusBadge>
                    {record.proposal.status.__kind === "Executed"
                      ? "Executed"
                      : record.proposal.status.__kind === "Approved"
                        ? "Approved by group"
                        : "Awaiting approvals"}
                  </StatusBadge>
                ) : record.kind === "vault" || record.kind === "archived" ? (
                  <ReviewBadge review={review} />
                ) : record.kind === "config" ? (
                  <StatusBadge>
                    {record.proposal.status.__kind === "Executed"
                      ? "Executed"
                      : configActions?.refused
                        ? "Refused by the guard"
                        : "Checked on-chain"}
                  </StatusBadge>
                ) : (
                  <StatusBadge>Not applicable</StatusBadge>
                )}
              </div>
              <p className="text-muted-foreground">
                {standard
                  ? "An authorized executor can apply this proposal after the required member approvals and any timelock."
                  : record.kind === "vault"
                    ? "Execution needs the Squads approvals and an unexpired Approved review. The guard enforces both on-chain."
                    : record.kind === "archived"
                      ? "This payment has been executed."
                      : record.kind === "config"
                        ? "Membership changes are checked on-chain by the guard: voters only, no spending limits."
                        : "This transaction type cannot be executed through the guard."}
              </p>
              {(standard ||
                record.kind === "vault" ||
                record.kind === "config") && (
                <Button
                  disabled={
                    !enabled ||
                    !supported ||
                    (standard
                      ? !!executionIssue
                      : !config?.settlementEnabled ||
                        record.proposal.status.__kind !== "Approved" ||
                        !(guardedConfig ? configGate.enabled : gate.enabled))
                  }
                  onClick={() => void execute(BigInt(id), lines)}
                >
                  {standard
                    ? record.kind === "config"
                      ? "Apply approved changes"
                      : "Execute payment"
                    : "Execute through guard"}
                </Button>
              )}
              {standard && executionIssue && (
                <p className="caption">{executionIssue}</p>
              )}
              {!standard && record.kind === "vault" && gate.reason && (
                <p className="caption">{gate.reason}</p>
              )}
              {guardedConfig && configGate.reason && (
                <p className="caption">{configGate.reason}</p>
              )}
              <p className="caption">
                Proposal account{" "}
                <Explorer address={record.address.toBase58()} />
              </p>
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}
