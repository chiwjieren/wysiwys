"use client";
import { useState, useRef, useEffect, useId, type ReactNode } from "react";
import { Plus, X, ShieldCheck } from "lucide-react";
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
  MEMBER_PERMISSION_CHOICES,
  membershipChangeNote,
  planMemberEdit,
  planMemberRemoval,
  standardGroupsEnabled,
  validateMemberInputs,
} from "@/lib/squads/groups";
import {
  permissionChoiceLabel,
  shortAddress,
} from "@/lib/squads/config-actions";
import { MEMBER_NAME_MAX, useMemberNames } from "@/lib/squads/member-names";
import { buildCreationPolicy, randomPolicySalt } from "@/lib/squads/policy";
import { parseAmount } from "@/lib/squads/governance";
import { tokenAmount } from "@/lib/squads/payments";

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
  const { createGroup, busy, error, deploymentToken } = useSquad();
  const auth = useWalletConnection();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const nextMemberId = useRef(1);
  const memberInput = useRef<HTMLInputElement>(null);
  const inputPrefix = useId();
  const previousCount = useRef(1);
  const [members, setMembers] = useState([{ id: 0, address: "" }]);
  useEffect(() => {
    if (members.length > previousCount.current) memberInput.current?.focus();
    previousCount.current = members.length;
  }, [members.length]);
  // Empty means "every member must approve" (the default).
  const [threshold, setThreshold] = useState("");
  const [standard, setStandard] = useState(false);
  // Payment policy: the deployment's demo policy, or the treasury's own (whitelist, cap, screening).
  const [ownPolicy, setOwnPolicy] = useState(false);
  // The own-policy fields open a second panel on the right (stacked on small screens).
  const policyPanel = !standard && ownPolicy;
  const [whitelist, setWhitelist] = useState("");
  const [cap, setCap] = useState("100000");
  const [screening, setScreening] = useState(true);
  const [salt] = useState(randomPolicySalt);
  const policyDraft = (() => {
    if (standard || !ownPolicy) return { policy: undefined, error: "" };
    if (!deploymentToken)
      return {
        policy: undefined,
        error: "The treasury token is not configured.",
      };
    try {
      return {
        policy: buildCreationPolicy({
          whitelist: whitelist.split(/\s+/).filter(Boolean),
          cap: parseAmount(cap, deploymentToken.decimals).toString(),
          screening,
          token: deploymentToken,
          salt,
        }),
        error: "",
      };
    } catch (e) {
      return {
        policy: undefined,
        error: e instanceof Error ? e.message : "Invalid policy.",
      };
    }
  })();
  const checked = validateMemberInputs(
    members.map((m) => m.address),
    auth.address ?? undefined,
  );
  const invitees = checked.invitees;
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
      <DialogContent
        className={`max-h-[90vh] overflow-y-auto bg-card ${policyPanel ? "lg:max-w-4xl" : ""}`}
      >
        <DialogTitle>
          {standard ? "Create a standard group" : "Create a guarded treasury"}
        </DialogTitle>
        <DialogDescription>
          {standard
            ? "Standard group (no guard): payouts execute without a Guard review."
            : "Payouts execute only after member approval and an approved Guard review."}
        </DialogDescription>
        <form
          className="space-y-5"
          onSubmit={async (e) => {
            e.preventDefault();
            const address = await createGroup(
              name.trim(),
              invitees,
              Number(required),
              standard ? "standard" : "guarded",
              policyDraft.policy,
            );
            if (address) {
              setOpen(false);
              router.push(`/?group=${address}`);
            }
          }}
        >
          <div
            className={
              policyPanel ? "grid items-start gap-6 lg:grid-cols-2" : undefined
            }
          >
            <div className="space-y-4">
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
                <legend className="mb-2">Members</legend>
                <div className="flex items-center gap-2 rounded-lg border bg-secondary px-3 py-2 text-xs">
                  <span className="flex-1">
                    {auth.address
                      ? `${shortAddress(auth.address)} (you)`
                      : "Your wallet (connect to continue)"}
                  </span>
                  <span className="caption">Joins automatically</span>
                </div>
                {members.map((member, i) => (
                  <div key={member.id} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Input
                        aria-label={`Member ${i + 2} wallet address`}
                        aria-invalid={!!checked.errors[i]}
                        id={`${inputPrefix}-member-${member.id}`}
                        ref={i === members.length - 1 ? memberInput : undefined}
                        className="font-mono text-xs"
                        value={member.address}
                        placeholder={`Member ${i + 2} wallet address`}
                        spellCheck={false}
                        autoComplete="off"
                        onChange={(e) =>
                          setMembers(
                            members.map((m, j) =>
                              j === i ? { ...m, address: e.target.value } : m,
                            ),
                          )
                        }
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove member ${i + 2}`}
                        onClick={() =>
                          setMembers(members.filter((_, j) => j !== i))
                        }
                      >
                        <X className="size-4" />
                      </Button>
                    </div>
                    {checked.errors[i] && (
                      <p className="text-xs text-destructive">
                        {checked.errors[i]}
                      </p>
                    )}
                  </div>
                ))}
                <Button
                  type="button"
                  variant="secondary"
                  disabled={members.length >= maxInvites}
                  onClick={() =>
                    setMembers([
                      ...members,
                      { id: nextMemberId.current++, address: "" },
                    ])
                  }
                >
                  <Plus className="size-4" /> Add member
                </Button>
              </fieldset>
              <p className="caption">
                Your wallet joins automatically. Up to {maxInvites} other
                wallets.
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
              {!standard && (
                <fieldset className="space-y-2">
                  <legend className="mb-2">Payment policy</legend>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="policy"
                      checked={!ownPolicy}
                      onChange={() => setOwnPolicy(false)}
                    />
                    Demo policy (the deployment's default; its whitelist stays
                    private)
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="policy"
                      checked={ownPolicy}
                      onChange={() => setOwnPolicy(true)}
                    />
                    This treasury's own policy
                  </label>
                </fieldset>
              )}
            </div>
            {policyPanel && (
              <div className="space-y-3 rounded-lg border p-4">
                <p className="font-medium">This treasury&apos;s policy</p>
                <label className="block space-y-1 text-sm">
                  <span>Whitelisted wallets (one per line)</span>
                  <textarea
                    aria-label="Whitelisted wallets"
                    className="min-h-24 w-full rounded-md border bg-transparent p-2 font-mono text-xs"
                    value={whitelist}
                    spellCheck={false}
                    onChange={(e) => setWhitelist(e.target.value)}
                  />
                </label>
                <label className="block space-y-1 text-sm">
                  <span>
                    Per-payment cap ({deploymentToken?.symbol ?? "token"})
                  </span>
                  <Input
                    inputMode="decimal"
                    value={cap}
                    onChange={(e) => setCap(e.target.value)}
                  />
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={screening}
                    onChange={(e) => setScreening(e.target.checked)}
                  />
                  Sanctions screening (Scorechain)
                </label>
                {policyDraft.error ? (
                  <p className="text-xs text-destructive">
                    {policyDraft.error}
                  </p>
                ) : (
                  <p className="caption">
                    Pays only these wallets, in{" "}
                    {deploymentToken?.symbol ?? "the treasury token"} or SOL.
                    The cap is one number in base units, so SOL payments are
                    capped at{" "}
                    {tokenAmount(
                      policyDraft.policy?.maxAmountPerPayment ?? "0",
                      9,
                    )}{" "}
                    SOL. Members can change the policy later by vote. Your
                    wallet signs once to store it.
                  </p>
                )}
              </div>
            )}
          </div>
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
              className="w-full"
              disabled={
                !!busy ||
                !name.trim() ||
                !auth.address ||
                invitees.length > maxInvites ||
                !checked.valid ||
                !/^\d+$/.test(required) ||
                Number(required) < 1 ||
                Number(required) > count ||
                (!standard && ownPolicy && !policyDraft.policy)
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

function parseWallet(value: string) {
  try {
    return { key: new PublicKey(value) };
  } catch {
    return { problem: "Enter the new member's Solana wallet address." };
  }
}

// Edit a member: a browser-only display name, and one config proposal that
// replaces the wallet and/or changes permissions (never Execute). Never offered
// for the guard executor.
export function EditMemberButton({
  address,
  label,
}: {
  address: string;
  label: string;
}) {
  const { config, snapshot, account, editMember, busy, error } = useSquad();
  const { names, save } = useMemberNames(config?.multisig);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [nameNote, setNameNote] = useState("");
  const [wallet, setWallet] = useState("");
  const [permissions, setPermissions] = useState<number>();
  if (!snapshot || !config || address === config.executor) return null;
  const squad = snapshot.squad;
  const current = squad.members.find((m) => m.key.toBase58() === address);
  const proposer = squad.members.find(
    (m) => m.key.toBase58() === account?.address,
  );
  const canPropose = !!proposer && !!(proposer.permissions.mask & 1);
  const guarded = !!config.executor && config.executionMode !== "standard";
  const parsed = wallet.trim() ? parseWallet(wallet.trim()) : undefined;
  const changesPermissions =
    permissions !== undefined && permissions !== current?.permissions.mask;
  let plan: ReturnType<typeof planMemberEdit> | undefined;
  let problem = parsed?.problem ?? "";
  if ((parsed || changesPermissions) && !problem) {
    try {
      plan = planMemberEdit(squad, {
        member: new PublicKey(address),
        newWallet: parsed?.key,
        permissions: changesPermissions ? permissions : undefined,
        executor: config.executor,
        vault: snapshot.vault.toBase58(),
        label: label.replace(/ · You$/, ""),
      });
    } catch (e) {
      problem = e instanceof Error ? e.message : "This change is not allowed.";
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
        if (next) {
          setName(names[address] ?? "");
          setNameNote("");
          setWallet("");
          setPermissions(undefined);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="secondary" disabled={!!busy}>
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card">
        <DialogTitle>Edit member</DialogTitle>
        <DialogDescription className="break-all">
          {label} · {address}
        </DialogDescription>
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            setNameNote(
              save(address, name)
                ? name.trim()
                  ? "Name saved."
                  : "Name cleared."
                : "This browser blocked saving the name.",
            );
          }}
        >
          <label className="block" htmlFor="edit-member-name">
            Name
          </label>
          <div className="flex gap-2">
            <Input
              id="edit-member-name"
              value={name}
              maxLength={MEMBER_NAME_MAX}
              placeholder={label}
              onChange={(e) => {
                setName(e.target.value);
                setNameNote("");
              }}
            />
            <Button type="submit" variant="secondary">
              Save name
            </Button>
          </div>
          <p className="caption">
            Only visible in this browser. Saving a name sends no transaction.
            {nameNote && ` ${nameNote}`}
          </p>
        </form>
        <div className="space-y-4 border-t pt-4">
          <div>
            <h3 className="font-medium">Propose a change</h3>
            <p className="caption">
              {membershipChangeNote(config)} Changes apply only after the
              proposal is approved and executed.
            </p>
          </div>
          <label className="block" htmlFor="edit-member-wallet">
            Replace wallet
          </label>
          <Input
            id="edit-member-wallet"
            placeholder="New Solana wallet address (optional)"
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
          />
          <fieldset className="space-y-2">
            <legend className="mb-2">Permissions</legend>
            {MEMBER_PERMISSION_CHOICES.map((mask) => (
              <label key={mask} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="edit-member-permissions"
                  value={mask}
                  checked={(permissions ?? current?.permissions.mask) === mask}
                  onChange={() => setPermissions(mask)}
                />
                <span>{permissionChoiceLabel(mask)}</span>
              </label>
            ))}
            <p className="caption">
              {guarded
                ? "Members never get Execute. Only the guard executes."
                : "Execute cannot be granted from here."}
            </p>
          </fieldset>
          {problem ? (
            <p role="alert" className="text-destructive">
              {problem}
            </p>
          ) : plan ? (
            <div className="space-y-1 rounded-lg bg-secondary p-3">
              <p className="caption">This proposal will:</p>
              <ul className="list-disc space-y-1 pl-5">
                {plan.summary.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="caption">
              Enter a new wallet or choose different permissions to propose a
              change.
            </p>
          )}
          {!canPropose && (
            <p className="caption">
              Connect a member wallet with Initiate permission to propose.
            </p>
          )}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <Button
            disabled={!plan || !canPropose || !!busy}
            onClick={async () => {
              const id = await editMember(address, {
                newWallet: parsed?.key?.toBase58(),
                permissions: changesPermissions ? permissions : undefined,
              });
              if (id) {
                setOpen(false);
                router.push(`/transactions/${id}`);
              }
            }}
          >
            {busy || "Propose member change"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
