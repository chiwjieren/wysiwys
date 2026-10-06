"use client";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import type {
  StandardConnectFeature,
  StandardDisconnectFeature,
  StandardEventsFeature,
} from "@wallet-standard/features";
import type { SolanaSignTransactionFeature } from "@solana/wallet-standard-features";
import {
  Connection,
  PublicKey,
  TransactionMessage,
  type TransactionInstruction,
} from "@solana/web3.js";
import * as sqds from "@sqds/multisig";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  actionsForMember,
  buildVote,
  buildPayoutProposal,
  fromWire,
  readMultisig,
  readProposal,
  readProposalPage,
  signAndConfirm,
  validateGuardInstruction,
  type SquadConfig,
  type ProposalRecord,
  type VoteAction,
  type WireInstruction,
} from "./sdk";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
type Snapshot = {
  squad: sqds.accounts.Multisig;
  vault: PublicKey;
  sol: number;
  tokens: { address: string; mint: string; amount: string; decimals: number }[];
  records: ProposalRecord[];
  latest: bigint;
};
type ContextValue = {
  mode: "loading" | "sample" | "live" | "error";
  config?: SquadConfig;
  snapshot?: Snapshot;
  error: string;
  busy: string;
  signature: string;
  wallets: readonly Wallet[];
  wallet?: Wallet;
  account?: WalletAccount;
  connect: (wallet: Wallet) => Promise<boolean>;
  disconnect: () => Promise<void>;
  selectAccount: (address: string) => void;
  refresh: () => Promise<void>;
  older: () => void;
  newest: () => void;
  vote: (index: bigint, action: VoteAction) => Promise<void>;
  execute: (index: bigint) => Promise<void>;
  propose: (tradeId: string) => Promise<string | undefined>;
};
const Context = createContext<ContextValue | null>(null);
export function SquadProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ContextValue["mode"]>("loading");
  const [config, setConfig] = useState<SquadConfig>();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [signature, setSignature] = useState("");
  const [wallets, setWallets] = useState<readonly Wallet[]>([]);
  const [wallet, setWallet] = useState<Wallet>();
  const [account, setAccount] = useState<WalletAccount>();
  const [cursor, setCursor] = useState<bigint>();
  const connection = useRef<Connection | null>(null);
  const refreshing = useRef(false);
  const acting = useRef(false);
  const walletEpoch = useRef(0);
  const selectedWallet = useRef<Wallet | undefined>(undefined);
  useEffect(() => {
    // SDK internals use Buffer when constructing browser transactions.
    void import("buffer").then(({ Buffer }) => {
      if (!globalThis.Buffer) globalThis.Buffer = Buffer;
    });
    connection.current = new Connection(
      new URL("/api/squads/rpc", window.location.origin).toString(),
      { commitment: "finalized", disableRetryOnRateLimit: true },
    );
    const registry = getWallets();
    const update = () =>
      setWallets(
        registry
          .get()
          .filter(
            (w) =>
              w.chains.includes("solana:devnet") &&
              "standard:connect" in w.features &&
              "solana:signTransaction" in w.features,
          ),
      );
    update();
    const unregister = registry.on("unregister", (...removed) => {
      if (selectedWallet.current && removed.includes(selectedWallet.current))
        ++walletEpoch.current;
      update();
    });
    const register = registry.on("register", update);
    const abort = new AbortController();
    void fetch("/api/squads/config", {
      cache: "no-store",
      signal: abort.signal,
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            "Deployment configuration is unavailable. Live actions are disabled.",
          );
        const { config: loaded } = await response.json();
        if (!loaded) {
          setMode("sample");
          return;
        }
        setConfig(loaded);
        setMode("live");
      })
      .catch((e) => {
        if (!abort.signal.aborted) {
          setError(e.message);
          setMode("error");
        }
      });
    return () => {
      ++walletEpoch.current;
      abort.abort();
      register();
      unregister();
    };
  }, []);
  useEffect(() => {
    if (!wallet) return;
    const events = wallet.features["standard:events"] as
      StandardEventsFeature["standard:events"] | undefined;
    return events?.on("change", ({ accounts }) => {
      if (accounts) {
        ++walletEpoch.current;
        setAccount((current) =>
          accounts.find(
            (a) =>
              a.address === current?.address &&
              a.chains.includes("solana:devnet"),
          ),
        );
      }
    });
  }, [wallet]);
  useEffect(() => {
    if (wallet && !wallets.includes(wallet)) {
      ++walletEpoch.current;
      selectedWallet.current = undefined;
      setWallet(undefined);
      setAccount(undefined);
    }
  }, [wallets, wallet]);
  const refresh = useCallback(async () => {
    const rpc = connection.current;
    if (!rpc || !config || refreshing.current) return;
    refreshing.current = true;
    try {
      if ((await rpc.getGenesisHash()) !== DEVNET_GENESIS)
        throw new Error("RPC is not Solana devnet. Live actions are disabled.");
      const squad = await readMultisig(rpc, config);
      const executor = squad.members.find(
        (m) => m.key.toBase58() === config.executor,
      );
      if (
        !executor ||
        executor.permissions.mask !== sqds.types.Permission.Execute ||
        squad.members.some(
          (m) =>
            m.key.toBase58() !== config.executor &&
            sqds.types.Permissions.has(
              m.permissions,
              sqds.types.Permission.Execute,
            ),
        )
      )
        throw new Error(
          "Squad executor permissions do not enforce guarded execution.",
        );
      const [vault] = sqds.getVaultPda({
        multisigPda: new PublicKey(config.multisig),
        index: config.vaultIndex,
      });
      const latest = BigInt(squad.transactionIndex.toString());
      const [sol, tokenAccounts, records] = await Promise.all([
        rpc.getBalance(vault, "finalized"),
        rpc.getParsedTokenAccountsByOwner(
          vault,
          { programId: TOKEN_PROGRAM_ID },
          "finalized",
        ),
        readProposalPage(
          rpc,
          config,
          cursor && cursor < latest ? cursor : latest,
        ),
      ]);
      const tokens = tokenAccounts.value.map(({ pubkey, account }) => {
        const parsed = account.data.parsed.info;
        return {
          address: pubkey.toBase58(),
          mint: String(parsed.mint),
          amount: String(parsed.tokenAmount.amount),
          decimals: Number(parsed.tokenAmount.decimals),
        };
      });
      setSnapshot({
        squad,
        vault,
        sol,
        tokens,
        records: records.filter((p): p is ProposalRecord => p !== null),
        latest,
      });
      setError("");
    } catch (e) {
      setSnapshot(undefined);
      setError(e instanceof Error ? e.message : "Chain read failed.");
    } finally {
      refreshing.current = false;
    }
  }, [config, cursor]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => clearInterval(timer);
  }, [refresh]);
  async function connect(selected: Wallet) {
    const connectionEpoch = ++walletEpoch.current;
    try {
      const feature = selected.features[
        "standard:connect"
      ] as StandardConnectFeature["standard:connect"];
      const { accounts } = await feature.connect();
      const compatible = accounts.find(
        (a) =>
          a.chains.includes("solana:devnet") &&
          a.features.includes("solana:signTransaction"),
      );
      const signing = selected.features[
        "solana:signTransaction"
      ] as SolanaSignTransactionFeature["solana:signTransaction"];
      if (!compatible || !signing.supportedTransactionVersions.includes(0))
        throw new Error("Wallet must support devnet and version 0 signing.");
      if (connectionEpoch !== walletEpoch.current)
        throw new Error("Wallet account changed. Reconnect and retry.");
      selectedWallet.current = selected;
      setWallet(selected);
      setAccount(compatible);
      setError("");
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Wallet connection failed.");
      return false;
    }
  }
  async function disconnect() {
    ++walletEpoch.current;
    selectedWallet.current = undefined;
    try {
      await (
        wallet?.features["standard:disconnect"] as
          StandardDisconnectFeature["standard:disconnect"] | undefined
      )?.disconnect();
    } catch {
      setError(
        "Wallet disconnect failed. The app connection has been cleared.",
      );
    } finally {
      setWallet(undefined);
      setAccount(undefined);
    }
  }
  async function run(
    label: string,
    build: (
      rpc: Connection,
      key: PublicKey,
    ) => Promise<TransactionInstruction[]>,
  ) {
    if (acting.current || !wallet || !account || !config || !snapshot || error)
      return;
    const actionEpoch = walletEpoch.current;
    acting.current = true;
    setBusy(label);
    setSignature("");
    setError("");
    let succeeded = false;
    try {
      const rpc = connection.current!;
      if ((await rpc.getGenesisHash()) !== DEVNET_GENESIS)
        throw new Error("RPC is not devnet.");
      const key = new PublicKey(account.publicKey);
      const instructions = await build(rpc, key);
      await signAndConfirm(
        rpc,
        key,
        instructions,
        async (transaction) => {
          if (
            actionEpoch !== walletEpoch.current ||
            !wallet.accounts.some((a) => a.address === account.address)
          )
            throw new Error("Wallet account changed. Reconnect and retry.");
          const feature = wallet.features[
            "solana:signTransaction"
          ] as SolanaSignTransactionFeature["solana:signTransaction"];
          const [result] = await feature.signTransaction({
            account,
            transaction,
            chain: "solana:devnet",
          });
          if (actionEpoch !== walletEpoch.current)
            throw new Error("Wallet account changed. Reconnect and retry.");
          if (!result) throw new Error("Wallet did not sign the transaction.");
          return result.signedTransaction;
        },
        setSignature,
      );
      succeeded = true;
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transaction failed.");
    } finally {
      acting.current = false;
      setBusy("");
    }
    return succeeded;
  }
  async function prepare(
    action: "propose" | "execute",
    index: bigint,
    member: PublicKey,
    tradeId?: string,
  ): Promise<{
    guardInstruction: WireInstruction;
    payoutInstructions?: WireInstruction[];
  }> {
    const response = await fetch("/api/squads/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        index: index.toString(),
        member: member.toBase58(),
        tradeId,
      }),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error || "Settlement service unavailable.");
    return result;
  }
  async function vote(index: bigint, action: VoteAction) {
    await run(action, async (rpc, key) => {
      const squad = await readMultisig(rpc, config!);
      const record = await readProposal(rpc, config!, index);
      if (!record || !actionsForMember(squad, record.proposal, key)[action])
        throw new Error(
          "Your wallet cannot perform this action on the current proposal.",
        );
      return [buildVote(action, new PublicKey(config!.multisig), index, key)];
    });
  }
  async function execute(index: bigint) {
    await run("execute", async (rpc, key) => {
      if (!config!.settlementEnabled)
        throw new Error("Guard settlement adapter is unavailable.");
      const record = await readProposal(rpc, config!, index);
      if (
        !record ||
        record.proposal.status.__kind !== "Approved" ||
        record.transaction.message.addressTableLookups.length
      )
        throw new Error("Proposal is not executable.");
      const prepared = await prepare("execute", index, key);
      return [
        validateGuardInstruction(
          fromWire(prepared.guardInstruction),
          new PublicKey(config!.guardProgram),
          new PublicKey(config!.multisig),
          index,
          key,
        ),
      ];
    });
  }
  async function propose(tradeId: string) {
    let id: string | undefined;
    const succeeded = await run("propose", async (rpc, key) => {
      const squad = await readMultisig(rpc, config!);
      const member = squad.members.find((m) => m.key.equals(key));
      if (
        !member ||
        !sqds.types.Permissions.has(
          member.permissions,
          sqds.types.Permission.Initiate,
        )
      )
        throw new Error("Your wallet cannot propose payouts.");
      const index = BigInt(squad.transactionIndex.toString()) + 1n;
      const prepared = await prepare("propose", index, key, tradeId);
      if (!prepared.payoutInstructions?.length)
        throw new Error("Approved ticket payout is unavailable.");
      const { blockhash } = await rpc.getLatestBlockhash("finalized");
      const [vault] = sqds.getVaultPda({
        multisigPda: new PublicKey(config!.multisig),
        index: config!.vaultIndex,
      });
      const message = new TransactionMessage({
        payerKey: vault,
        recentBlockhash: blockhash,
        instructions: prepared.payoutInstructions.map(fromWire),
      });
      id = index.toString();
      return buildPayoutProposal({
        multisig: new PublicKey(config!.multisig),
        member: key,
        index,
        vaultIndex: config!.vaultIndex,
        message,
        guard: new PublicKey(config!.guardProgram),
        requestReview: fromWire(prepared.guardInstruction),
      });
    });
    if (succeeded) {
      setCursor(undefined);
      return id;
    }
  }
  return (
    <Context.Provider
      value={{
        mode,
        config,
        snapshot,
        error,
        busy,
        signature,
        wallets,
        wallet,
        account,
        connect,
        disconnect,
        selectAccount: (address) => {
          ++walletEpoch.current;
          setAccount(
            wallet?.accounts.find(
              (a) =>
                a.address === address &&
                a.chains.includes("solana:devnet") &&
                a.features.includes("solana:signTransaction"),
            ),
          );
        },
        refresh,
        older: () =>
          setCursor((current) => {
            const latest = current ?? snapshot?.latest ?? 0n;
            return latest > 20n ? latest - 20n : 1n;
          }),
        newest: () => setCursor(undefined),
        vote,
        execute,
        propose,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useSquad() {
  const context = useContext(Context);
  if (!context) throw new Error("SquadProvider is required.");
  return context;
}
