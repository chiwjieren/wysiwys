"use client";
import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { CopyButton } from "@/components/dialogs";
import { useSquad } from "@/lib/squads/provider";
import { useWalletConnection } from "@/lib/auth/provider";
import { PublicKey } from "@solana/web3.js";
import {
  GUARDED_GROUP_MAX_INVITES,
  membershipChangeNote,
  planMemberRemoval,
  standardGroupsEnabled,
} from "@/lib/squads/groups";

// Next.js inlines NEXT_PUBLIC_* only for literal property access.
const standardEnabled = standardGroupsEnabled(
  process.env.NEXT_PUBLIC_ENABLE_STANDARD_GROUPS,
);

export function CreateGroupButton({
  label = "Create treasury",
  variant = "default",
}: {
  label?: string;
  variant?: "default" | "secondary" | "ghost";
}) {
  const { createGroup, busy, error } = useSquad();
  const auth = useWalletConnection();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [members, setMembers] = useState("");
  // Empty means "every member must approve" (the default).
  const [threshold, setThreshold] = useState("");
  const [standard, setStandard] = useState(false);
  const invitees = members.split(/[\s,]+/).filter(Boolean);
  const count = invitees.length + 1;
  const required = threshold || String(count);
  const maxInvites = standard ? 19 : GUARDED_GROUP_MAX_INVITES;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant={variant} disabled={!!busy}>
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card">
        <DialogTitle>
          {standard ? "Create a standard group" : "Create a guarded treasury"}
        </DialogTitle>
        <DialogDescription>
          {standard
            ? "Standard group (no guard): payouts execute without a Guard review."
            : "Payouts execute only after member approval and an approved Guard review."}
        </DialogDescription>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const address = await createGroup(
              name.trim(),
              invitees,
              Number(required),
              standard ? "standard" : "guarded",
            );
            if (address) {
              setOpen(false);
              router.push(`/?group=${address}`);
            }
          }}
        >
          <label className="block space-y-2">
            <span>Treasury name</span>
            <Input
              value={name}
              maxLength={80}
              required
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="block space-y-2">
            <span>Other member wallets</span>
            <textarea
              className="min-h-24 w-full rounded-lg border bg-secondary p-3 text-xs"
              value={members}
              onChange={(e) => setMembers(e.target.value)}
              placeholder="One Solana wallet address per line"
            />
          </label>
          <p className="caption">
            Your wallet joins automatically. Up to {maxInvites} other wallets.
            {!standard &&
              " Member changes need the members' vote and are checked by the guard."}
          </p>
          <label className="block space-y-2">
            <span>Required approvals</span>
            <Input
              type="number"
              min={1}
              max={count}
              required
              value={required}
              onChange={(e) => setThreshold(e.target.value)}
            />
          </label>
          <p className="caption">
            {required} of {count} members · Solana Devnet · Test funds only
          </p>
          <p className="caption">
            {standard
              ? "Your wallet pays creation fees and account rent. You can propose, vote and execute approved proposals. Other members can propose and vote."
              : "One transaction creates the Squads multisig and its guard configuration. Your wallet pays fees and account rent. Every member can propose and vote; only the guard executes payouts. Fund it with Deposit afterwards."}
          </p>
          {standardEnabled && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={standard}
                onChange={(e) => setStandard(e.target.checked)}
              />
              <span>Standard group (no guard)</span>
            </label>
          )}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {auth.connected ? (
            <Button
              type="submit"
              disabled={
                !!busy ||
                !name.trim() ||
                !auth.address ||
                invitees.length > maxInvites ||
                !/^\d+$/.test(required) ||
                Number(required) < 1 ||
                Number(required) > count
              }
            >
              {busy ||
                (standard
                  ? "Create group on devnet"
                  : "Create treasury on devnet")}
            </Button>
          ) : (
            <Button
              type="button"
              onClick={auth.connect}
              disabled={!auth.ready || !auth.configured}
            >
              Connect wallet to create
            </Button>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
export function GroupSwitcher() {
  const { groups, config, groupName, openGroup, busy } = useSquad();
  const router = useRouter();
  if (!config || !groups.length) return null;
  return (
    <select
      aria-label="Your groups"
      className="w-full rounded border bg-sidebar p-2 text-xs"
      disabled={!!busy}
      value={config.multisig}
      onChange={(e) => {
        openGroup(e.target.value);
        router.push(`/?group=${e.target.value}`);
      }}
    >
      {!groups.some((g) => g.address === config.multisig) && (
        <option value={config.multisig}>{groupName}</option>
      )}
      {groups.map((g) => (
        <option key={g.address} value={g.address}>
          {g.name}
        </option>
      ))}
    </select>
  );
}
export function GroupManage({
  label = "Open or create a group",
  children,
}: {
  label?: string;
  children?: ReactNode;
}) {
  const { openGroup, busy, error } = useSquad();
  const [address, setAddress] = useState("");
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={
            children
              ? "w-full rounded-xl text-left transition-colors hover:bg-secondary/80"
              : "rounded-lg bg-secondary px-4 py-2.5 font-medium"
          }
        >
          {children || label}
        </button>
      </DialogTrigger>
      <DialogContent className="bg-card">
        <DialogTitle>Your treasuries</DialogTitle>
        <DialogDescription>
          Open a shared treasury using its group address, or create a new
          guarded treasury.
        </DialogDescription>
        <GroupSwitcher />
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            openGroup(address.trim());
            router.push(`/?group=${encodeURIComponent(address.trim())}`);
            setOpen(false);
          }}
        >
          <label htmlFor="open-group-address">Group address</label>
          <Input
            id="open-group-address"
            placeholder="Solana multisig address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            required
          />
          <Button
            className="w-full"
            variant="secondary"
            disabled={!address.trim() || !!busy}
          >
            Open group
          </Button>
        </form>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <div className="border-t pt-4">
          <CreateGroupButton />
        </div>
      </DialogContent>
    </Dialog>
  );
}
function InvitationForm() {
  const { invite, config, snapshot, account, busy } = useSquad();
  const [address, setAddress] = useState("");
  const router = useRouter();
  const member = snapshot?.squad.members.find(
    (m) => m.key.toBase58() === account?.address,
  );
  if (!config) return null;
  const link =
    typeof window === "undefined"
      ? ""
      : `${window.location.origin}/?group=${config.multisig}`;
  return (
    <div className="space-y-4">
      <h2>Invite members</h2>
      <p className="caption">
        Share this link with wallets already included in your group.
      </p>
      <CopyButton value={link} label="Copy group invite link" />
      <label htmlFor="invite-member-address">New member wallet address</label>
      <Input
        id="invite-member-address"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
      />
      <Button
        disabled={
          !member || !(member.permissions.mask & 1) || !!busy || !address.trim()
        }
        onClick={async () => {
          const id = await invite(address.trim());
          if (id) router.push(`/transactions/${id}`);
        }}
      >
        Propose member invitation
      </Button>
      <p className="caption">
        {config.executor && config.executionMode !== "standard"
          ? "New members can propose and vote, never execute. The invitation takes effect after the group approves it and it is executed through the guard."
          : "New members receive proposal and voting permissions. Invitations become active after group approval and execution by an authorized executor."}
      </p>
    </div>
  );
}

export function GroupInvite() {
  const { snapshot, config } = useSquad();
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="secondary" disabled={!snapshot}>
          Invite member
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card">
        <DialogTitle>Invite a member</DialogTitle>
        <DialogDescription>{membershipChangeNote(config)}</DialogDescription>
        <InvitationForm />
      </DialogContent>
    </Dialog>
  );
}

// Proposes a RemoveMember config change. Never offered for the guard executor.
export function RemoveMemberButton({ address }: { address: string }) {
  const { config, snapshot, account, removeMember, busy, error } = useSquad();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  if (!snapshot || !config || address === config.executor) return null;
  const squad = snapshot.squad;
  const proposer = squad.members.find(
    (m) => m.key.toBase58() === account?.address,
  );
  let plan: ReturnType<typeof planMemberRemoval> | undefined;
  let problem = "";
  try {
    plan = planMemberRemoval(squad, new PublicKey(address), config.executor);
  } catch (e) {
    problem = e instanceof Error ? e.message : "This member cannot be removed.";
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="secondary"
          disabled={!proposer || !(proposer.permissions.mask & 1) || !!busy}
        >
          Remove
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card">
        <DialogTitle>Remove a member</DialogTitle>
        <DialogDescription>{membershipChangeNote(config)}</DialogDescription>
        <p className="break-all text-xs">{address}</p>
        {problem ? (
          <p role="alert" className="text-destructive">
            {problem}
          </p>
        ) : plan?.newThreshold !== undefined ? (
          <p>
            Removing this member leaves {plan.remainingVoters} voters, so this
            proposal also lowers required approvals from {squad.threshold} to{" "}
            {plan.newThreshold}.
          </p>
        ) : (
          <p>
            Required approvals stay at {squad.threshold} of{" "}
            {plan?.remainingVoters} voters.
          </p>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <Button
          disabled={!!problem || !proposer || !!busy}
          onClick={async () => {
            const id = await removeMember(address);
            if (id) {
              setOpen(false);
              router.push(`/transactions/${id}`);
            }
          }}
        >
          {busy || "Propose member removal"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
