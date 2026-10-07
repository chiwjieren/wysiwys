"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import {
  Menu,
  ShieldCheck,
  LayoutDashboard,
  ArrowLeftRight,
  Users,
  Settings,
  ChevronsUpDown,
  ArrowUpRight,
  Circle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Avatar } from "@/components/design";
import { SquadProvider, useSquad } from "@/lib/squads/provider";
import { GroupManage } from "@/components/squads/group-controls";
import { WalletButton } from "@/components/squads/wallet-button";
import { cn } from "@/lib/utils";
import { useWalletConnection } from "@/lib/auth/provider";
import { shortAddress } from "@/components/squads/treasury-ui";

const nav = [
  { label: "Dashboard", href: "/", icon: LayoutDashboard },
  { label: "Transactions", href: "/transactions", icon: ArrowLeftRight },
  { label: "Members", href: "/members", icon: Users },
  { label: "Settings", href: "/settings", icon: Settings },
] as const;
function Workspace({ children }: { children: ReactNode }) {
  const { config, snapshot, groupName } = useSquad();
  const auth = useWalletConnection();
  useEffect(() => {
    document.documentElement.dataset.theme =
      localStorage.getItem("wysiwys.theme") || "dark";
  }, []);
  const path = usePathname();
  const active = nav.find((n) =>
    n.href === "/" ? path === "/" : path.startsWith(n.href),
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigation = (
    <nav aria-label="Main navigation" className="flex flex-col gap-1.5">
      {nav.map(({ icon: Icon, ...item }) => (
        <Link
          key={item.href}
          href={item.href}
          onClick={() => setMobileOpen(false)}
          aria-current={item.label === active?.label ? "page" : undefined}
          className={cn(
            "relative flex h-12 items-center gap-3 rounded-xl px-4 font-medium text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground",
            item.label === active?.label &&
              "bg-primary/10 text-primary before:absolute before:inset-y-3.5 before:left-0 before:w-[3px] before:rounded-full before:bg-primary",
          )}
        >
          <Icon className="size-[18px]" aria-hidden="true" />
          {item.label}
        </Link>
      ))}
    </nav>
  );
  const sidebar = (
    <div className="flex h-full flex-col gap-7 p-5">
      <Link
        href="/"
        onClick={() => setMobileOpen(false)}
        className="flex items-center gap-3 px-2 py-2"
      >
        <span className="flex size-10 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
          <ShieldCheck className="size-6" />
        </span>
        <span className="text-xl font-semibold tracking-tight">
          Wysiwys
          <span className="mt-0.5 block text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Treasury workspace
          </span>
        </span>
      </Link>
      <GroupManage label="Switch treasury">
        <div className="rounded-xl border bg-card p-4 text-left">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="eyebrow">Treasury</span>
            <ChevronsUpDown className="size-3.5 text-muted-foreground" />
          </div>
          <p className="truncate font-semibold">
            {config ? groupName : "Your workspace"}
          </p>
          <p className="caption mt-1">
            {config?.multisig
              ? shortAddress(config.multisig)
              : "Create or open a treasury"}
          </p>
          {snapshot && (
            <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">
              {snapshot.squad.threshold} approvals required
            </p>
          )}
        </div>
      </GroupManage>
      <div className="space-y-3">
        <p className="eyebrow px-4">Workspace</p>
        {navigation}
      </div>
      <div className="mt-auto space-y-5 pt-6">
        <div className="space-y-2 rounded-xl border border-primary/10 bg-primary/5 p-4">
          <div className="flex items-center gap-2 font-medium">
            <ShieldCheck className="size-4 shrink-0 text-primary" />
            {config?.guardProgram
              ? "Guarded treasury"
              : "Review before you sign"}
          </div>
          <p className="caption">
            {config?.guardProgram
              ? "Member approval and a valid Guard review are required."
              : "Check every amount and destination before you approve."}
          </p>
          <Link
            href="/status"
            onClick={() => setMobileOpen(false)}
            className="flex items-center gap-1 pt-1 text-xs text-muted-foreground hover:text-primary"
          >
            Service status
            <ArrowUpRight className="size-3" />
          </Link>
        </div>
        <div className="flex items-center gap-3 border-t pt-5">
          <Avatar size={36} initials={auth.address?.slice(0, 2) || "W"} />
          <div className="min-w-0">
            <p className="truncate text-xs font-medium">
              {auth.address
                ? shortAddress(auth.address)
                : "Wallet not connected"}
            </p>
            <p className="caption">
              {auth.address
                ? "Your connected wallet"
                : "Connect to propose and vote"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
  return (
    <div className="min-h-screen">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:z-[100] focus:bg-primary focus:p-3 focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <aside
        data-shell-sidebar
        className="fixed inset-y-0 left-0 z-30 hidden w-[248px] overflow-y-auto border-r bg-sidebar lg:block"
      >
        {sidebar}
      </aside>
      <div className="lg:ml-[248px]">
        <header className="flex min-h-[76px] items-center gap-3 border-b bg-background px-5 sm:px-8 lg:px-10">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open navigation"
            className="-ml-2 lg:hidden"
            onClick={() => setMobileOpen(true)}
          >
            <Menu />
          </Button>
          <p className="hidden min-w-0 truncate text-xs text-muted-foreground sm:block">
            {config ? groupName : "Your workspace"}
            <span className="mx-3 text-muted-foreground/40">/</span>
            <span className="text-foreground">
              {active?.label || "Service status"}
            </span>
          </p>
          <div className="ml-auto flex shrink-0 items-center gap-3 sm:gap-5">
            <span className="hidden items-center gap-2 text-xs text-muted-foreground sm:inline-flex">
              <Circle className="size-1.5 fill-warning text-warning" />
              Devnet
              <span className="hidden text-muted-foreground/60 xl:inline">
                · Test funds only
              </span>
            </span>
            <WalletButton />
          </div>
        </header>
        <main
          id="main-content"
          className="mx-auto w-full max-w-[1520px] px-5 pt-7 pb-12 sm:px-8 sm:pt-9 lg:px-10"
        >
          {children}
        </main>
        <footer className="flex flex-wrap justify-between gap-2 border-t px-5 py-5 text-[11px] text-muted-foreground sm:px-8 lg:px-10">
          <span>Wysiwys · What you see is what you sign.</span>
          <span>Solana Devnet · Test keys and funds only</span>
        </footer>
      </div>
      <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
        <DialogContent className="max-w-[360px] gap-0 bg-sidebar p-0 sm:p-0">
          <DialogTitle className="sr-only">Workspace navigation</DialogTitle>
          <DialogDescription className="sr-only">
            Switch treasury or open a workspace page.
          </DialogDescription>
          {sidebar}
        </DialogContent>
      </Dialog>
    </div>
  );
}
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <SquadProvider>
      <Workspace>{children}</Workspace>
    </SquadProvider>
  );
}
