"use client";
import { isPolicyChangeRecord } from "@/lib/squads/policy";
import Link from "next/link";
import { Panel, SectionTitle } from "@/components/design";
import { Button } from "@/components/ui/button";
import { useSquad } from "@/lib/squads/provider";
import { decodeVaultTransaction } from "@wysiwys/decoder";
import { assetLabel } from "@/lib/squads/payments";
import { paymentLabel } from "@/lib/squads/decoded-preview";
import { EmptyState, ProposalStatus, ReviewBadge } from "./treasury-ui";
import { isGuarded } from "@/lib/squads/review";
import { describeConfigActions } from "@/lib/squads/config-actions";
import type { ProposalRecord } from "@/lib/squads/sdk";
export function ProposalTable({
  records,
  title = "Transactions",
  compact = false,
  filtered = false,
  onReset,
}: {
  records: ProposalRecord[];
  title?: string;
  compact?: boolean;
  filtered?: boolean;
  onReset?: () => void;
}) {
  const { config, snapshot } = useSquad();
  return (
    <Panel className="gap-5">
      <SectionTitle
        action={
          compact ? (
            <Button variant="secondary" asChild>
              <Link href="/transactions">View all</Link>
            </Button>
          ) : undefined
        }
      >
        {title}
      </SectionTitle>
      {!!records.length && (
        <div className="table-scroll">
          <table className="data-table min-w-[710px]">
            <thead>
              <tr>
                <th>Transaction</th>
                <th>Payment / action</th>
                <th>
                  {config?.executionMode === "standard"
                    ? "Transaction review"
                    : "Guard review"}
                </th>
                <th>Approvals</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {records.map((record) => {
                const id = record.proposal.transactionIndex.toString();
                const policyChange = isPolicyChangeRecord(
                  record,
                  config?.guardProgram,
                );
                // List label from the decoder's actions; the review page shows the full checks.
                const decodedLabel =
                  record.kind === "vault" && !policyChange
                    ? paymentLabel(
                        decodeVaultTransaction(record.transactionData),
                        (mint) => assetLabel(config, mint),
                      )
                    : undefined;
                const payment = policyChange
                  ? "Payment policy update"
                  : record.kind === "config"
                    ? describeConfigActions(
                        record.transaction.actions,
                        isGuarded(config) ? config?.executor : undefined,
                      ).listLabel
                    : record.kind === "archived"
                      ? "Details cleared after execution"
                      : record.kind === "batch"
                        ? `${record.transaction.size} transactions`
                        : (decodedLabel ?? "Needs inspection");
                return (
                  <tr key={id}>
                    <td>
                      <p className="font-medium">
                        #{id} ·{" "}
                        {policyChange
                          ? "Policy change"
                          : record.kind === "vault"
                            ? "Payment"
                            : record.kind === "batch"
                              ? "Batch"
                              : record.kind === "archived"
                                ? "Executed payment"
                                : "Group settings"}
                      </p>
                      <p className="caption">Solana Devnet</p>
                    </td>
                    <td>
                      <p className="max-w-[240px] truncate" title={payment}>
                        {payment}
                      </p>
                    </td>
                    <td>
                      {isGuarded(config) &&
                      (record.kind === "vault" ||
                        record.kind === "archived") ? (
                        <ReviewBadge review={snapshot?.reviews?.[id]} />
                      ) : isGuarded(config) && record.kind === "config" ? (
                        <span className="caption">Guard check on-chain</span>
                      ) : (
                        <span className="caption">
                          {config?.executionMode === "standard"
                            ? "Review details"
                            : "Not applicable"}
                        </span>
                      )}
                    </td>
                    <td>
                      {record.proposal.approved.length} /{" "}
                      {snapshot?.squad.threshold ?? "—"}
                    </td>
                    <td>
                      <ProposalStatus status={record.proposal.status.__kind} />
                    </td>
                    <td className="text-right">
                      <Button variant="secondary" asChild>
                        <Link
                          aria-label={`Inspect proposal #${id}`}
                          href={`/transactions/${id}`}
                        >
                          Review
                        </Link>
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!records.length && (
        <EmptyState
          title={
            filtered
              ? "No matching transactions"
              : compact
                ? "No pending approvals"
                : "No transactions yet"
          }
        >
          {filtered
            ? "Try another proposal number or status, or reset the filters."
            : compact
              ? "Payments waiting for your team’s approval will appear here."
              : "Propose a payment to review its details and collect your team’s approvals."}
        </EmptyState>
      )}
      {!records.length && filtered && (
        <Button variant="secondary" className="mx-auto" onClick={onReset}>
          Reset filters
        </Button>
      )}
    </Panel>
  );
}
