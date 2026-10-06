"use client";
import Link from "next/link";
import { Panel, SectionTitle } from "@/components/design";
import { Button } from "@/components/ui/button";
import { useSquad } from "@/lib/squads/provider";
import { previewMessage } from "@/lib/squads/payments";
import { EmptyState, ProposalStatus, ReviewBadge } from "./treasury-ui";
import { isGuarded } from "@/lib/squads/review";
import type { ProposalRecord } from "@/lib/squads/sdk";
export function ProposalTable({
  records,
  title = "Transactions",
  compact = false,
}: {
  records: ProposalRecord[];
  title?: string;
  compact?: boolean;
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
              const decoded =
                record.kind === "vault" && snapshot
                  ? previewMessage(record.transaction.message, snapshot.vault)
                  : undefined;
              const payment =
                record.kind === "config"
                  ? record.transaction.actions
                      .map((a) =>
                        a.__kind === "ChangeThreshold"
                          ? `Set threshold to ${a.newThreshold}`
                          : a.__kind === "AddMember"
                            ? "Invite member"
                            : a.__kind,
                      )
                      .join(", ")
                  : record.kind === "archived"
                    ? "Details cleared after execution"
                    : record.kind === "batch"
                      ? `${record.transaction.size} transactions`
                      : decoded?.supported
                        ? decoded.lines
                            .find((l) => l.startsWith("Send "))
                            ?.split(" from ")[0]
                        : "Needs inspection";
              return (
                <tr key={id}>
                  <td>
                    <p className="font-medium">
                      #{id} ·{" "}
                      {record.kind === "vault"
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
                    (record.kind === "vault" || record.kind === "archived") ? (
                      <ReviewBadge review={snapshot?.reviews?.[id]} />
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
      {!records.length && (
        <EmptyState
          title={compact ? "No pending approvals" : "No transactions yet"}
        >
          {compact
            ? "Payments waiting for your team’s approval will appear here."
            : "Propose a payment to review its details and collect your team’s approvals."}
        </EmptyState>
      )}
    </Panel>
  );
}
