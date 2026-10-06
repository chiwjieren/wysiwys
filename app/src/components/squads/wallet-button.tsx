"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useSquad } from "@/lib/squads/provider";
export function WalletButton() {
  const {
    wallets,
    wallet,
    account,
    connect,
    disconnect,
    selectAccount,
    busy,
    error,
  } = useSquad();
  const [open, setOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" disabled={!!busy}>
          {account
            ? `${wallet?.name} · ${account.address.slice(0, 4)}…${account.address.slice(-4)}`
            : "Connect wallet"}
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card">
        <DialogTitle>
          {account ? "Connected wallet" : "Connect wallet"}
        </DialogTitle>
        <DialogDescription>
          Solana Devnet. Test keys only. Your wallet signs transactions.
        </DialogDescription>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {account ? (
          <>
            <p className="break-all text-xs">{account.address}</p>
            <label className="caption">
              Wallet account
              <select
                aria-label="Wallet account"
                className="mt-2 w-full rounded border bg-secondary p-2"
                value={account.address}
                onChange={(e) => selectAccount(e.target.value)}
              >
                {wallet?.accounts
                  .filter(
                    (a) =>
                      a.chains.includes("solana:devnet") &&
                      a.features.includes("solana:signTransaction"),
                  )
                  .map((a) => (
                    <option key={a.address} value={a.address}>
                      {a.address}
                    </option>
                  ))}
              </select>
            </label>
            <Button
              onClick={async () => {
                await disconnect();
                setOpen(false);
              }}
            >
              Disconnect wallet
            </Button>
          </>
        ) : wallets.length ? (
          wallets.map((w) => (
            <Button
              key={w.name}
              disabled={connecting}
              onClick={async () => {
                setConnecting(true);
                const connected = await connect(w);
                setConnecting(false);
                if (connected) setOpen(false);
              }}
            >
              {w.name}
            </Button>
          ))
        ) : (
          <p>
            No compatible wallet detected. Open this app in a browser with a
            Solana Wallet Standard extension.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
