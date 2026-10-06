"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { PublicKey, Connection } from "@solana/web3.js";
import * as sqds from "@sqds/multisig";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader, Panel, StatusBadge } from "@/components/design";
import { CopyButton } from "@/components/dialogs";
import { useSquad } from "@/lib/squads/provider";
import {
  actionsForMember,
  readProposal,
  type ProposalRecord,
} from "@/lib/squads/sdk";
export function Explorer({
  address,
  transaction = false,
}: {
  address: string;
  transaction?: boolean;
}) {
  return (
    <a
      className="break-all text-xs underline"
      target="_blank"
      rel="noreferrer"
      href={`https://explorer.solana.com/${transaction ? "tx" : "address"}/${address}?cluster=devnet`}
    >
      {address}
    </a>
  );
}
export function SquadFeedback() {
  const { mode, error, busy, signature, refresh } = useSquad();
  return (
    <div className="space-y-3">
      {mode === "loading" && <p role="status">Loading Squad configuration…</p>}
      {error && (
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      )}
      {busy && (
        <p role="status">
          {signature
            ? "Confirming on Solana devnet"
            : "Waiting for wallet approval"}{" "}
          · {busy}
        </p>
      )}
      {signature && (
        <p className="caption">
          Submitted transaction: <Explorer address={signature} transaction />
        </p>
      )}
      <Button
        variant="secondary"
        disabled={!!busy || mode === "loading"}
        onClick={() => void refresh()}
      >
        Refresh chain state
      </Button>
    </div>
  );
}
function ProposalList() {
  const { snapshot, older, newest } = useSquad();
  if (!snapshot) return null;
  return (
    <Panel className="gap-4">
      <h2>Squads payout proposals</h2>
      <div className="table-scroll">
        <table className="data-table min-w-[600px]">
          <thead>
            <tr>
              <th>Proposal</th>
              <th>Squads status</th>
              <th>Approvals</th>
              <th>Rejected</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {snapshot.records.map(({ proposal }) => (
              <tr key={proposal.transactionIndex.toString()}>
                <td>#{proposal.transactionIndex.toString()}</td>
                <td>{proposal.status.__kind}</td>
                <td>
                  {proposal.approved.length} / {snapshot.squad.threshold}
                </td>
                <td>{proposal.rejected.length}</td>
                <td>
                  <Link
                    className="underline"
                    href={`/transactions/${proposal.transactionIndex.toString()}`}
                  >
                    Inspect proposal
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!snapshot.records.length && <p>No vault proposals in this range.</p>}
      <div className="flex gap-3">
        <Button variant="secondary" onClick={newest}>
          Newest proposals
        </Button>
        <Button
          variant="secondary"
          onClick={older}
          disabled={snapshot.latest <= 20n}
        >
          Older proposals
        </Button>
      </div>
      <p className="caption">
        20 transaction indices per page. Squads approval and the guard verdict
        are separate.
      </p>
    </Panel>
  );
}
export function LivePropose() {
  const { config, snapshot, account, busy, error, propose } = useSquad();
  const [tradeId, setTradeId] = useState("");
  const router = useRouter();
  const member = snapshot?.squad.members.find(
    (m) => m.key.toBase58() === account?.address,
  );
  const permitted =
    !!member &&
    sqds.types.Permissions.has(
      member.permissions,
      sqds.types.Permission.Initiate,
    );
  return (
    <Panel className="gap-4">
      <h2>Propose a trade payout</h2>
      <p className="caption">
        The settlement service derives the payout from the approved ticket. No
        amounts or wallet addresses are entered here.
      </p>
      <label htmlFor="live-trade-id">Approved trade ID</label>
      <Input
        id="live-trade-id"
        placeholder="Approved trade ID"
        value={tradeId}
        onChange={(e) => setTradeId(e.target.value)}
        disabled={!config?.settlementEnabled}
      />
      <Button
        disabled={
          !config?.settlementEnabled ||
          !permitted ||
          !!busy ||
          !!error ||
          !tradeId.trim()
        }
        onClick={async () => {
          const id = await propose(tradeId.trim());
          if (id) router.push(`/transactions/${id}`);
        }}
      >
        Propose guarded payout
      </Button>
      {!config?.settlementEnabled && (
        <p className="caption">
          Trade and guard integration is not configured. Payout creation and
          execution are disabled.
        </p>
      )}
      {!account && <p className="caption">Connect a member wallet to sign.</p>}
    </Panel>
  );
}
export function SquadDashboard({
  transactions = false,
}: {
  transactions?: boolean;
}) {
  const { config, snapshot } = useSquad();
  return (
    <div className="page-stack">
      <PageHeader
        title={transactions ? "Transactions" : "Dashboard"}
        description="Live Squads v4 state · Solana Devnet · Test keys only"
      />
      <SquadFeedback />
      {config && snapshot && (
        <>
          <div className="grid gap-6 xl:grid-cols-2">
            <Panel className="gap-4">
              <h2>Squad treasury</h2>
              <p className="caption">Multisig</p>
              <Explorer address={config.multisig} />
              <p>
                Threshold: {snapshot.squad.threshold} of{" "}
                {
                  snapshot.squad.members.filter((m) =>
                    sqds.types.Permissions.has(
                      m.permissions,
                      sqds.types.Permission.Vote,
                    ),
                  ).length
                }{" "}
                voters
              </p>
              <p>
                Members: {snapshot.squad.members.length} · Timelock:{" "}
                {snapshot.squad.timeLock} seconds
              </p>
              <p className="caption">Vault {config.vaultIndex}</p>
              <Explorer address={snapshot.vault.toBase58()} />
              <CopyButton
                value={snapshot.vault.toBase58()}
                label="Copy deposit address"
              />
              <p className="caption">
                Deposit SOL or supported payout tokens into the vault.
              </p>
              <p>
                {(snapshot.sol / 1e9).toLocaleString(undefined, {
                  maximumFractionDigits: 9,
                })}{" "}
                SOL
              </p>
              {snapshot.tokens.map((token) => (
                <div key={token.address} className="space-y-1 border-t pt-3">
                  <p>
                    {formatTokenAmount(token.amount, token.decimals)} tokens
                  </p>
                  <p className="caption">
                    Mint: <Explorer address={token.mint} />
                  </p>
                  <p className="caption">
                    Token account: <Explorer address={token.address} />
                  </p>
                </div>
              ))}
            </Panel>
            <LivePropose />
          </div>
          <ProposalList />
        </>
      )}
    </div>
  );
}
export function formatTokenAmount(raw: string, decimals: number) {
  const padded = raw.padStart(decimals + 1, "0");
  return decimals
    ? `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`
    : padded;
}
export function SquadMembers() {
  const { config, snapshot } = useSquad();
  return (
    <div className="page-stack">
      <PageHeader
        title="Members"
        description="Permissions read directly from the Squads multisig."
      />
      <SquadFeedback />
      {snapshot && (
        <Panel className="gap-4">
          <p>Approval threshold: {snapshot.squad.threshold}</p>
          {snapshot.squad.members.map((member) => (
            <div
              key={member.key.toBase58()}
              className="space-y-3 border-t pt-4"
            >
              <Explorer address={member.key.toBase58()} />
              {member.key.toBase58() === config?.executor && (
                <p>Guard executor PDA</p>
              )}
              <div className="flex flex-wrap gap-2">
                {Object.entries(sqds.types.Permission).map(
                  ([label, permission]) =>
                    sqds.types.Permissions.has(
                      member.permissions,
                      permission,
                    ) && <StatusBadge key={label}>{label}</StatusBadge>,
                )}
              </div>
            </div>
          ))}
        </Panel>
      )}
    </div>
  );
}
export function SquadSettings() {
  const { config, snapshot, mode } = useSquad();
  return (
    <div className="page-stack">
      <PageHeader
        title="Settings"
        description="Squads deployment and guard connection."
      />
      <SquadFeedback />
      {mode === "sample" && (
        <p>
          No deployment is configured. The other pages show sample design
          records.
        </p>
      )}
      {config && (
        <Panel className="gap-4">
          <h2>Deployment</h2>
          {[
            ["Multisig", config.multisig],
            ["Guard program", config.guardProgram],
            ["Executor", config.executor],
            ...(snapshot ? [["Vault", snapshot.vault.toBase58()]] : []),
          ].map(([label, address]) => (
            <div key={label}>
              <p className="caption">{label}</p>
              <Explorer address={address} />
            </div>
          ))}
          <p>
            Settlement adapter:{" "}
            {config.settlementEnabled ? "Configured" : "Unavailable"}
          </p>
          <p className="caption">
            Guard decisions are enforced on-chain. No direct Squads payout
            execution is available.
          </p>
        </Panel>
      )}
      <Panel className="gap-4">
        <h2>Squads resources</h2>
        <a
          className="underline"
          href="https://docs.squads.so/main/development/typescript/overview"
          target="_blank"
          rel="noreferrer"
        >
          Squads SDK documentation
        </a>
        <a
          className="underline"
          href="https://docs.squads.so/main/additional-resources/what-if-the-squads-app-goes-down"
          target="_blank"
          rel="noreferrer"
        >
          Squads backup kit: minimal UI, CLI and SDK
        </a>
      </Panel>
    </div>
  );
}
export function LiveProposal({ id }: { id: string }) {
  const { config, snapshot, account, error, busy, vote, execute } = useSquad();
  const [record, setRecord] = useState<ProposalRecord | null>();
  const [readError, setReadError] = useState("");
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!config) return;
      try {
        if (
          !/^\d{1,20}$/.test(id) ||
          BigInt(id) < 1n ||
          BigInt(id) > 18446744073709551615n
        )
          throw new Error("Invalid proposal index.");
        const rpc = new Connection(
          new URL("/api/squads/rpc", window.location.origin).toString(),
          "finalized",
        );
        const result = await readProposal(rpc, config, BigInt(id));
        if (!cancelled) {
          setRecord(result);
          setReadError("");
        }
      } catch (e) {
        if (!cancelled) {
          setRecord(undefined);
          setReadError(
            e instanceof Error ? e.message : "Proposal read failed.",
          );
        }
      }
    };
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [config, id, snapshot]);
  const permissions =
    record && snapshot
      ? actionsForMember(
          snapshot.squad,
          record.proposal,
          account ? new PublicKey(account.publicKey) : undefined,
        )
      : { approve: false, reject: false, cancel: false };
  const enabled = !!account && !!snapshot && !error && !readError && !busy;
  return (
    <div className="page-stack">
      <PageHeader
        title={`Payout proposal #${id}`}
        description="Finalized Squads account state. Guard review and trade evidence are supplied by the settlement integration."
      />
      <Link className="underline" href="/transactions">
        Back to transactions
      </Link>
      <SquadFeedback />
      {readError && <p role="alert">{readError}</p>}
      {record === null && <p>This vault proposal was not found.</p>}
      {record && (
        <>
          <Panel className="gap-4">
            <h2>Squads consensus: {record.proposal.status.__kind}</h2>
            <Explorer address={record.address.toBase58()} />
            <p>
              Approved: {record.proposal.approved.length} /{" "}
              {snapshot?.squad.threshold ?? "?"} · Rejected:{" "}
              {record.proposal.rejected.length} · Cancellation votes:{" "}
              {record.proposal.cancelled.length}
            </p>
            {record.proposal.approved.map((k) => (
              <p className="caption" key={k.toBase58()}>
                Approved by <Explorer address={k.toBase58()} />
              </p>
            ))}
            <p className="caption">
              Guard verdict is unavailable in this frontend until the guard
              account adapter is connected. Squads approval alone does not
              authorize a payout.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button
                disabled={!enabled || !permissions.approve}
                onClick={() => void vote(BigInt(id), "approve")}
              >
                Approve proposal
              </Button>
              <Button
                variant="secondary"
                disabled={!enabled || !permissions.reject}
                onClick={() => void vote(BigInt(id), "reject")}
              >
                Reject proposal
              </Button>
              <Button
                variant="secondary"
                disabled={!enabled || !permissions.cancel}
                onClick={() => void vote(BigInt(id), "cancel")}
              >
                Vote to cancel
              </Button>
              <Button
                disabled={
                  !enabled ||
                  !config?.settlementEnabled ||
                  record.proposal.status.__kind !== "Approved" ||
                  !!record.transaction.message.addressTableLookups.length
                }
                onClick={() => void execute(BigInt(id))}
              >
                Execute through guard
              </Button>
            </div>
            <p className="caption">
              Execution rechecks the guard verdict, expiry, transaction hash and
              nonce on-chain.
            </p>
          </Panel>
          <Panel className="gap-4">
            <h2>Stored payout instructions</h2>
            <Explorer address={record.transactionAddress.toBase58()} />
            <p className="caption">
              Raw account inspection. This is not a policy verdict or decoded
              settlement summary.
            </p>
            {record.transaction.message.addressTableLookups.length > 0 ? (
              <p role="alert">
                Address Lookup Tables are unsupported. Execution is disabled.
              </p>
            ) : (
              record.transaction.message.instructions.map((instruction, i) => (
                <div key={i} className="space-y-2 border-t pt-4">
                  <p>Instruction {i + 1}</p>
                  <p className="caption">
                    Program{" "}
                    <Explorer
                      address={record.transaction.message.accountKeys[
                        instruction.programIdIndex
                      ].toBase58()}
                    />
                  </p>
                  <p className="caption break-all">
                    Data:{" "}
                    {Array.from(instruction.data)
                      .map((byte) => byte.toString(16).padStart(2, "0"))
                      .join("")}
                  </p>
                  {Array.from(instruction.accountIndexes).map((index, j) => (
                    <p className="caption" key={j}>
                      Account {j + 1}:{" "}
                      <Explorer
                        address={record.transaction.message.accountKeys[
                          index
                        ].toBase58()}
                      />
                    </p>
                  ))}
                </div>
              ))
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
