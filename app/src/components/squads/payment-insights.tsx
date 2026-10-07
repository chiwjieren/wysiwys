"use client";
import { useState } from "react";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import type { PolicyV1 } from "@wysiwys/shared";
import { Button } from "@/components/ui/button";
import { useSquad } from "@/lib/squads/provider";
import { useMemberNames } from "@/lib/squads/member-names";
import { isGuarded } from "@/lib/squads/review";
import type { PaymentPreview } from "@/lib/squads/decoded-preview";
import {
  paymentInsights,
  type KnownAddress,
} from "@/lib/squads/payment-insights";

type PolicyFacts = { whitelist: string[]; cap: string };
// Remembered for this browser session so members sign the policy request once per treasury.
const policyCache = new Map<string, PolicyFacts | null>();

const ICONS = {
  ok: (
    <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
  ),
  warn: (
    <AlertTriangle
      aria-hidden
      className="mt-0.5 size-4 shrink-0 text-warning"
    />
  ),
  info: (
    <Info
      aria-hidden
      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
    />
  ),
};

export function PaymentInsights({ preview }: { preview: PaymentPreview }) {
  const { config, snapshot, account, policyRequest } = useSquad();
  const { names } = useMemberNames(config?.multisig);
  const multisig = config?.multisig ?? "";
  const [policy, setPolicy] = useState<PolicyFacts | null | undefined>(
    policyCache.get(multisig),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const members: KnownAddress[] = (snapshot?.squad.members ?? [])
    .map((m) => m.key.toBase58())
    .filter((address) => address !== config?.executor)
    .map((address) => ({
      address,
      name: names[address],
      label: "treasury member",
    }));
  const whitelisted: KnownAddress[] = (policy?.whitelist ?? []).map(
    (address) => ({
      address,
      name: names[address],
      label: "whitelisted wallet",
    }),
  );
  const paid = preview.supported ? preview.payments[0] : undefined;
  const holding = paid
    ? paid.mint
      ? snapshot?.tokens
          .filter((t) => t.mint === paid.mint)
          .reduce((sum, t) => sum + BigInt(t.amount), 0n)
      : snapshot
        ? BigInt(snapshot.sol)
        : undefined
    : undefined;
  const { headline, insights } = paymentInsights({
    preview,
    known: [...members, ...whitelisted],
    balance:
      paid && holding !== undefined
        ? {
            raw: holding.toString(),
            decimals: paid.decimals,
            symbol: paid.symbol,
          }
        : undefined,
    policy: policy ?? undefined,
  });

  async function loadPolicy() {
    if (!multisig) return;
    setLoading(true);
    setError("");
    try {
      const r = await policyRequest<{ document: PolicyV1 | null }>({
        action: "current",
        multisig,
      });
      const facts = r.document
        ? {
            whitelist: r.document.destinationWhitelist,
            cap: r.document.maxAmountPerPayment,
          }
        : null;
      policyCache.set(multisig, facts);
      setPolicy(facts);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The policy could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }

  if (!headline && !insights.length) return null;
  return (
    <div data-testid="payment-insights" className="space-y-3">
      {headline && <p className="text-lg font-semibold">{headline}</p>}
      <ul className="space-y-2">
        {insights.map((insight, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            {ICONS[insight.tone]}
            <span className="[overflow-wrap:anywhere]">{insight.text}</span>
          </li>
        ))}
      </ul>
      {paid && isGuarded(config) && policy === undefined && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={loading || !account}
          onClick={() => void loadPolicy()}
        >
          {loading ? "Checking…" : "Check against policy"}
        </Button>
      )}
      {policy === null && (
        <p className="caption">
          This treasury&apos;s policy document is not on file, so the whitelist
          and cap cannot be checked here.
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <p className="caption">
        Preview from the decoded transaction
        {policy ? " and this treasury's policy (members only)" : ""}. The
        on-chain Guard review is the verdict.
      </p>
    </div>
  );
}
