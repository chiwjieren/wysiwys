"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
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
import { assertStandardExecution } from "@/lib/squads/execution";
import { figmaAssets } from "@/lib/figma-assets";
import {
  Explorer,
  SquadFeedback,
  EmptyState,
  ProposalStatus,
} from "./treasury-ui";
export function LiveProposal({ id }: { id: string }) {
  const { config, snapshot, account, error, busy, vote, execute } = useSquad();
  const [record, setRecord] = useState<ProposalRecord | null>();
  const [readError, setReadError] = useState("");
  const [decoded, setDecoded] = useState<PaymentPreview>();
  useEffect(() => {
    let cancelled = false;
    setRecord(undefined);
    setDecoded(undefined);
    setReadError("");
    async function load() {
      if (!config) return;
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
        const preview =
          result?.kind === "vault" && snapshot
            ? await readPaymentPreview(
                rpc,
                result.transaction.message,
                snapshot.vault,
              )
            : undefined;
        if (!cancelled) {
          setDecoded(preview);
          setRecord(result);
          setReadError("");
        }
      } catch (e) {
        if (!cancelled) {
          setRecord(undefined);
          setReadError(
            e instanceof Error ? e.message : "Could not load this proposal.",
          );
        }
      }
    }
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [config, id, snapshot]);
  const configLines =
    record?.kind === "config"
      ? record.transaction.actions.map((a) =>
          a.__kind === "ChangeThreshold"
            ? `Change required approvals to ${a.newThreshold}.`
            : a.__kind === "AddMember"
              ? `Invite ${a.newMember.key.toBase58()} with ${a.newMember.permissions.mask & 1 ? "proposal " : ""}${a.newMember.permissions.mask & 2 ? "voting " : ""}${a.newMember.permissions.mask & 4 ? "execution " : ""}permissions.`
              : `Configuration action: ${a.__kind}.`,
        )
      : [];
  const supported =
    record?.kind === "config"
      ? record.transaction.actions.length > 0 &&
        record.transaction.actions.every(
          (a) => a.__kind === "ChangeThreshold" || a.__kind === "AddMember",
        )
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
        <div className="grid items-start gap-6 xl:grid-cols-[2.08fr_1fr]">
          <div className="space-y-5">
            <div
              className={`rounded-xl p-6 ${supported || record.kind === "archived" ? "bg-success-bg" : "bg-danger-bg"}`}
            >
              <div className="flex items-center gap-3">
                <AssetIcon src={figmaAssets.review.imgIconShield2} size={24} />
                <h2>
                  {record.kind === "archived"
                    ? "Payment executed"
                    : supported
                      ? "Transaction decoded"
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
                      : decoded?.reason ||
                        "This configuration action is not supported by the preview."}
              </p>
              <p className="caption mt-3">
                {standard
                  ? "Decoded from the stored Squads transaction."
                  : "Local preview · Separate from the Guard’s policy verdict."}
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
              {lines.map((line, i) => (
                <p className="break-words" key={i}>
                  {line}
                </p>
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
                <div className="flex gap-3 border-t pt-4" key={i}>
                  <AssetIcon src={figmaAssets.review.imgIconCheck} size={20} />
                  <div>
                    <p className="font-medium">
                      {String(i + 1).padStart(2, "0")} ·{" "}
                      {record.kind === "config"
                        ? "Group configuration"
                        : "Payment instruction"}
                    </p>
                    <p className="mt-1 break-words text-muted-foreground">
                      {line}
                    </p>
                  </div>
                </div>
              ))}
              <details className="border-t pt-4">
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  Technical details
                </summary>
                <div className="mt-4 space-y-3">
                  <Explorer
                    full
                    address={record.transactionAddress.toBase58()}
                  />
                  {record.kind === "vault" &&
                    record.transaction.message.instructions.map((ix, i) => (
                      <div key={i} className="space-y-1">
                        <p className="caption">Instruction {i + 1} · program</p>
                        <Explorer
                          full
                          address={
                            record.transaction.message.accountKeys[
                              ix.programIdIndex
                            ]?.toBase58() || "Unknown"
                          }
                        />
                        <p className="caption break-all">
                          Data:{" "}
                          {Array.from(ix.data, (b) =>
                            b.toString(16).padStart(2, "0"),
                          ).join("")}
                        </p>
                      </div>
                    ))}
                </div>
              </details>
            </Panel>
          </div>
          <div className="space-y-5">
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
                .map((m, i) => {
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
                        {m.key.toBase58() === account?.address
                          ? "Your wallet · You"
                          : `Member ${i + 1}`}
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
              <h2>{standard ? "Execution" : "Guard review"}</h2>
              <div>
                <StatusBadge>
                  {standard
                    ? record.proposal.status.__kind === "Executed"
                      ? "Executed"
                      : record.proposal.status.__kind === "Approved"
                        ? "Approved by group"
                        : "Awaiting approvals"
                    : "Pending integration"}
                </StatusBadge>
              </div>
              <p className="text-muted-foreground">
                {standard
                  ? "An authorized executor can apply this proposal after the required member approvals and any timelock."
                  : record.kind === "vault"
                    ? "Member votes and Guard approval are separate. No on-chain policy verdict is available yet."
                    : "Approved settings require protected configuration execution."}
              </p>
              {(standard || record.kind === "vault") && (
                <Button
                  disabled={
                    !enabled ||
                    !supported ||
                    (standard
                      ? !!executionIssue
                      : !config?.settlementEnabled ||
                        record.proposal.status.__kind !== "Approved")
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
