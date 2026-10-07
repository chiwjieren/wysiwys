"use client";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import type {
  StandardConnectFeature,
  StandardDisconnectFeature,
  StandardEventsFeature,
} from "@wallet-standard/features";
import type {
  SolanaSignTransactionFeature,
  SolanaSignMessageFeature,
} from "@solana/wallet-standard-features";
import { PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import { assertWalletConnected } from "./wallet-state";
import { requestMessage } from "./request-proof";
import { accountChange, isPhantom, restoreSession } from "./wallet-session";
import { WalletPicker } from "@/components/squads/wallet-picker";

type SolanaWallet = Wallet & {
  features: StandardConnectFeature &
    StandardEventsFeature &
    SolanaSignTransactionFeature;
};
function isSolanaWallet(wallet: Wallet): wallet is SolanaWallet {
  const connect = wallet.features["standard:connect"] as
    Partial<StandardConnectFeature["standard:connect"]> | undefined;
  const events = wallet.features["standard:events"] as
    Partial<StandardEventsFeature["standard:events"]> | undefined;
  const sign = wallet.features["solana:signTransaction"] as
    Partial<SolanaSignTransactionFeature["solana:signTransaction"]> | undefined;
  return (
    wallet.chains.includes("solana:devnet") &&
    typeof connect?.connect === "function" &&
    typeof events?.on === "function" &&
    typeof sign?.signTransaction === "function" &&
    Array.isArray(sign.supportedTransactionVersions) &&
    sign.supportedTransactionVersions.includes(0)
  );
}

function solanaAccounts(wallet: Wallet): WalletAccount[] {
  return wallet.accounts.filter((account) => {
    try {
      return (
        account.chains.includes("solana:devnet") &&
        account.features.includes("solana:signTransaction") &&
        new PublicKey(account.publicKey).toBase58() === account.address
      );
    } catch {
      return false;
    }
  });
}
function savedWallet(name?: string) {
  // Wallet access still works when the browser blocks persistent storage.
  try {
    if (name === undefined) return localStorage.getItem("wysiwys.wallet");
    if (name) localStorage.setItem("wysiwys.wallet", name);
    else localStorage.removeItem("wysiwys.wallet");
  } catch {
    return null;
  }
}
type ConnectionState = {
  wallet?: SolanaWallet;
  address?: string;
  epoch: number;
};
type WalletConnection = {
  configured: boolean;
  ready: boolean;
  connected: boolean;
  session: string;
  accounts: string[];
  address?: string;
  walletName?: string;
  error: string;
  connect: () => void;
  disconnect: () => Promise<void>;
  select: (address: string) => void;
  assertConnected: (address?: string) => void;
  authorizeRequest: (
    path: string,
    body: string,
  ) => Promise<Record<string, string>>;
  sign: (bytes: Uint8Array, address: string) => Promise<Uint8Array>;
};
const unavailable = () => {
  throw new Error("Connect your Solana wallet to continue.");
};
const Context = createContext<WalletConnection>({
  configured: true,
  ready: false,
  connected: false,
  session: "",
  accounts: [],
  error: "",
  connect: () => {},
  disconnect: async () => {},
  select: () => {},
  assertConnected: unavailable,
  authorizeRequest: async () => unavailable(),
  sign: async () => unavailable(),
});
export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<SolanaWallet[]>([]);
  const [state, setState] = useState<ConnectionState>({ epoch: 0 });
  const active = useRef(state);
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const [connecting, setConnecting] = useState("");
  const [error, setError] = useState("");
  const attempt = useRef(0);
  const restoring = useRef(false);
  const unsubscribe = useRef<() => void>(() => {});
  const addresses = (wallet: SolanaWallet) =>
    solanaAccounts(wallet).map((a) => a.address);
  // Reconnect an account the user already authorized for this site, without a prompt. A manual
  // connect or disconnect started meanwhile wins.
  async function restore(wallet: SolanaWallet) {
    if (restoring.current) return;
    restoring.current = true;
    const id = attempt.current;
    try {
      const address = await restoreSession(wallet, addresses);
      if (id !== attempt.current || active.current.address) return;
      if (address) {
        if (active.current.wallet !== wallet) attach(wallet);
        update(wallet, address);
        setError("");
      }
    } finally {
      restoring.current = false;
    }
  }
  function update(wallet?: SolanaWallet, address?: string) {
    const next = { wallet, address, epoch: active.current.epoch + 1 };
    active.current = next;
    setState(next);
  }
  function attach(wallet: SolanaWallet) {
    unsubscribe.current();
    unsubscribe.current = wallet.features["standard:events"].on(
      "change",
      () => {
        if (active.current.wallet !== wallet) return;
        const change = accountChange(addresses(wallet), active.current.address);
        // Phantom also emits "change" for non-account updates; those keep the session.
        if (change.kind === "same") return;
        if (change.kind === "switched") {
          update(wallet, change.address);
          setError("");
          return;
        }
        // Switching Phantom to an account not connected to this site drops access. Try a silent
        // reconnect; keep Phantom remembered so the next reload restores it.
        update(wallet);
        void restore(wallet).then(() => {
          if (!active.current.address)
            setError(
              "Phantom switched to an account that is not connected to this site. Connect again to continue.",
            );
        });
      },
    );
  }
  useEffect(() => {
    const registry = getWallets();
    // Phantom may register after this page mounts; restore it whenever it appears.
    const resume = () => {
      if (active.current.address || savedWallet() !== "Phantom") return;
      const wallet = registry
        .get()
        .filter(isSolanaWallet)
        .find((w) => isPhantom(w));
      if (!wallet) return;
      const ready = addresses(wallet);
      if (ready.length) {
        attach(wallet);
        update(wallet, ready[0]);
      } else void restore(wallet);
    };
    const discover = () => {
      const installed = registry
        .get()
        .filter((w): w is SolanaWallet => isSolanaWallet(w) && isPhantom(w));
      // Some extensions register more than once; present one entry per wallet name.
      setWallets(
        installed.filter(
          (w, i) => installed.findIndex((other) => other.name === w.name) === i,
        ),
      );
      if (active.current.wallet && !installed.includes(active.current.wallet)) {
        unsubscribe.current();
        update();
      }
    };
    discover();
    setReady(true);
    const offRegister = registry.on("register", () => {
      discover();
      resume();
    });
    const offUnregister = registry.on("unregister", discover);
    // Restore an already-authorized Phantom only. Never prompt or sign automatically.
    resume();
    return () => {
      ++attempt.current;
      offRegister();
      offUnregister();
      unsubscribe.current();
      active.current = { epoch: active.current.epoch + 1 };
    };
  }, []);
  async function choose(wallet: Wallet) {
    if (!isSolanaWallet(wallet) || !isPhantom(wallet)) return;
    const id = ++attempt.current;
    setConnecting(wallet.name);
    setError("");
    try {
      await wallet.features["standard:connect"].connect();
      if (id !== attempt.current) return;
      const account = solanaAccounts(wallet)[0];
      if (!account)
        throw new Error(
          "This wallet did not provide a Solana account. Unlock it and retry.",
        );
      update(wallet, account.address);
      attach(wallet);
      savedWallet(wallet.name);
      setOpen(false);
    } catch (e) {
      if (id === attempt.current)
        setError(
          e instanceof Error
            ? e.message
            : "Could not connect. Unlock your wallet and retry.",
        );
    } finally {
      if (id === attempt.current) setConnecting("");
    }
  }
  function check(address = active.current.address) {
    const current = active.current;
    if (!address || !current.wallet || current.address !== address)
      unavailable();
    assertWalletConnected(current.wallet!, address!);
    const account = solanaAccounts(current.wallet!).find(
      (a) => a.address === address,
    );
    if (!account) unavailable();
    return { wallet: current.wallet!, account: account!, epoch: current.epoch };
  }
  function unchanged(epoch: number, address: string) {
    if (active.current.epoch !== epoch)
      throw new Error("Wallet session changed. Reconnect and retry.");
    check(address);
  }
  return (
    <Context.Provider
      value={{
        configured: true,
        ready,
        connected: !!state.address,
        session: String(state.epoch),
        accounts: state.wallet
          ? solanaAccounts(state.wallet).map((a) => a.address)
          : [],
        address: state.address,
        walletName: state.wallet?.name,
        error,
        connect: () => {
          setError("");
          setOpen(true);
        },
        disconnect: async () => {
          const wallet = active.current.wallet;
          ++attempt.current;
          unsubscribe.current();
          update();
          setConnecting("");
          setError("");
          savedWallet("");
          try {
            await (
              wallet?.features["standard:disconnect"] as
                StandardDisconnectFeature["standard:disconnect"] | undefined
            )?.disconnect();
          } catch {
            setError(
              "Disconnected from wysiwys. You can also disconnect this site in your wallet.",
            );
          }
        },
        select: (address) => {
          if (
            state.wallet &&
            solanaAccounts(state.wallet).some((a) => a.address === address)
          )
            update(state.wallet, address);
        },
        assertConnected: (address) => {
          check(address);
        },
        sign: async (transaction, address) => {
          const { wallet, account, epoch } = check(address);
          const [result] = await wallet.features[
            "solana:signTransaction"
          ].signTransaction({ account, transaction, chain: "solana:devnet" });
          unchanged(epoch, address);
          if (!result) throw new Error("Wallet did not sign the transaction.");
          return result.signedTransaction;
        },
        authorizeRequest: async (path, body) => {
          const { wallet, account, epoch } = check();
          const feature = wallet.features["solana:signMessage"] as
            SolanaSignMessageFeature["solana:signMessage"] | undefined;
          if (!feature)
            throw new Error(
              "This wallet cannot authorize Guard requests. Use a wallet with message signing.",
            );
          const issuedAt = Date.now(),
            nonce = crypto.randomUUID();
          const message = await requestMessage({
            origin: location.origin,
            path,
            address: account.address,
            issuedAt,
            nonce,
            body,
          });
          const [result] = await feature.signMessage({ account, message });
          unchanged(epoch, account.address);
          if (
            !result ||
            Buffer.compare(
              Buffer.from(message),
              Buffer.from(result.signedMessage),
            ) !== 0
          )
            throw new Error("Wallet changed the authorization message.");
          return {
            "x-wallet-address": account.address,
            "x-wallet-issued-at": String(issuedAt),
            "x-wallet-nonce": nonce,
            "x-wallet-signature": Buffer.from(result.signature).toString(
              "base64",
            ),
          };
        },
      }}
    >
      {children}
      <WalletPicker
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) {
            ++attempt.current;
            setConnecting("");
          }
        }}
        wallets={wallets}
        connecting={connecting}
        error={error}
        onSelect={choose}
      />
    </Context.Provider>
  );
}
export function useWalletConnection() {
  return useContext(Context);
}
