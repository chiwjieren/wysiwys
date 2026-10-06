"use client";
import { PageHeader, Panel } from "@/components/design";
import { SquadFeedback } from "@/components/squads/live-squad";
import { useSquad } from "@/lib/squads/provider";
import { useWalletConnection } from "@/lib/auth/provider";
import { useRunnerPoll } from "@/lib/runner/client";
import type { RunnerStatus } from "@/lib/runner/types";
const unavailable: RunnerStatus = {
  configured: true,
  reachable: false,
  ok: false,
  error: "Runner status could not be loaded.",
};
function RunnerPanel() {
  const status = useRunnerPoll<RunnerStatus>("/api/runner/status", unavailable);
  const runner =
    status && "configured" in status ? status : status && unavailable;
  return (
    <Panel className="gap-4">
      <h2>Runner</h2>
      {!runner ? (
        <p role="status">Checking runner…</p>
      ) : !runner.configured ? (
        <p>Runner not configured</p>
      ) : !runner.reachable ? (
        <p>
          Runner offline. <span className="caption">{runner.error}</span>
        </p>
      ) : (
        <>
          <p>Runner: {runner.ok ? "Online" : "Online, unhealthy"}</p>
          <p>
            Listener:{" "}
            {runner.listener.subscribed ? "Subscribed" : "Not subscribed"}
          </p>
          <p>
            Last backfill:{" "}
            {runner.listener.lastBackfillAt
              ? new Date(runner.listener.lastBackfillAt).toLocaleString()
              : "Not yet"}
            {runner.listener.backfillMessage && (
              <span className="caption text-destructive">
                {" "}
                {runner.listener.backfillMessage}
              </span>
            )}
          </p>
          <p>
            Reviews: {runner.reviews.pending} pending, {runner.reviews.approved}{" "}
            approved, {runner.reviews.rejected} rejected,{" "}
            {runner.reviews.executed} executed
          </p>
        </>
      )}
      <p className="caption">
        The runner listens for review requests and starts the Chainlink CRE
        workflow. If it is offline, reviews do not start and guarded payments
        cannot execute. Its counts are history; on-chain Review accounts are
        authoritative.
      </p>
    </Panel>
  );
}
export default function Status() {
  const { config, snapshot, mode } = useSquad();
  const auth = useWalletConnection();
  return (
    <div className="page-stack">
      <PageHeader title="Status" description="Current frontend connections" />
      <SquadFeedback />
      <Panel className="gap-4">
        <p>
          Wallet login:{" "}
          {auth.configured
            ? auth.ready
              ? "Ready"
              : "Initializing"
            : "Not configured"}
        </p>
        <p>
          Squads chain state:{" "}
          {snapshot
            ? "Finalized devnet state loaded"
            : mode === "unconfigured"
              ? "No treasury selected"
              : "Unavailable"}
        </p>
        <p>
          Settlement integration:{" "}
          {config?.settlementEnabled ? "Configured" : "Unavailable"}
        </p>
        <p className="caption">
          {config?.executionMode === "standard"
            ? "Standard Squads execution is enabled for this group. Guard policy checks are not active."
            : "Connection configuration does not verify Guard health or a policy verdict."}
        </p>
      </Panel>
      <RunnerPanel />
    </div>
  );
}
