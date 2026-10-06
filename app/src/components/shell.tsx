"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AssetIcon, Avatar, StatusBadge } from "@/components/design";
import { figmaAssets } from "@/lib/figma-assets";
import { MockSettlementProvider } from "@/lib/mock/provider";
import { mockDesk } from "@/lib/mock/data";
import { cn } from "@/lib/utils";

const nav = [
  { label: "Dashboard", href: "/", icon: "imgIconDashboard" },
  { label: "Transactions", href: "/transactions", icon: "imgIconTransactions" },
  { label: "Members", href: "/members", icon: "imgIconMembers" },
  { label: "Settings", href: "/settings", icon: "imgIconSettings" },
] as const;
function ShellContent({ children }: { children: ReactNode }) {
  const path = usePathname();
  const active =
    nav.find((n) =>
      n.href === "/" ? path === "/" : path.startsWith(n.href),
    ) ?? nav[0];
  const [mobileOpen, setMobileOpen] = useState(false);
  const scope =
    active.label === "Dashboard"
      ? figmaAssets.dashboard
      : active.label === "Members"
        ? figmaAssets.members
        : active.label === "Settings"
          ? figmaAssets.settings
          : figmaAssets.review;
  const navigation = (
    <nav aria-label="Main navigation" className="flex flex-col gap-2">
      {nav.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          onClick={() => setMobileOpen(false)}
          aria-current={item.label === active.label ? "page" : undefined}
          className={cn(
            "flex h-11 items-center gap-3 rounded-lg px-3 font-medium text-muted-foreground transition-colors hover:bg-secondary",
            item.label === active.label && "bg-secondary text-foreground",
          )}
        >
          <AssetIcon src={scope[item.icon]} />
          {item.label}
        </Link>
      ))}
    </nav>
  );
  const sidebar = (
    <div className="flex h-full flex-col gap-6 p-5">
      <Link
        href="/"
        className="flex items-center gap-2.5 text-lg leading-[26px] font-semibold"
      >
        <AssetIcon src={scope.imgIconShield} size={28} />
        OmniCounter
      </Link>
      <div className="h-2" />
      <div className="space-y-3 rounded-xl bg-secondary p-4">
        <p className="font-medium leading-5">{mockDesk.name}</p>
        <p className="caption">7nYp…8qLm &nbsp; ↗</p>
        <StatusBadge className="w-full">3 of 3 approvals</StatusBadge>
      </div>
      {navigation}
      <div className="mt-auto space-y-2 pt-6">
        <div className="flex items-center gap-2 text-xs text-success">
          <AssetIcon src={scope.imgIconShield1} size={16} />
          Settlement firewall
        </div>
        <p className="caption">No proof, no payout.</p>
        <div className="h-px bg-border" />
        <div className="flex items-center gap-2.5 text-xs">
          <Avatar initials="ZJ" size={32} />
          Zhi Jian · You
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
        className="fixed inset-y-0 left-0 z-30 hidden w-[240px] border-r bg-sidebar lg:block"
      >
        {sidebar}
      </aside>
      <div className="lg:ml-[240px]">
        <header className="flex h-[72px] items-center gap-4 px-5 sm:px-8 lg:px-10">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open navigation"
            className="lg:hidden"
            onClick={() => setMobileOpen(true)}
          >
            <Menu />
          </Button>
          <p className="caption min-w-0 truncate">
            {mockDesk.name} &nbsp;/&nbsp; {active.label}
          </p>
          <div className="ml-auto flex shrink-0 items-center gap-4">
            <StatusBadge className="hidden min-w-0 w-[72px] sm:inline-flex">
              Devnet
            </StatusBadge>
            <span className="caption hidden sm:inline">Sample data</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="secondary"
                  className="h-10 w-[188px] max-sm:w-auto"
                >
                  Zhi Jian · 9wK…3tF
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <Link href="/settings">Wallet preferences</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/members">Member permissions</Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main
          id="main-content"
          className="mx-auto max-w-[1440px] px-5 pt-6 pb-8 sm:px-8 lg:px-10"
        >
          {children}
        </main>
      </div>
      <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
        <DialogContent className="max-w-[360px] bg-sidebar">
          <DialogTitle>OmniCounter</DialogTitle>
          <DialogDescription>No proof, no payout.</DialogDescription>
          {navigation}
        </DialogContent>
      </Dialog>
    </div>
  );
}
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <MockSettlementProvider>
      <ShellContent>{children}</ShellContent>
    </MockSettlementProvider>
  );
}
