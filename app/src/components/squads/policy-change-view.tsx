"use client";
import type { PolicyV1 } from "@wysiwys/shared";
import { Panel } from "@/components/design";
import { Button } from "@/components/ui/button";
import { diffPolicies, type PolicyToken } from "@/lib/squads/policy";
import type { ProgressStep } from "@/lib/squads/progress";

const short = (hash: string) => `${hash.slice(0, 8)}…${hash.slice(-8)}`;
export type PolicyDocs = { current: PolicyV1 | null; next: PolicyV1 | null };

/** What a policy change proposal does, read by members before they vote (the documents are private). */
export function PolicyChangePanel(p: {
  change: { newPolicyHash: string; expectedPolicyHash: string };
  docs?: PolicyDocs;
  loading: boolean;
  error: string;
  token?: PolicyToken;
  onLoad: () => void;
}) {
  return (
    <Panel className="gap-4">
      <h2>Policy change</h2>
      <p className="caption">
        Replaces policy{" "}
        <span className="font-mono">{short(p.change.expectedPolicyHash)}</span>{" "}
        with <span className="font-mono">{short(p.change.newPolicyHash)}</span>.
        The guard applies it only after the vote and the waiting period, and
        only if the treasury is still on the replaced policy.
      </p>
      {!p.docs ? (
        <div>
          <Button variant="outline" disabled={p.loading} onClick={p.onLoad}>
            {p.loading ? "Loading…" : "Show the change"}
          </Button>
          <p className="caption mt-2">
            Your wallet signs a read request; only members can see the policy.
          </p>
        </div>
      ) : !p.docs.next ? (
        <p className="text-sm text-destructive">
          The proposed document is not on file, so this change cannot be read.
          Do not approve a policy you cannot see.
        </p>
      ) : (
        <ul className="space-y-1 text-sm">
          {diffPolicies(p.docs.current, p.docs.next, p.token).map((line) => (
            <li key={line} className="[overflow-wrap:anywhere]">
              {line}
            </li>
          ))}
        </ul>
      )}
      {p.error && (
        <p role="alert" className="text-sm text-destructive">
          {p.error}
        </p>
      )}
    </Panel>
  );
}

/** Applies an approved policy change once the waiting period has passed (anyone may submit it). */
export function PolicyApplyPanel(p: {
  step: ProgressStep;
  enabled: boolean;
  onApply: () => void;
}) {
  return (
    <Panel className="gap-4">
      <h2>Apply the change</h2>
      <p className="text-muted-foreground">
        The guard checks the Squads vote, the waiting period and that the policy
        has not changed since, then switches the treasury to the new policy.
        Payments approved under the old policy can no longer execute.
      </p>
      <Button disabled={!p.enabled} onClick={p.onApply}>
        Apply policy change
      </Button>
      <p className="caption">{p.step.detail}</p>
      <p className="caption">
        Reviews switch to the new policy as soon as it is applied: the Chainlink
        workflow fetches it by the hash the guard now holds.
      </p>
    </Panel>
  );
}
