"use client";
import type { Wallet } from "@wallet-standard/base";
import { ArrowUpRight, Wallet as WalletIcon, LoaderCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
// Phantom is the only supported wallet for now.
const install = [
  {
    name: "Phantom",
    url: "https://phantom.com/download",
    color: "bg-[#ab9ff2]",
    letter: "P",
  },
];
export function WalletPicker({
  open,
  onOpenChange,
  wallets,
  connecting,
  error,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  wallets: Wallet[];
  connecting: string;
  error: string;
  onSelect: (wallet: Wallet) => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-6 rounded-2xl bg-card sm:max-w-[420px]">
        <div className="flex size-12 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
          <WalletIcon className="size-6" />
        </div>
        <div className="space-y-2">
          <DialogTitle className="text-2xl">Connect your wallet</DialogTitle>
          <DialogDescription>
            Connect Phantom to create or join your treasury.
          </DialogDescription>
        </div>
        {error && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        <div className="space-y-2">
          {wallets.map((wallet) => (
            <Button
              key={wallet.name}
              aria-label={wallet.name}
              aria-busy={connecting === wallet.name}
              variant="secondary"
              disabled={!!connecting}
              onClick={() => void onSelect(wallet)}
              className="h-16 w-full justify-start gap-3 rounded-xl px-4"
            >
              {/* Extension-provided Wallet Standard icons stay local; no remote avatar service. */}
              <img src={wallet.icon} alt="" className="size-9 rounded-lg" />
              <span className="flex-1 text-left">{wallet.name}</span>
              {connecting === wallet.name ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <span className="text-xs text-muted-foreground">Detected</span>
              )}
            </Button>
          ))}
          {!wallets.length && (
            <p className="text-sm text-muted-foreground">
              Phantom was not detected. Install it below, then return here to
              connect.
            </p>
          )}
        </div>
        {install.some((item) => !wallets.some((w) => w.name === item.name)) && (
          <div className="space-y-3 border-t pt-4">
            <p className="text-xs font-medium text-muted-foreground">
              Get Phantom
            </p>
            <div className="space-y-1">
              {install
                .filter((item) => !wallets.some((w) => w.name === item.name))
                .map((item) => (
                  <a
                    key={item.name}
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-3 rounded-lg p-2 text-sm hover:bg-secondary focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    <span
                      aria-hidden
                      className={`flex size-8 items-center justify-center rounded-lg font-semibold text-white ${item.color}`}
                    >
                      {item.letter}
                    </span>
                    <span className="flex-1">{item.name}</span>
                    <ArrowUpRight
                      aria-hidden
                      className="size-4 text-muted-foreground"
                    />
                  </a>
                ))}
            </div>
          </div>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">
          Solana Devnet · Test funds only. Connecting does not request a
          signature or move funds.
        </p>
      </DialogContent>
    </Dialog>
  );
}
