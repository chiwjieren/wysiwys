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
import { useWalletConnection } from "@/lib/auth/provider";
import { useSquad } from "@/lib/squads/provider";
export function WalletButton() {
  const auth = useWalletConnection();
  const { busy } = useSquad();
  const [open, setOpen] = useState(false);
  if (!auth.connected)
    return (
      <Button
        variant="secondary"
        disabled={!auth.configured || !auth.ready || !!busy}
        onClick={auth.connect}
      >
        {!auth.configured
          ? "Wallet unavailable"
          : !auth.ready
            ? "Loading wallets…"
            : "Connect wallet"}
      </Button>
    );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" disabled={!!busy}>
          {auth.address
            ? `${auth.address.slice(0, 4)}…${auth.address.slice(-4)}`
            : "Connected wallet"}
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card">
        <DialogTitle>{auth.walletName || "Connected wallet"}</DialogTitle>
        <DialogDescription>
          Solana Devnet. Test keys only. Select the account to use for treasury
          actions.
        </DialogDescription>
        {auth.error && <p role="alert">{auth.error}</p>}
        {auth.accounts.length ? (
          <label>
            Wallet account
            <select
              className="mt-2 w-full rounded border bg-secondary p-2"
              value={auth.address}
              onChange={(e) => auth.select(e.target.value)}
            >
              {auth.accounts.map((address) => (
                <option key={address}>{address}</option>
              ))}
            </select>
          </label>
        ) : (
          <p>
            Reconnect your Solana wallet by disconnecting and connecting again.
          </p>
        )}
        <Button
          variant="secondary"
          onClick={() => {
            setOpen(false);
            auth.connect();
          }}
        >
          Change wallet
        </Button>
        <Button
          onClick={async () => {
            await auth.disconnect();
            setOpen(false);
          }}
        >
          Disconnect
        </Button>
      </DialogContent>
    </Dialog>
  );
}
