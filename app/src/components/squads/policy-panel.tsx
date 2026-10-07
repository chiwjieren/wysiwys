"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { parsePolicy, type PolicyV1 } from "@wysiwys/shared";
import { Panel } from "@/components/design";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSquad } from "@/lib/squads/provider";
import { isGuarded } from "@/lib/squads/review";
import { diffPolicies } from "@/lib/squads/policy";

type Current = { currentPolicyHash: string; document: PolicyV1 | null };
const randomSalt = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
const short = (hash: string) => `${hash.slice(0, 8)}…${hash.slice(-8)}`;

/**
 * The treasury's private payment policy: members read it and propose changes, which take effect only after
 * a Squads vote and a waiting period (guard apply_policy_change). Reading asks the wallet to sign.
 */
export function PolicyPanel() {
  const { config, account, busy, policyRequest, proposePolicyChange } =
    useSquad();
  const router = useRouter();
  const [current, setCurrent] = useState<Current>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [upload, setUpload] = useState("");
  const [whitelist, setWhitelist] = useState("");
  const [cap, setCap] = useState("");
  const [screening, setScreening] = useState(true);
  const [json, setJson] = useState("");
  if (!isGuarded(config)) return null;

  async function load() {
    setLoading(true);
    setError("");
    try {
      const result = await policyRequest<Current>({
        action: "current",
        multisig: config!.multisig,
      });
      setCurrent(result);
      if (result.document) {
        setWhitelist(result.document.destinationWhitelist.join("\n"));
        setCap(result.document.maxAmountPerPayment);
        setScreening(!!result.document.screening);
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The policy could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function uploadCurrent() {
    setError("");
    try {
      const result = await policyRequest<{ current: boolean }>({
        action: "submit",
        multisig: config!.multisig,
        document: parsePolicy(JSON.parse(upload)),
      });
      if (!result.current)
        return setError(
          "That document does not match the treasury's current policy hash.",
        );
      setUpload("");
      await load();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The document could not be uploaded.",
      );
    }
  }

  return (
    <Panel className="gap-4">
      <h2>Payment policy</h2>
      <p className="text-muted-foreground">
        The private rules the Chainlink review checks: whitelist, per-payment
        cap, tokens and screening. Members change them by vote; a change applies
        only after a waiting period in which members can cancel it.
      </p>
      {!account ? (
        <p className="caption">Connect a member wallet to see the policy.</p>
      ) : !current ? (
        <div>
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => void load()}
          >
            {loading ? "Loading…" : "Show policy"}
          </Button>
          <p className="caption mt-2">
            Your wallet signs a read request; only members can see the policy.
          </p>
        </div>
      ) : (
        <>
          <p className="caption">
            Current policy hash{" "}
            <span className="font-mono">
              {short(current.currentPolicyHash)}
            </span>
            {current.document ? ` · version ${current.document.version}` : ""}
          </p>
          {current.document ? (
            <ul className="space-y-1 text-sm">
              {diffPolicies(null, current.document, config!.token)
                .slice(1)
                .map((line) => (
                  <li key={line} className="[overflow-wrap:anywhere]">
                    {line}
                  </li>
                ))}
              <li className="caption [overflow-wrap:anywhere]">
                Whitelisted:{" "}
                {current.document.destinationWhitelist.join(", ") || "none"}
              </li>
            </ul>
          ) : (
            <div className="space-y-2">
              <p className="text-sm">
                The current document is not on file. Paste it (JSON) so members
                can read it and see diffs; it is accepted only if its hash
                matches the treasury's.
              </p>
              <textarea
                aria-label="Current policy document"
                className="min-h-28 w-full rounded-md border bg-transparent p-2 font-mono text-xs"
                value={upload}
                onChange={(e) => setUpload(e.target.value)}
              />
              <Button
                variant="outline"
                disabled={!upload}
                onClick={() => void uploadCurrent()}
              >
                Upload current policy
              </Button>
            </div>
          )}
          {!editing ? (
            <div>
              <Button onClick={() => setEditing(true)}>Propose a change</Button>
            </div>
          ) : (
            <PolicyEditor
              current={current}
              whitelist={whitelist}
              setWhitelist={setWhitelist}
              cap={cap}
              setCap={setCap}
              screening={screening}
              setScreening={setScreening}
              json={json}
              setJson={setJson}
              busy={!!busy}
              token={config!.token}
              onCancel={() => setEditing(false)}
              onSubmit={async (draft) => {
                const id = await proposePolicyChange(draft);
                if (id) router.push(`/transactions/${id}`);
              }}
            />
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </Panel>
  );
}

function PolicyEditor(p: {
  current: Current;
  whitelist: string;
  setWhitelist: (v: string) => void;
  cap: string;
  setCap: (v: string) => void;
  screening: boolean;
  setScreening: (v: boolean) => void;
  json: string;
  setJson: (v: string) => void;
  busy: boolean;
  token?: { mint: string; symbol: string; decimals: number };
  onCancel: () => void;
  onSubmit: (draft: PolicyV1) => Promise<void>;
}) {
  const base = p.current.document;
  const salt = useMemo(randomSalt, []);
  // Build the draft: from the form when the current document is known, else from pasted JSON.
  const result = useMemo((): { draft?: PolicyV1; error?: string } => {
    try {
      const raw = base
        ? {
            ...base,
            version: base.version + 1,
            salt,
            destinationWhitelist: p.whitelist.split(/\s+/).filter(Boolean),
            maxAmountPerPayment: p.cap.trim(),
            screening: p.screening
              ? { provider: "scorechain", blockOn: ["SANCTIONED"] }
              : undefined,
          }
        : JSON.parse(p.json || "null");
      if (raw && raw.screening === undefined) delete raw.screening;
      return { draft: parsePolicy(raw) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Invalid policy." };
    }
  }, [base, salt, p.whitelist, p.cap, p.screening, p.json]);
  const lines = result.draft ? diffPolicies(base, result.draft, p.token) : [];
  const unchanged = !!base && lines.length <= 1;
  return (
    <div className="space-y-3 border-t pt-4">
      {base ? (
        <>
          <label className="block text-sm">
            Whitelisted wallets (one per line)
            <textarea
              aria-label="Whitelisted wallets"
              className="mt-1 min-h-28 w-full rounded-md border bg-transparent p-2 font-mono text-xs"
              value={p.whitelist}
              onChange={(e) => p.setWhitelist(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            Per-payment cap (base units
            {p.token
              ? `; ${p.token.symbol} has ${p.token.decimals} decimals`
              : ""}
            )
            <Input
              className="mt-1 font-mono"
              inputMode="numeric"
              value={p.cap}
              onChange={(e) => p.setCap(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={p.screening}
              onChange={(e) => p.setScreening(e.target.checked)}
            />
            Sanctions screening (Scorechain)
          </label>
          <p className="caption">
            Allowed tokens and payment types stay as they are. A new random salt
            is generated.
          </p>
        </>
      ) : (
        <label className="block text-sm">
          Proposed policy document (JSON, Policy v1)
          <textarea
            aria-label="Proposed policy document"
            className="mt-1 min-h-40 w-full rounded-md border bg-transparent p-2 font-mono text-xs"
            value={p.json}
            onChange={(e) => p.setJson(e.target.value)}
          />
        </label>
      )}
      {result.error ? (
        <p className="text-sm text-destructive">{result.error}</p>
      ) : (
        <ul className="space-y-1 rounded-md bg-muted p-3 text-sm">
          {lines.map((line) => (
            <li key={line} className="[overflow-wrap:anywhere]">
              {line}
            </li>
          ))}
          {unchanged && (
            <li className="text-muted-foreground">No changes yet.</li>
          )}
        </ul>
      )}
      <p className="caption">
        After the vote and the waiting period anyone can apply it. Reviews then
        use the new policy automatically.
      </p>
      <div className="flex gap-2">
        <Button
          disabled={!result.draft || unchanged || p.busy}
          onClick={() => void p.onSubmit(result.draft!)}
        >
          Propose policy change
        </Button>
        <Button variant="ghost" onClick={p.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
