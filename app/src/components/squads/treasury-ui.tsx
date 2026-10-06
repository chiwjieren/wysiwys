"use client";
import type { ReactNode } from "react";
import { useWalletConnection } from "@/lib/auth/provider";
import { useSquad } from "@/lib/squads/provider";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/design";
export const shortAddress = (address: string) =>
  `${address.slice(0, 4)}…${address.slice(-4)}`;
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
    <div className="space-y-2 rounded-lg border px-4 py-3">
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
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      )}
      {busy && (
        <p role="status">
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
      className={`flex min-h-[112px] flex-col items-center justify-center gap-2 px-4 py-6 text-center ${className}`}
    >
      <p className="font-medium">{title}</p>
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
