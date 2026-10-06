"use client";
import Link from "next/link";
import { Panel, SectionTitle, StatusBadge } from "@/components/design";
import { useSquad } from "@/lib/squads/provider";
import { useRunnerPoll } from "@/lib/runner/client";
import type { RunnerReviews } from "@/lib/runner/types";
import { isGuarded, reviewReasonText } from "@/lib/squads/review";
import { EmptyState } from "./treasury-ui";
const unavailable: RunnerReviews = {
  configured: true,
  reachable: false,
  error: "Review history could not be loaded.",
  reviews: [],
};
const tones = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
  executed: "success",
} as const;
const labels = {
  pending: "Pending review",
  approved: "Approved",
  rejected: "Rejected",
  executed: "Executed",
} as const;
// Review history from the runner database. On-chain Review accounts, shown on
// each proposal, are authoritative when the two disagree.
export function RecentReviews() {
  const { config } = useSquad();
  const data = useRunnerPoll<RunnerReviews>("/api/runner/reviews", unavailable);
  if (!isGuarded(config)) return null;
  const feed = data && "configured" in data ? data : data && unavailable;
  const matches =
    feed?.configured && feed.reachable && feed.multisig === config?.multisig;
  return (
    <Panel className="gap-4">
      <SectionTitle>Recent reviews</SectionTitle>
      <p className="caption">
        History from the review runner. The on-chain review on each proposal is
        authoritative.
      </p>
      {!feed ? (
        <p role="status">Loading review history…</p>
      ) : !feed.configured ? (
        <EmptyState title="Runner not configured" className="min-h-[64px] py-2">
          Review history appears here once the runner is connected.
        </EmptyState>
      ) : !feed.reachable ? (
        <EmptyState title="Runner offline" className="min-h-[64px] py-2">
          {feed.error}
        </EmptyState>
      ) : !matches || !feed.reviews.length ? (
        <EmptyState title="No reviews yet" className="min-h-[64px] py-2">
          Guard reviews for this treasury will appear here.
        </EmptyState>
      ) : (
        feed.reviews.slice(0, 10).map((r) => (
          <div
            key={r.review}
            className="flex flex-wrap items-center gap-3 border-t pt-4"
          >
            <StatusBadge tone={tones[r.status]}>{labels[r.status]}</StatusBadge>
            <p className="min-w-[200px] flex-1">
              Proposal #{r.txIndex}
              {r.reason !== null && r.status !== "pending" && (
                <span className="text-muted-foreground">
                  {" "}
                  · {reviewReasonText(r.reason)}
                </span>
              )}
              {r.status === "pending" && r.triggerStatus === "failed" && (
                <span className="text-destructive">
                  {" "}
                  · Workflow trigger failed
                </span>
              )}
            </p>
            <span className="caption">
              {new Date(r.updatedAt * 1000).toLocaleString()}
            </span>
            <Link
              className="caption hover:text-primary"
              href={`/transactions/${r.txIndex}`}
            >
              View details →
            </Link>
          </div>
        ))
      )}
    </Panel>
  );
}
