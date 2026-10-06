"use client";
import { PageHeader, Panel } from "@/components/design";
import { SquadFeedback } from "@/components/squads/live-squad";
import { useSquad } from "@/lib/squads/provider";
import { useWalletConnection } from "@/lib/auth/provider";
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
    </div>
  );
}
