"use client";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { AssetIcon, StatusBadge, commonIcons } from "@/components/design";
import {
  mockDesk,
  mockProviders,
  mockTrades,
  number,
  shorten,
} from "@/lib/mock/data";
import { canInitiateTrade } from "@/lib/mock/settlement";
import { useMockSettlement } from "@/lib/mock/provider";

export function CopyButton({
  value,
  label = "Copy",
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [feedback, setFeedback] = useState("");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback("Copied");
    } catch {
      setFeedback("Copy unavailable");
    }
  };
  return (
    <Button
      variant="secondary"
      className={className}
      onClick={copy}
      aria-live="polite"
    >
      {feedback || label}
    </Button>
  );
}
function CloseDialog() {
  return (
    <DialogClose asChild>
      <button
        aria-label="Close dialog"
        className="absolute top-8 right-8 rounded-sm p-1 opacity-80 hover:opacity-100"
      >
        <AssetIcon src={commonIcons.close} />
      </button>
    </DialogClose>
  );
}
export function InitiateSettlement({
  children,
  tradeId = "OTC-10428",
}: {
  children: ReactNode;
  tradeId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(tradeId);
  const { propose, now, payouts } = useMockSettlement();
  const router = useRouter();
  const trade = mockTrades.find((t) => t.id === selected)!;
  const submit = () => {
    const id = propose(selected);
    if (id) {
      setOpen(false);
      router.push("/transactions/" + id);
    }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="gap-6 overflow-y-auto rounded-xl bg-card p-8 sm:max-w-[640px] max-h-[90dvh]"
      >
        <CloseDialog />
        <DialogTitle className="pr-8 text-[28px] leading-9 font-semibold">
          Initiate settlement
        </DialogTitle>
        <DialogDescription>
          Select an approved trade. Payout values are derived from its ticket.
        </DialogDescription>
        <div className="h-px bg-border" />
        <div className="space-y-2">
          <label id="trade-label" className="font-medium">
            Approved trade
          </label>
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger
              aria-labelledby="trade-label"
              className="w-full !h-12 bg-secondary"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {mockTrades
                .filter((t) => t.status === "Approved" && t.id !== "OTC-10425")
                .map((t) => (
                  <SelectItem
                    key={t.id}
                    value={t.id}
                    disabled={!canInitiateTrade(t, payouts, now)}
                  >
                    {t.id} · {t.counterparty} · Version {t.version}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-3 rounded-xl border bg-secondary p-4">
          <p className="caption">Read only · from approved trade</p>
          <dl className="grid grid-cols-[minmax(100px,160px)_1fr] gap-x-8 gap-y-2 text-xs leading-[18px]">
            {[
              [
                "Counterparty",
                trade.counterparty + " · Verified settlement wallet",
              ],
              [
                "Client pays",
                number(trade.clientAmount) + " test USDT · Client testnet",
              ],
              [
                "Desk sends",
                number(trade.payoutAmount) + " test USDC · Solana Devnet",
              ],
              ["Destination", shorten(trade.destination) + " · Registry match"],
              ["Trade validity", "Expires today at 11:15"],
            ].map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="space-y-3 rounded-xl bg-success-bg p-6">
          <p className="text-success">Decoded preview</p>
          <p>
            Send {number(trade.payoutAmount)} test USDC to {trade.counterparty}
            &apos;s verified wallet.
          </p>
          <p className="caption">
            Preview only. Client payment and the exact trade are checked
            independently.
          </p>
        </div>
        <div className="flex gap-4">
          <DialogClose asChild>
            <Button variant="secondary" className="w-40">
              Cancel
            </Button>
          </DialogClose>
          <Button
            className="flex-1"
            onClick={submit}
            disabled={!canInitiateTrade(trade, payouts, now)}
          >
            Propose payout
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
export function ReceiveAssets({ children }: { children: ReactNode }) {
  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="gap-6 rounded-xl bg-card p-8 sm:max-w-[480px]"
      >
        <CloseDialog />
        <DialogTitle className="text-[28px] leading-9">
          Receive assets
        </DialogTitle>
        <DialogDescription>
          Fund the Solana settlement vault with SOL or supported payout tokens.
        </DialogDescription>
        <div className="h-px bg-border" />
        <div>
          <p className="caption mb-2">Treasury vault</p>
          <p className="break-all text-xs">{mockDesk.vault}</p>
        </div>
        <CopyButton
          value={mockDesk.vault}
          label="Copy vault address"
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        />
        <p className="caption">
          Send to the vault address, not the multisig account. Sample address
          only.
        </p>
      </DialogContent>
    </Dialog>
  );
}
export function InfrastructureDialog({ children }: { children: ReactNode }) {
  const router = useRouter();
  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="gap-4 rounded-xl bg-card p-6 sm:max-w-[548px]"
      >
        <CloseDialog />
        <DialogTitle className="pr-6 text-lg leading-[26px]">
          Verification infrastructure
        </DialogTitle>
        <DialogDescription>Technical status · Sample data</DialogDescription>
        <div className="h-px bg-border" />
        {mockProviders.map((provider) => (
          <div
            className="flex items-center justify-between gap-3"
            key={provider}
          >
            <p className="font-medium">{provider}</p>
            <StatusBadge className="w-[152px]">Configured</StatusBadge>
          </div>
        ))}
        <div className="h-px bg-border" />
        <p className="caption">Active networks are configured per provider.</p>
        <p className="caption">
          Client-payment network selection is pending backend setup.
        </p>
        <p>RPC cross-check: sources must agree</p>
        <p>Listener and CRE runner: health shown here</p>
        <DialogClose asChild>
          <Button
            variant="secondary"
            className="w-fit"
            onClick={() => router.push("/transactions/unavailable")}
          >
            View unavailable state
          </Button>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}
export function SampleDetails({
  title,
  children,
  content,
}: {
  title: string;
  children: ReactNode;
  content: ReactNode;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="bg-card">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          Sample record. Backend integration is pending.
        </DialogDescription>
        {content}
      </DialogContent>
    </Dialog>
  );
}
