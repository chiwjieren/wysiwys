"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Panel,
  PageHeader,
  SectionTitle,
  StatusBadge,
  Avatar,
  AssetIcon,
} from "@/components/design";
import { CopyButton } from "@/components/dialogs";
import { useSquad } from "@/lib/squads/provider";
import { useWalletConnection } from "@/lib/auth/provider";
import { actionsForMember } from "@/lib/squads/sdk";
import { tokenAmount } from "@/lib/squads/payments";
import { memberRole } from "@/lib/squads/groups";
import { PublicKey } from "@solana/web3.js";
import { figmaAssets } from "@/lib/figma-assets";
import { CreateGroupButton, GroupManage, GroupInvite } from "./group-controls";
import { PaymentButton, ReceiveButton } from "./payment-dialog";
import { ThresholdSettings } from "./account-actions";
import { ProposalTable } from "./proposal-table";
import {
  Explorer,
  EmptyState,
  RefreshButton,
  SquadFeedback,
  shortAddress,
} from "./treasury-ui";
const votable = (mask: number) => !!(mask & 2);
function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <Panel className="min-h-[154px] justify-between gap-3">
      <p className="text-muted-foreground">{label}</p>
      <p className="text-[36px] leading-[44px] font-semibold tracking-tight">
        {value}
      </p>
      <p className="caption">{detail}</p>
    </Panel>
  );
}
export function SquadDashboard({
  transactions = false,
}: {
  transactions?: boolean;
}) {
  return transactions ? <SquadTransactions /> : <Dashboard />;
}
function Dashboard() {
  const { snapshot, account } = useSquad();
  const voters = snapshot?.squad.members.filter((m) =>
    votable(m.permissions.mask),
  ).length;
  const pending =
    snapshot?.records.filter((r) => r.proposal.status.__kind === "Active") ??
    [];
  const needs = pending.filter(
    (r) =>
      account &&
      actionsForMember(
        snapshot!.squad,
        r.proposal,
        new PublicKey(account.address),
      ).approve,
  );
  return (
    <div className="page-stack">
      <PageHeader
        title="Dashboard"
        description="Your treasury, approvals, and activity in one place."
      >
        {snapshot ? (
          <>
            <ReceiveButton />
            <PaymentButton />
          </>
        ) : (
          <>
            <GroupManage label="Open group" />
            <CreateGroupButton />
          </>
        )}
      </PageHeader>
      <SquadFeedback />
      <div className="grid gap-4 md:grid-cols-[1.94fr_1fr_1fr]">
        <Metric
          label="Treasury balance"
          value={snapshot ? `${tokenAmount(String(snapshot.sol), 9)} SOL` : "—"}
          detail={
            snapshot
              ? `${snapshot.tokens.length} token ${snapshot.tokens.length === 1 ? "asset" : "assets"} · Solana Devnet`
              : "Open a treasury to view its balance"
          }
        />
        <Metric
          label="Needs your approval"
          value={snapshot ? String(needs.length) : "—"}
          detail={
            account
              ? "Payments awaiting your vote"
              : "Connect to see your approvals"
          }
        />
        <Metric
          label="Approval threshold"
          value={snapshot ? `${snapshot.squad.threshold} / ${voters}` : "—"}
          detail="Required member approvals"
        />
      </div>
      <Panel className="gap-5">
        <SectionTitle action={<RefreshButton />}>Holdings</SectionTitle>
        <div className="table-scroll">
          <table className="data-table min-w-[520px]">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Balance</th>
                <th className="text-right">Account</th>
              </tr>
            </thead>
            <tbody>
              {snapshot && (
                <tr>
                  <td>
                    <div className="flex items-center gap-3">
                      <Avatar initials="S" />
                      <div>
                        <p className="font-medium">Solana</p>
                        <p className="caption">SOL</p>
                      </div>
                    </div>
                  </td>
                  <td>{tokenAmount(String(snapshot.sol), 9)}</td>
                  <td className="text-right">
                    <Explorer address={snapshot.vault.toBase58()} />
                  </td>
                </tr>
              )}
              {snapshot?.tokens.map((t) => (
                <tr key={t.address}>
                  <td>
                    <div className="flex items-center gap-3">
                      <Avatar initials="T" />
                      <div>
                        <p className="font-medium">SPL token</p>
                        <p className="caption">
                          <Explorer address={t.mint} />
                        </p>
                      </div>
                    </div>
                  </td>
                  <td>{tokenAmount(t.amount, t.decimals)}</td>
                  <td className="text-right">
                    <Explorer address={t.address} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!snapshot && (
          <EmptyState title="Your treasury assets belong here">
            Open or create a group to see its SOL and token balances. Funds are
            held in the shared vault.
          </EmptyState>
        )}
      </Panel>
      <ProposalTable
        compact
        title="Pending approvals"
        records={pending.slice(0, 4)}
      />
      <Panel className="gap-4">
        <SectionTitle>Recent activity</SectionTitle>
        {snapshot?.records.length ? (
          snapshot.records.slice(0, 3).map((r) => (
            <div
              key={r.address.toBase58()}
              className="flex flex-wrap items-center gap-3 border-t pt-4"
            >
              <AssetIcon src={figmaAssets.dashboard.imgIconClock} />
              <p className="flex-1">
                Proposal #{r.proposal.transactionIndex.toString()} ·{" "}
                {r.kind === "vault"
                  ? "Payment"
                  : r.kind === "batch"
                    ? "Batch"
                    : "Group settings"}
              </p>
              <span className="caption">{r.proposal.status.__kind}</span>
              <Link
                className="caption hover:text-primary"
                href={`/transactions/${r.proposal.transactionIndex.toString()}`}
              >
                View details →
              </Link>
            </div>
          ))
        ) : (
          <EmptyState title="No activity yet" className="min-h-[64px] py-2">
            New proposals and member approvals will appear here as your team
            uses the treasury.
          </EmptyState>
        )}
      </Panel>
    </div>
  );
}
export function SquadTransactions() {
  const { snapshot, older, newest, busy } = useSquad();
  const [filter, setFilter] = useState("All transactions"),
    [search, setSearch] = useState("");
  const filters = [
    "All transactions",
    "Needs approval",
    "Approved",
    "Executed",
    "Rejected",
  ];
  const state: Record<string, string> = {
    "Needs approval": "Active",
    Approved: "Approved",
    Executed: "Executed",
    Rejected: "Rejected",
  };
  const records = (snapshot?.records ?? []).filter(
    (r) =>
      (filter === "All transactions" ||
        r.proposal.status.__kind === state[filter]) &&
      `${r.proposal.transactionIndex} ${r.kind} ${r.proposal.status.__kind}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <div className="page-stack">
      <PageHeader
        title="Transactions"
        description="Review payments, collect approvals, and track your treasury’s activity."
      >
        <PaymentButton />
      </PageHeader>
      <SquadFeedback />
      <div className="flex flex-wrap gap-3">
        <Input
          className="min-w-[220px] flex-1"
          aria-label="Search transactions"
          placeholder="Search by proposal number or status"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {filters.map((f) => (
          <Button
            key={f}
            variant="secondary"
            aria-pressed={filter === f}
            className={
              filter === f
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : ""
            }
            onClick={() => setFilter(f)}
          >
            {f}
          </Button>
        ))}
      </div>
      <ProposalTable records={records} title="Treasury transactions" />
      {snapshot && (
        <div className="flex items-center justify-between gap-3">
          <p className="caption">
            Up to 20 proposals per page · Transaction review and member votes
            are separate.
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={!!busy} onClick={newest}>
              Newest
            </Button>
            <Button
              variant="secondary"
              disabled={!!busy || snapshot.latest <= 20n}
              onClick={older}
            >
              Older
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
export function SquadMembers() {
  const { config, snapshot, account } = useSquad();
  const humans =
    snapshot?.squad.members.filter(
      (m) => m.key.toBase58() !== config?.executor,
    ) ?? [];
  const voters = humans.filter((m) => votable(m.permissions.mask)).length;
  const guardExecutor = snapshot?.squad.members.find(
    (m) => m.key.toBase58() === config?.executor,
  );
  return (
    <div className="page-stack">
      <PageHeader
        title="Members"
        description="The people who can propose and approve treasury payments."
      >
        <GroupInvite />
      </PageHeader>
      <SquadFeedback />
      <Panel>
        <div className="flex flex-wrap items-center gap-4">
          <AssetIcon src={figmaAssets.members.imgIconMembers1} size={24} />
          <div className="flex-1">
            <h2>
              {snapshot
                ? `${snapshot.squad.threshold} of ${voters} approvals required`
                : "Decide together"}
            </h2>
            <p className="mt-1 text-muted-foreground">
              Members propose and vote. Your approval threshold decides when a
              proposal is approved.
            </p>
          </div>
          <StatusBadge>
            {snapshot ? `${voters} voting members` : "No group selected"}
          </StatusBadge>
        </div>
      </Panel>
      <Panel className="gap-5">
        <SectionTitle>Human signers</SectionTitle>
        <div className="table-scroll">
          <table className="data-table min-w-[620px]">
            <thead>
              <tr>
                <th className="w-[35%]">Member</th>
                <th className="w-[36%]">Wallet address</th>
                <th>Permissions</th>
              </tr>
            </thead>
            <tbody>
              {humans.map((m, i) => (
                <tr className="h-20" key={m.key.toBase58()}>
                  <td>
                    <div className="flex items-center gap-3">
                      <Avatar
                        initials={m.key.toBase58().slice(0, 2)}
                        size={40}
                      />
                      <span>
                        {m.key.toBase58() === account?.address
                          ? "Your wallet · You"
                          : `Member ${i + 1}`}
                      </span>
                    </div>
                  </td>
                  <td>
                    <Explorer address={m.key.toBase58()} />
                  </td>
                  <td>
                    <StatusBadge className="min-w-0">
                      {memberRole(
                        m.key.toBase58(),
                        m.permissions.mask,
                        config?.executor,
                      )}
                    </StatusBadge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!humans.length && (
          <EmptyState title="Bring your team into the treasury">
            Open a group to view its members, or add your team’s wallet
            addresses when creating one.
          </EmptyState>
        )}
      </Panel>
      <Panel className="gap-4">
        <h2>
          {config?.executionMode === "standard"
            ? "Execution permissions"
            : "Guard executor"}
        </h2>
        <div className="flex flex-wrap items-center gap-4">
          <AssetIcon src={figmaAssets.members.imgIconShield2} size={40} />
          <div className="min-w-0 flex-1">
            <p className="text-lg font-semibold">
              {config?.executionMode === "standard"
                ? "Authorized members"
                : "wysiwys Guard"}
            </p>
            <p className="caption mt-1">
              {config?.executor ? (
                <Explorer address={config.executor} />
              ) : config?.executionMode === "standard" ? (
                "See the Execute permission in the member list above."
              ) : (
                "Guard integration comes later"
              )}
            </p>
            <p className="mt-2 text-muted-foreground">
              {config?.executionMode === "standard"
                ? "The creator can execute approved proposals. Other members propose and vote. Squads enforces the approval threshold."
                : "Executes payments after a valid Guard review and required member approvals. Does not propose or vote."}
            </p>
          </div>
          <StatusBadge
            tone={guardExecutor?.permissions.mask === 4 ? "success" : "neutral"}
          >
            {config?.executionMode === "standard"
              ? "Standard Squads"
              : guardExecutor
                ? memberRole(
                    guardExecutor.key.toBase58(),
                    guardExecutor.permissions.mask,
                    config?.executor,
                  )
                : "Guard executor (Execute only)"}
          </StatusBadge>
        </div>
      </Panel>
      <p className="caption">
        Inviting a member creates a proposal for your group to approve.
      </p>
    </div>
  );
}
function Preferences() {
  const auth = useWalletConnection();
  const [theme, setTheme] = useState("dark");
  useEffect(() => {
    setTheme(localStorage.getItem("wysiwys.theme") || "dark");
  }, []);
  const change = (next: string) => {
    setTheme(next);
    document.documentElement.dataset.theme = next;
    localStorage.setItem("wysiwys.theme", next);
  };
  return (
    <Panel className="gap-5">
      <h2>Your preferences</h2>
      <div className="flex items-center justify-between gap-4">
        <p>Appearance</p>
        <div className="flex gap-2">
          {["dark", "light"].map((t) => (
            <Button
              key={t}
              variant="secondary"
              aria-pressed={theme === t}
              onClick={() => change(t)}
            >
              {t === "dark" ? "Dark" : "Light"}
            </Button>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between">
        <p>Default explorer</p>
        <span className="rounded-lg bg-secondary px-4 py-3 text-xs">
          Solana Explorer
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <p className="caption">
          {auth.address
            ? `Connected as ${shortAddress(auth.address)}`
            : "No wallet connected"}
        </p>
        <Button
          variant="secondary"
          disabled={!auth.ready || !auth.configured}
          onClick={auth.connected ? () => void auth.disconnect() : auth.connect}
        >
          {auth.connected ? "Disconnect" : "Connect wallet"}
        </Button>
      </div>
    </Panel>
  );
}
export function SquadSettings() {
  const { config, snapshot, groupName } = useSquad();
  return (
    <div className="page-stack">
      <PageHeader
        title="Settings"
        description="Treasury information, approvals, and your preferences."
      />
      <SquadFeedback />
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <div className="space-y-6">
          <Panel className="gap-5">
            <SectionTitle action={<GroupManage label="Manage groups" />}>
              Treasury information
            </SectionTitle>
            <dl className="space-y-4 border-t pt-4">
              <div>
                <dt className="caption">Name</dt>
                <dd className="mt-1">
                  {config ? groupName : "No group selected"}
                </dd>
              </div>
              <div>
                <dt className="caption">Network</dt>
                <dd className="mt-1">Solana Devnet</dd>
              </div>
              {[
                ["Vault address", snapshot?.vault.toBase58()],
                ["Multisig address", config?.multisig],
              ].map(([label, address]) => (
                <div key={label}>
                  <dt className="caption">{label}</dt>
                  <dd className="mt-1 flex flex-wrap items-center gap-3">
                    {address ? (
                      <>
                        <Explorer address={address} />
                        <CopyButton value={address} />
                      </>
                    ) : (
                      "—"
                    )}
                  </dd>
                </div>
              ))}
              <div>
                <dt className="caption">Approval threshold</dt>
                <dd className="mt-1">
                  {snapshot
                    ? `${snapshot.squad.threshold} of ${snapshot.squad.members.filter((m) => votable(m.permissions.mask)).length} voting members`
                    : "Choose when creating your group"}
                </dd>
              </div>
            </dl>
          </Panel>
          <Preferences />
        </div>
        <div className="space-y-6">
          {snapshot ? (
            <ThresholdSettings />
          ) : (
            <Panel className="gap-4">
              <h2>Approval threshold</h2>
              <EmptyState title="Set your team’s approval threshold">
                Choose the required number of approvals when creating a
                treasury. Later changes need group approval.
              </EmptyState>
            </Panel>
          )}
          <Panel className="gap-4">
            <h2>Payment protection</h2>
            <div>
              <StatusBadge
                tone={config?.settlementEnabled ? "success" : "neutral"}
              >
                {config?.settlementEnabled
                  ? "Connected"
                  : config?.executionMode === "standard"
                    ? "Standard Squads"
                    : "Pending integration"}
              </StatusBadge>
            </div>
            <p className="text-muted-foreground">
              {config?.executionMode === "standard"
                ? "Squads enforces your group’s approval threshold. Guard policy checks are not active for this group."
                : "Payments require member approvals and a matching, current Guard review before execution."}
            </p>
            <dl className="space-y-4 border-t pt-4">
              <div>
                <dt className="caption">Transaction review</dt>
                <dd className="mt-1">
                  See the decoded asset, amount and destination before
                  approving.
                </dd>
              </div>
              <div>
                <dt className="caption">Execution</dt>
                <dd className="mt-1">
                  {config?.executionMode === "standard"
                    ? "Members with Execute permission apply approved proposals."
                    : "The Guard is the treasury’s payment executor."}
                </dd>
              </div>
              <div>
                <dt className="caption">Policy checks</dt>
                <dd className="mt-1">
                  {config?.executionMode === "standard"
                    ? "Guard integration comes later."
                    : "Private rules remain in the confidential review workflow."}
                </dd>
              </div>
            </dl>
            <p className="caption">
              {config?.executionMode === "standard"
                ? "This treasury currently uses standard Squads multisig execution."
                : config?.settlementEnabled
                  ? "A connected adapter still requires a valid on-chain verdict for each payment."
                  : "Guard review and payment execution will be available when the backend is connected."}
            </p>
          </Panel>
        </div>
      </div>
    </div>
  );
}
