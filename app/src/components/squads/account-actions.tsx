"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { SystemProgram } from "@solana/web3.js";
import * as sqds from "@sqds/multisig";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/design";
import { useSquad } from "@/lib/squads/provider";
import { Explorer } from "./treasury-ui";
import { tokenAmount as formatTokenAmount } from "@/lib/squads/payments";
export function VaultFunding() {
  const { snapshot, account, funding, deposit, busy, error } = useSquad();
  const [asset, setAsset] = useState("");
  const [amount, setAmount] = useState("");
  const member = snapshot?.squad.members.some(
    (m) => m.key.toBase58() === account?.address,
  );
  const token = funding?.tokens.find((t) => t.address === asset);
  return (
    <Panel className="gap-4">
      <h2>Fund the Squad vault</h2>
      <p className="caption">
        The funded member deposits treasury assets. Members can then propose and
        vote on payouts without owning those assets. Keep SOL in member wallets
        for signing fees.
      </p>
      {!account ? (
        <p>Connect with the funded member wallet.</p>
      ) : !funding ? (
        <p>Loading your wallet balance…</p>
      ) : (
        <>
          <label>
            Deposit asset
            <select
              className="mt-2 w-full rounded border bg-secondary p-2"
              value={asset}
              onChange={(e) => setAsset(e.target.value)}
            >
              <option value="">SOL</option>
              {funding.tokens
                .filter((t) => BigInt(t.amount) > 0n)
                .map((t) => (
                  <option key={t.address} value={t.address}>
                    {t.mint} · {formatTokenAmount(t.amount, t.decimals)}
                  </option>
                ))}
            </select>
          </label>
          <p className="caption">
            Wallet balance:{" "}
            {token
              ? formatTokenAmount(token.amount, token.decimals)
              : formatTokenAmount(String(funding.sol), 9)}{" "}
            {token ? "tokens" : "SOL"}
          </p>
          <label htmlFor="deposit-amount">Deposit amount</label>
          <Input
            id="deposit-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <Button
            disabled={!member || !!busy || !!error || !amount.trim()}
            onClick={() => void deposit(amount.trim(), asset || undefined)}
          >
            Deposit into vault
          </Button>
          {!member && (
            <p className="caption">
              This wallet is not a member of the configured Squad.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}
export function ThresholdSettings() {
  const { config, snapshot, account, setThreshold, busy, error } = useSquad();
  const [threshold, setValue] = useState("");
  const router = useRouter();
  if (!snapshot) return null;
  const squad = snapshot.squad;
  const voters = squad.members.filter((m) =>
    sqds.types.Permissions.has(m.permissions, sqds.types.Permission.Vote),
  ).length;
  const controlled = !squad.configAuthority.equals(SystemProgram.programId);
  const member = squad.members.find(
    (m) => m.key.toBase58() === account?.address,
  );
  const allowed = controlled
    ? squad.configAuthority.toBase58() === account?.address
    : !!member &&
      sqds.types.Permissions.has(
        member.permissions,
        sqds.types.Permission.Initiate,
      );
  const valid =
    /^\d+$/.test(threshold) &&
    Number(threshold) >= 1 &&
    Number(threshold) <= voters &&
    Number(threshold) !== squad.threshold;
  return (
    <Panel className="gap-4">
      <h2>Approval threshold</h2>
      <p>
        Current threshold: {squad.threshold} of {voters} voters
      </p>
      {controlled ? (
        <>
          <p className="caption">
            The existing on-chain configuration authority can set this
            threshold.
          </p>
          <Explorer address={squad.configAuthority.toBase58()} />
        </>
      ) : (
        <p className="caption">
          {config?.executionMode === "standard"
            ? "Changes need the current approval threshold, then execution by an authorized member."
            : "Changes need the current approval threshold. Applying approved changes requires protected settings execution."}
        </p>
      )}
      <label htmlFor="approval-threshold">Required approvals</label>
      <Input
        id="approval-threshold"
        type="number"
        min={1}
        max={voters}
        value={threshold}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button
        disabled={!allowed || !valid || !!busy || !!error}
        onClick={async () => {
          const id = await setThreshold(Number(threshold));
          if (id) router.push(`/transactions/${id}`);
        }}
      >
        {controlled ? "Set threshold" : "Propose threshold change"}
      </Button>
      {!account && (
        <p className="caption">
          Connect with a member wallet or the configuration authority.
        </p>
      )}
    </Panel>
  );
}
