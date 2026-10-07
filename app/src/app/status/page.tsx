"use client";
import { useEffect, useState } from "react";
import { PageHeader, Panel } from "@/components/design";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SquadFeedback } from "@/components/squads/live-squad";
import { useSquad } from "@/lib/squads/provider";
import { useWalletConnection } from "@/lib/auth/provider";
import { useRunnerPoll } from "@/lib/runner/client";
import type {
  RunnerReviewMode,
  RunnerReviewPath,
  RunnerStatus,
} from "@/lib/runner/types";
const PATH_LABEL: Record<RunnerReviewMode, string> = {
  live: "Live Chainlink DON",
  simulator: "Simulator (backup)",
};
function ReviewPathSwitch({ path }: { path: RunnerReviewPath }) {
  // The last switch result shows until the next status poll reports the same mode.
  const [switched, setSwitched] = useState<RunnerReviewMode | null>(null);
  // A newer poll is authoritative (another operator may have switched since).
  useEffect(() => setSwitched(null), [path.mode]);
  const mode = switched ?? path.mode;
  const target: RunnerReviewMode = mode === "live" ? "simulator" : "live";
  const canSwitch = path.available.includes(target);
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/runner/mode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: target, token }),
      });
      const body = (await response.json()) as
        | { reviewPath: RunnerReviewPath }
        | { error: string };
      if ("reviewPath" in body) {
        setSwitched(body.reviewPath.mode);
        setOpen(false);
        setMessage(
          `Switched to ${PATH_LABEL[body.reviewPath.mode]}. Only treasuries on this path are reviewed now.`,
        );
      } else setMessage(body.error);
    } catch {
      setMessage("The switch could not be sent.");
    } finally {
      setToken("");
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <p>
        Review path: <strong>{PATH_LABEL[mode]}</strong>
      </p>
      {canSwitch && !open && (
        <div>
          <Button
            variant="outline"
            onClick={() => {
              setOpen(true);
              setMessage(null);
            }}
          >
            Switch to {PATH_LABEL[target]}
          </Button>
        </div>
      )}
      {open && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={submit}>
          <Input
            type="password"
            autoComplete="off"
            aria-label="Operator token"
            placeholder="Operator token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="max-w-xs"
          />
          <Button type="submit" disabled={busy || !token}>
            {busy ? "Switching…" : `Switch to ${PATH_LABEL[target]}`}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setOpen(false);
              setToken("");
            }}
          >
            Cancel
          </Button>
        </form>
      )}
      {message && (
        <p className="caption" role="status">
          {message}
        </p>
      )}
      <p className="caption">
        Each treasury is bound to one path by its guard config. The runner
        reviews only treasuries on the selected path; payments on the other
        path wait until you switch back.
      </p>
    </div>
  );
}
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
          {runner.reviewPath && <ReviewPathSwitch path={runner.reviewPath} />}
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
