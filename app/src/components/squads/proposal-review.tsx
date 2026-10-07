"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { ShieldCheck, ScanLine, AlertTriangle } from "lucide-react";
import { ReviewReason } from "@wysiwys/shared";
import { CopyButton } from "@/components/dialogs";
import { paymentFields } from "@/lib/squads/review-presentation";
import { useWalletConnection } from "@/lib/auth/provider";
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
import {
  previewVaultTransaction,
  type PaymentPreview,
} from "@/lib/squads/decoded-preview";
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
import { policyProgress, readPolicyChange } from "@/lib/squads/policy";
import { policyChangePda, type PolicyV1 } from "@wysiwys/shared";
import { ProgressTracker } from "./progress-tracker";
import {
  PolicyApplyPanel,
  PolicyChangePanel,
  type PolicyDocs,
} from "./policy-change-view";

const PROGRAM_NAMES: Record<string, string> = {
  "11111111111111111111111111111111": "System program",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "Token program",
};
// Fast refresh while a proposal is moving; slow once it can no longer change.
const LIVE_MS = 5000;
const SETTLED_MS = 30000;
export function LiveProposal({ id }: { id: string }) {
  const {
    config,
    snapshot,
    account,
    error,
    busy,
    vote,
    execute,
    policyRequest,
    applyPolicyChange,
  } = useSquad();
  const auth = useWalletConnection();
  const { names } = useMemberNames(config?.multisig);
  const [record, setRecord] = useState<ProposalRecord | null>();
  const [readError, setReadError] = useState("");
  const [decoded, setDecoded] = useState<PaymentPreview>();
  // On-chain guard Review: undefined = not loaded or unreadable, null = none.
  const [review, setReview] = useState<Review | null>();
  const guarded = isGuarded(config);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  // Policy change proposals: applied on chain (PolicyChange record exists) and the member-only documents.
  const [policyApplied, setPolicyApplied] = useState(false);
  const [policyDocs, setPolicyDocs] = useState<PolicyDocs>();
  const [policyLoading, setPolicyLoading] = useState(false);
  const [policyError, setPolicyError] = useState("");
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
    setPolicyApplied(false);
    setPolicyDocs(undefined);
    setPolicyError("");
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
        // Decode the exact stored bytes; a Review's tx_hash must match them.
        const preview =
          result?.kind === "vault" && vault
            ? await previewVaultTransaction(
                rpc,
                {
                  address: result.transactionAddress,
                  data: result.transactionData,
                },
                vault,
                onChainReview?.txHash,
                config.token,
              )
            : undefined;
        const change =
          result?.kind === "vault" && isGuarded(config)
            ? readPolicyChange(
                result.transaction.message,
                new PublicKey(config.guardProgram!),
              )
            : null;
        const applied = change
          ? !!(await rpc.getAccountInfo(
              policyChangePda(
                new PublicKey(config.guardProgram!),
                new PublicKey(config.multisig),
                BigInt(id),
              ),
              "finalized",
            ))
          : false;
        const status = result?.proposal.status.__kind;
        settled =
          applied ||
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
          setPolicyApplied(applied);
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
      if (!cancelled)
        timer = setTimeout(() => void load(), settled ? SETTLED_MS : LIVE_MS);
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
  const policyChange =
    record?.kind === "vault" && guarded
      ? readPolicyChange(
          record.transaction.message,
          new PublicKey(config!.guardProgram!),
        )
      : null;
  const approvedAt =
    record?.proposal.status.__kind === "Approved"
      ? Number(
          (
            record.proposal.status as { timestamp: { toString(): string } }
          ).timestamp.toString(),
        )
      : null;
  const policySteps =
    policyChange && record
      ? policyProgress({
          proposalStatus: record.proposal.status.__kind,
          approvals: record.proposal.approved.length,
          threshold: snapshot?.squad.threshold ?? null,
          approvedAt,
          timeLock: snapshot?.squad.timeLock ?? 0,
          applied: policyApplied,
          nowSeconds: Date.now() / 1000,
        })
      : null;
  // The approval names the policy the member reviewed (the provider checks the hash is in these lines).
  const policyVoteLines = policyChange
    ? [`Policy change to ${policyChange.newPolicyHash}`]
    : [];
  async function loadPolicyDocs() {
    if (!policyChange || !config) return;
    setPolicyLoading(true);
    setPolicyError("");
    try {
      const r = await policyRequest<{
        document: PolicyV1 | null;
        baseDocument: PolicyV1 | null;
      }>({
        action: "read",
        multisig: config.multisig,
        index: id,
      });
      setPolicyDocs({ current: r.baseDocument, next: r.document });
    } catch (e) {
      setPolicyError(
        e instanceof Error ? e.message : "The policy could not be loaded.",
      );
    } finally {
      setPolicyLoading(false);
    }
  }
  const supported = policyChange
    ? true
    : configActions
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
  const fields = record?.kind === "vault" ? paymentFields(decoded) : null;
  const rejected = guarded && review?.status === "Rejected";
  const wrongRecipient =
    rejected &&
    review.reason === ReviewReason.DESTINATION_NOT_WHITELISTED &&
    fields;
  return (
    <div className="page-stack">
      <PageHeader
        title={`Proposal #${id}`}
        description={
          policyChange
            ? "Review a proposed change to the payment policy."
            : record?.kind === "config"
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
          steps={
            policySteps ??
            proposalProgress({
              kind: record.kind,
              guarded,
              proposalStatus: record.proposal.status.__kind,
              approvals: record.proposal.approved.length,
              threshold: snapshot?.squad.threshold ?? null,
              review,
              nowSeconds: Date.now() / 1000,
            })
          }
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
            {policyChange ? (
              <PolicyChangePanel
                change={policyChange}
                docs={policyDocs}
                loading={policyLoading}
                error={policyError}
                token={config?.token}
                onLoad={() => void loadPolicyDocs()}
              />
            ) : (
              <>
                {guarded &&
                  (record.kind === "vault" || record.kind === "archived") && (
                    <Panel
                      className={`gap-4 border-l-[3px] ${rejected ? "border-l-destructive bg-danger-bg/20" : "border-l-primary"}`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <h2 className="flex items-center gap-2">
                          <ShieldCheck
                            className={`size-5 ${rejected ? "text-destructive" : "text-primary"}`}
                          />
                          On-chain review
                        </h2>
                        <ReviewBadge review={review} />
                      </div>
                      {review === undefined ? (
                        <p className="text-muted-foreground">
                          The guard Review account could not be read. Refresh to
                          try again.
                        </p>
                      ) : review === null ? (
                        <p className="text-muted-foreground">
                          No review requested. The guard has no Review account
                          for this proposal, so it cannot be executed.
                        </p>
                      ) : review.status === "Pending" ? (
                        <p>
                          Review requested. Waiting for the Chainlink workflow
                          to record a verdict on-chain.
                        </p>
                      ) : (
                        <>
                          <p className="font-medium">
                            {reviewReasonText(review.reason)}
                          </p>
                          {review.expiresAt > 0 &&
                            review.status === "Approved" && (
                              <p className="caption">
                                {review.expiresAt < Date.now() / 1000
                                  ? "Verdict expired "
                                  : "Verdict valid until "}
                                {new Date(
                                  review.expiresAt * 1000,
                                ).toLocaleString()}
                              </p>
                            )}
                        </>
                      )}
                      <p className="caption">
                        Recorded by the guard program from the Chainlink CRE
                        report. This is the authoritative verdict.{" "}
                        <Explorer address={reviewAddress} />
                      </p>
                      {wrongRecipient && (
                        <div className="space-y-3 rounded-xl border border-destructive/25 bg-danger-bg/40 p-4">
                          <p className="flex items-center gap-2 font-medium text-destructive">
                            <AlertTriangle className="size-4" />
                            Recipient is not approved
                          </p>
                          <p className="break-all font-mono text-xs leading-5">
                            {fields.recipient}
                          </p>
                          <p className="caption">
                            The Guard rejected this recipient wallet. Member
                            votes cannot override the verdict. Check the
                            destination and propose a new payment.
                          </p>
                        </div>
                      )}
                    </Panel>
                  )}
                <div
                  className={`rounded-2xl border p-5 sm:p-6 ${supported || record.kind === "archived" ? "bg-card" : "border-destructive/30 bg-danger-bg/40"}`}
                >
                  <div className="flex items-center gap-3">
                    <ScanLine className="size-5 text-muted-foreground" />
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
                  {fields && (
                    <div className="space-y-5">
                      <div>
                        <p className="eyebrow">Treasury payment</p>
                        <p className="mt-2 text-[36px] leading-tight font-semibold tracking-[-0.04em]">
                          {fields.amount}
                        </p>
                      </div>
                      <div
                        className={`rounded-xl border p-4 ${wrongRecipient ? "border-destructive/30 bg-danger-bg/30" : "bg-background/40"}`}
                      >
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                          <p className="eyebrow">Recipient wallet</p>
                          <CopyButton
                            value={fields.recipient}
                            label="Copy recipient"
                            className="h-8 px-3 text-xs"
                          />
                        </div>
                        <p className="break-all font-mono text-sm leading-6">
                          {fields.recipient}
                        </p>
                        {wrongRecipient && (
                          <p className="mt-3 text-xs text-destructive">
                            Not approved by the Guard policy
                          </p>
                        )}
                      </div>
                      <dl className="grid gap-4 sm:grid-cols-2">
                        <div>
                          <dt className="caption">
                            {fields.tokenAddress
                              ? "From treasury token account"
                              : "From"}
                          </dt>
                          <dd className="mt-1 break-all font-mono text-xs">
                            {fields.source}
                          </dd>
                        </div>
                        {fields.tokenAddress && (
                          <div>
                            <dt className="caption">Token address</dt>
                            <dd className="mt-1 break-all font-mono text-xs">
                              {fields.tokenAddress}
                            </dd>
                          </div>
                        )}
                        {fields.destinationAccount && (
                          <div className="sm:col-span-2">
                            <dt className="caption">
                              Recipient&apos;s token account
                            </dt>
                            <dd className="mt-1 break-all font-mono text-xs">
                              {fields.destinationAccount}
                            </dd>
                          </div>
                        )}
                      </dl>
                    </div>
                  )}
                  {lines.map((line, i) =>
                    fields && line.startsWith("Send ") ? null : (
                      <div key={i}>
                        <p className="[overflow-wrap:anywhere]">{line}</p>
                        {flags[i] && (
                          <p className="text-xs font-medium text-destructive">
                            {flags[i]}
                          </p>
                        )}
                      </div>
                    ),
                  )}
                  {!lines.length && (
                    <p className="text-muted-foreground">
                      No readable actions available.
                    </p>
                  )}
                </Panel>
              </>
            )}
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
                  <span>Technical details</span>
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
                  {record.kind === "vault" && decoded?.txHash && (
                    <div className="space-y-1">
                      <dt className="caption">Transaction hash (tx_hash)</dt>
                      <dd className="space-y-1">
                        <code className="block break-all rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
                          {decoded.txHash}
                        </code>
                        <p className="caption">
                          {!review
                            ? "Computed from the stored account bytes with the shared tx_hash encoding."
                            : Array.from(review.txHash, (b) =>
                                  b.toString(16).padStart(2, "0"),
                                ).join("") === decoded.txHash
                              ? "Matches the transaction hash in the guard Review."
                              : "Differs from the transaction hash in the guard Review. Approval is blocked."}
                        </p>
                      </dd>
                    </div>
                  )}
                  {record.kind === "vault" && decoded?.decoded && (
                    <div className="space-y-1">
                      <dt className="caption">
                        Decoder output (@wysiwys/decoder)
                      </dt>
                      <dd>
                        <pre
                          data-testid="decoder-json"
                          className="max-h-80 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground"
                        >
                          {JSON.stringify(decoded.decoded, null, 2)}
                        </pre>
                      </dd>
                    </div>
                  )}
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
          <div className="min-w-0 space-y-5 xl:sticky xl:top-6">
            <Panel className="gap-4">
              <h2>Member approvals</h2>
              <p className="font-medium">
                Approved: {record.proposal.approved.length} /{" "}
                {snapshot?.squad.threshold ?? "—"}
              </p>
              {snapshot && (
                <div
                  role="progressbar"
                  aria-label="Member approvals"
                  aria-valuemin={0}
                  aria-valuemax={snapshot.squad.threshold}
                  aria-valuenow={Math.min(
                    record.proposal.approved.length,
                    snapshot.squad.threshold,
                  )}
                  className="h-1.5 overflow-hidden rounded-full bg-secondary"
                >
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{
                      width: `${Math.min(100, (record.proposal.approved.length / snapshot.squad.threshold) * 100)}%`,
                    }}
                  />
                </div>
              )}
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
                {rejected
                  ? "The Guard rejected this payment. Your vote cannot override its verdict."
                  : "Approve only after checking every decoded action and destination."}
              </p>
              <Button
                variant={rejected ? "secondary" : "default"}
                disabled={!enabled || !permissions.approve || !supported}
                onClick={() =>
                  void vote(
                    BigInt(id),
                    "approve",
                    policyChange ? policyVoteLines : lines,
                  )
                }
              >
                Approve proposal
              </Button>
              <Button
                variant={rejected ? "default" : "secondary"}
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
                <>
                  <p className="caption">
                    Connect with a member wallet to vote.
                  </p>
                  <Button
                    variant="outline"
                    disabled={!auth.ready || !!busy}
                    onClick={auth.connect}
                  >
                    Connect wallet to vote
                  </Button>
                </>
              )}
            </Panel>
            {policyChange && policySteps ? (
              <PolicyApplyPanel
                step={policySteps[3]!}
                enabled={
                  !!account && !busy && policySteps[3]!.state === "active"
                }
                onApply={() => void applyPolicyChange(BigInt(id))}
              />
            ) : (
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
            )}
          </div>
        </div>
      )}
    </div>
  );
}
