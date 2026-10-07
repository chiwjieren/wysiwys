"use client";
import type { ReactNode } from "react";
import { Inbox, RefreshCw, AlertCircle, LoaderCircle } from "lucide-react";
import { useWalletConnection } from "@/lib/auth/provider";
import { useSquad } from "@/lib/squads/provider";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/design";
import {
  reviewState,
  reviewStateLabel,
  reviewStateTone,
  type Review,
} from "@/lib/squads/review";
import { shortAddress } from "@/lib/squads/config-actions";
export { shortAddress };
export function Explorer({
  address,
  transaction = false,
  full = false,
}: {
  address: string;
  transaction?: boolean;
  full?: boolean;
}) {
  return (
    <a
      className={
        full
          ? "break-all text-xs hover:text-primary"
          : "text-xs hover:text-primary"
      }
      title={address}
      href={`https://explorer.solana.com/${transaction ? "tx" : "address"}/${address}?cluster=devnet`}
      target="_blank"
      rel="noreferrer"
    >
      {full ? address : shortAddress(address)} ↗
    </a>
  );
}
export function SquadFeedback() {
  const { error, busy, signature } = useSquad();
  const auth = useWalletConnection();
  if (!error && !auth.error && !busy && !signature) return null;
  return (
    <div
      className={`space-y-2 rounded-xl border px-4 py-3 ${error || auth.error ? "border-destructive/25 bg-danger-bg/40" : "bg-card"}`}
    >
      {auth.error && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="flex-1 break-words text-destructive">
            {auth.error}
          </p>
          {!auth.connected && (
            <Button
              variant="secondary"
              size="sm"
              disabled={!auth.ready || !!busy}
              onClick={auth.connect}
            >
              Retry connection
            </Button>
          )}
        </div>
      )}
      {error && (
        <div className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p role="alert" className="break-words text-destructive">
            {error}
          </p>
        </div>
      )}
      {busy && (
        <p role="status" className="flex items-center gap-2">
          <LoaderCircle className="size-4 motion-safe:animate-spin" />
          {signature
            ? "Confirming on Solana Devnet…"
            : "Waiting for wallet approval…"}
        </p>
      )}
      {signature && (
        <p className="caption">
          Submitted transaction <Explorer address={signature} transaction />
        </p>
      )}
    </div>
  );
}
export function RefreshButton() {
  const { refresh, busy, mode } = useSquad();
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={!!busy || mode === "loading"}
      onClick={() => void refresh()}
    >
      <RefreshCw
        className={`size-3.5 ${mode === "loading" ? "motion-safe:animate-spin" : ""}`}
      />
      Refresh
    </Button>
  );
}
export function EmptyState({
  title,
  children,
  className = "",
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex min-h-[160px] flex-col items-center justify-center gap-3 px-4 py-6 text-center ${className}`}
    >
      <span className="mb-1 flex size-11 items-center justify-center rounded-xl border bg-secondary/50 text-muted-foreground">
        <Inbox className="size-5" />
      </span>
      <h3 className="font-medium">{title}</h3>
      <p className="max-w-[440px] text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
export function ProposalStatus({ status }: { status: string }) {
  const label: Record<string, string> = {
    Active: "Needs approval",
    Approved: "Approved",
    Executed: "Executed",
    Rejected: "Rejected",
    Cancelled: "Cancelled",
    Draft: "Draft",
  };
  return (
    <StatusBadge
      tone={
        status === "Executed"
          ? "success"
          : status === "Rejected" || status === "Cancelled"
            ? "danger"
            : status === "Active"
              ? "warning"
              : "neutral"
      }
    >
      {label[status] || status}
    </StatusBadge>
  );
}
// On-chain guard Review status. `undefined` means the read is unavailable.
export function ReviewBadge({ review }: { review: Review | null | undefined }) {
  if (review === undefined)
    return <StatusBadge tone="neutral">Review unavailable</StatusBadge>;
  const state = reviewState(review, Date.now() / 1000);
  return (
    <StatusBadge tone={reviewStateTone(state)}>
      {reviewStateLabel(state)}
    </StatusBadge>
  );
}
