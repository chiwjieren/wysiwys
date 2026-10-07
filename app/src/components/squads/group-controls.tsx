"use client";
import { useState, useRef, useId, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
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
import {
  fixedMembershipReason,
  GUARDED_GROUP_MAX_INVITES,
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
  const [members, setMembers] = useState([{ id: 0, address: "" }]);
  const nextMemberId = useRef(1);
  const memberFieldId = useId();
  // Empty means "every member must approve" (the default).
  const [threshold, setThreshold] = useState("");
  const [standard, setStandard] = useState(false);
  const invitees = members
    .map((member) => member.address.trim())
    .filter(Boolean);
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
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto bg-card">
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
          <fieldset className="space-y-2">
            <legend className="mb-2">Other member wallets</legend>
            {members.map((member, index) => (
              <div key={member.id} className="flex items-center gap-2">
                <label
                  className="sr-only"
                  htmlFor={`${memberFieldId}-${member.id}`}
                >
                  Wallet address {index + 1}
                </label>
                <Input
                  id={`${memberFieldId}-${member.id}`}
                  value={member.address}
                  placeholder="Solana wallet address"
                  spellCheck={false}
                  autoComplete="off"
                  disabled={!!busy}
                  onChange={(e) =>
                    setMembers((current) =>
                      current.map((row) =>
                        row.id === member.id
                          ? { ...row, address: e.target.value }
                          : row,
                      ),
                    )
                  }
                />
                {members.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    aria-label={`Remove wallet ${index + 1}`}
                    disabled={!!busy}
                    onClick={() => {
                      const remaining = members.filter(
                        (row) => row.id !== member.id,
                      );
                      setMembers(remaining);
                      const nextCount =
                        remaining.filter((row) => row.address.trim()).length +
                        1;
                      if (Number(threshold) > nextCount)
                        setThreshold(String(nextCount));
                    }}
                  >
                    <X className="size-4" />
                  </Button>
                )}
              </div>
            ))}
            <Button
              type="button"
              variant="secondary"
              className="w-full border border-dashed"
              disabled={!!busy || members.length >= maxInvites}
              onClick={() => {
                const id = nextMemberId.current++;
                setMembers((current) => [...current, { id, address: "" }]);
              }}
            >
              <Plus className="size-4" />
              Add wallet
            </Button>
          </fieldset>
          <p className="caption">
            Your wallet joins automatically. Up to {maxInvites} other wallets.
            {!standard && " Members are fixed after creation."}
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
        New members receive proposal and voting permissions. Invitations become
        active after group approval and execution by an authorized executor.
      </p>
    </div>
  );
}

export function GroupInvite() {
  const { snapshot, config } = useSquad();
  const fixed = fixedMembershipReason(config);
  if (fixed)
    return (
      <div className="flex max-w-sm flex-col items-end gap-1 text-right">
        <Button variant="secondary" disabled>
          Invite member
        </Button>
        <p className="caption">{fixed}</p>
      </div>
    );
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="secondary" disabled={!snapshot}>
          Invite member
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card">
        <DialogTitle>Invite a member</DialogTitle>
        <DialogDescription>
          Membership changes need your group’s approval.
        </DialogDescription>
        <InvitationForm />
      </DialogContent>
    </Dialog>
  );
}
