"use client";
import {
  ArrowRight,
  ShieldCheck,
  Users,
  Wallet,
  ScanLine,
  LockKeyhole,
} from "lucide-react";
import { CreateGroupButton, GroupManage } from "./group-controls";

const steps = [
  {
    icon: Users,
    title: "Create your treasury",
    detail: "Add your team’s wallets and choose how many members must approve.",
  },
  {
    icon: Wallet,
    title: "Fund the shared vault",
    detail:
      "Deposit Devnet SOL or supported tokens into your treasury’s vault.",
  },
  {
    icon: ScanLine,
    title: "Review every payment",
    detail:
      "Check the decoded payment, collect votes and wait for a valid Guard review.",
  },
];
export function TreasuryWelcome() {
  return (
    <section
      aria-label="Get started"
      className="overflow-hidden rounded-2xl border bg-card"
    >
      <div className="workspace-hero grid items-center gap-8 p-6 sm:p-8 lg:grid-cols-[1.3fr_1fr] lg:p-10">
        <div>
          <div className="mb-5 flex items-center gap-2 text-xs font-medium text-primary">
            <ShieldCheck className="size-4" />
            YOUR TEAM. YOUR TREASURY.
          </div>
          <h2 className="max-w-[480px] text-[32px] leading-[1.15] font-semibold tracking-[-0.045em] sm:text-[42px]">
            A clear view.
            <br />A safer treasury.
          </h2>
          <p className="mt-5 max-w-[410px] text-[15px] leading-7 text-muted-foreground">
            A shared workspace for your team’s payments. Know where funds go and
            what you’re approving, every time.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <CreateGroupButton />
            <GroupManage label="Open group" />
          </div>
          <p className="caption mt-4">Solana Devnet · Test funds only</p>
        </div>
        <div className="mx-auto hidden w-full max-w-[330px] rounded-2xl border border-primary/15 bg-background/60 p-5 sm:block sm:p-6">
          <div className="flex items-center gap-3 border-b pb-5">
            <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <LockKeyhole className="size-5" />
            </span>
            <div>
              <p className="font-semibold">One shared vault</p>
              <p className="caption">Two checks before funds move</p>
            </div>
          </div>
          <div className="my-5 grid grid-cols-2 gap-3">
            <div className="rounded-xl border p-3">
              <Users className="mb-3 size-5 text-primary" />
              <p className="text-xs font-medium">Member approvals</p>
              <p className="caption mt-1">Your team’s votes</p>
            </div>
            <div className="rounded-xl border p-3">
              <ShieldCheck className="mb-3 size-5 text-primary" />
              <p className="text-xs font-medium">Guard review</p>
              <p className="caption mt-1">Payment policy</p>
            </div>
          </div>
          <div className="flex items-center justify-between rounded-lg bg-secondary/60 px-4 py-3 text-xs">
            <span>Both required to execute</span>
            <ArrowRight className="size-4 text-primary" />
          </div>
        </div>
      </div>
      <div className="grid border-t md:grid-cols-3">
        {steps.map(({ icon: Icon, title, detail }, i) => (
          <div
            key={title}
            className="border-b p-5 last:border-b-0 md:border-r md:border-b-0 md:last:border-r-0 sm:p-6"
          >
            <div className="mb-3 flex items-center gap-3">
              <Icon className="size-[18px] text-primary" />
              <p className="font-medium">{title}</p>
              <span className="ml-auto font-mono text-xs text-muted-foreground/60">
                0{i + 1}
              </span>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">{detail}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
