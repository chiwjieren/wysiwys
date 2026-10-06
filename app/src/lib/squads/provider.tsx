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
import { useSearchParams } from "next/navigation";
import {
  buildGroupCreation,
  buildMemberInvitation,
  fixedMembershipReason,
  validateInitializeGuard,
} from "./groups";
import { useWalletConnection } from "@/lib/auth/provider";
import { walletRpcFetch } from "@/lib/auth/rpc-fetch";
import {
  buildThresholdChange,
  buildVaultDeposit,
  parseAmount,
} from "./governance";
import {
  Connection,
  Keypair,
  type Signer,
  PublicKey,
  TransactionMessage,
  type TransactionInstruction,
} from "@solana/web3.js";
import * as sqds from "@sqds/multisig";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  actionsForMember,
  buildGuardedExecute,
  buildPayoutProposal,
  buildVote,
  fromWire,
  readMultisig,
  readProposal,
  readProposalPage,
  signAndConfirm,
  type SquadConfig,
  type ProposalRecord,
  type VoteAction,
  type WireInstruction,
} from "./sdk";

import { assertStandardExecution } from "./execution";
import { isGuarded, readReviews, type Review } from "./review";
import { assertDevnet } from "./network";
import {
  buildGuardedPaymentInstruction,
  buildPaymentInstructions,
  buildPaymentProposal,
  readPaymentPreview,
  assertReviewedPreview,
  type PaymentInput,
} from "./payments";
type Snapshot = {
  squad: sqds.accounts.Multisig;
  vault: PublicKey;
  sol: number;
  tokens: { address: string; mint: string; amount: string; decimals: number }[];
  records: ProposalRecord[];
  latest: bigint;
  // Guarded groups only: on-chain Review per proposal index (null = none).
  // Undefined when the group is standard or the review read failed.
  reviews?: Record<string, Review | null>;
};
type ContextValue = {
  mode: "loading" | "unconfigured" | "live" | "error";
  config?: SquadConfig;
  groupName: string;
  groups: { address: string; name: string }[];
  createGroup: (
    name: string,
    members: string[],
    threshold: number,
    kind?: "guarded" | "standard",
  ) => Promise<string | undefined>;
  openGroup: (address: string) => void;
  invite: (address: string) => Promise<string | undefined>;
  snapshot?: Snapshot;
  error: string;
  busy: string;
  signature: string;
  account?: { address: string; publicKey: Uint8Array };
  funding?: { sol: number; tokens: Snapshot["tokens"] };
  deposit: (amount: string, tokenAddress?: string) => Promise<void>;
  setThreshold: (threshold: number) => Promise<string | undefined>;
  refresh: () => Promise<void>;
  older: () => void;
  newest: () => void;
  vote: (
    index: bigint,
    action: VoteAction,
    reviewed?: readonly string[],
  ) => Promise<void>;
  execute: (index: bigint, reviewed?: readonly string[]) => Promise<void>;
  proposePayment: (input: PaymentInput) => Promise<string | undefined>;
};
const Context = createContext<ContextValue | null>(null);
export function SquadProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ContextValue["mode"]>("loading");
  const [config, setConfig] = useState<SquadConfig>();
  const [groupName, setGroupName] = useState("Your group");
  const [groups, setGroups] = useState<{ address: string; name: string }[]>([]);
  const deployment = useRef<SquadConfig | undefined>(undefined);
  const groupConfigs = useRef<Record<string, SquadConfig>>({});
  const openEpoch = useRef(0);
  const searchParams = useSearchParams();
  const urlGroup = searchParams.get("group");
  const activeConfig = useRef(config);
  activeConfig.current = config;
  const refreshEpoch = useRef(0);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [signature, setSignature] = useState("");
  const auth = useWalletConnection();
  const account =
    auth.ready && auth.connected && auth.address
      ? {
          address: auth.address,
          publicKey: new PublicKey(auth.address).toBytes(),
        }
      : undefined;
  const [funding, setFunding] = useState<ContextValue["funding"]>();
  const authRef = useRef(auth);
  authRef.current = auth;
  const [cursor, setCursor] = useState<bigint>();
  const connection = useRef<Connection | null>(null);

  const acting = useRef(false);
  const walletEpoch = useRef(0);
  const identity = `${auth.connected}:${auth.session}:${auth.address}:${auth.accounts.join(",")}`;
  const previousIdentity = useRef(identity);
  if (previousIdentity.current !== identity) {
    ++walletEpoch.current;
    previousIdentity.current = identity;
  }

  useEffect(() => {
    // SDK internals use Buffer when constructing browser transactions.
    void import("buffer").then(({ Buffer }) => {
      if (!globalThis.Buffer) globalThis.Buffer = Buffer;
    });
    connection.current = new Connection(
      new URL("/api/squads/rpc", window.location.origin).toString(),
      {
        commitment: "finalized",
        disableRetryOnRateLimit: true,
        fetch: walletRpcFetch(() => ({
          ...authRef.current,
          epoch: walletEpoch.current,
        })),
      },
    );
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
        deployment.current = loaded || undefined;
        let saved: { address: string; name: string }[] = [];
        try {
          const stored = JSON.parse(
            localStorage.getItem("wysiwys.groups") || "[]",
          );
          if (Array.isArray(stored))
            saved = stored.filter(
              (g) =>
                g &&
                typeof g.name === "string" &&
                typeof g.address === "string",
            );
        } catch {
          /* Public local labels are optional. */
        }
        setGroups(saved);
        const requested =
          new URL(window.location.href).searchParams.get("group") ||
          localStorage.getItem("wysiwys.activeGroup");
        if (requested) {
          const address = new PublicKey(requested).toBase58();
          const groupResponse =
            loaded?.multisig === address
              ? null
              : await fetch(`/api/squads/groups?multisig=${address}`, {
                  cache: "no-store",
                  signal: abort.signal,
                });
          if (groupResponse && !groupResponse.ok)
            throw new Error(
              "This group could not be opened. Check the invite link or try again later.",
            );
          const groupConfig = groupResponse
            ? (await groupResponse.json()).config
            : loaded;
          groupConfigs.current[address] = groupConfig;
          setConfig(groupConfig);
          setGroupName(
            saved.find((g) => g.address === address)?.name || "Shared group",
          );
          setMode("live");
        } else if (loaded) {
          setConfig(loaded);
          setGroupName("Treasury");
          setMode("live");
        } else setMode("unconfigured");
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
    };
  }, []);
  const refresh = useCallback(async () => {
    const rpc = connection.current;
    if (!rpc || !config) return;
    const epoch = ++refreshEpoch.current;
    try {
      await assertDevnet(rpc);
      const squad = await readMultisig(rpc, config);
      const executor = squad.members.find(
        (m) => m.key.toBase58() === config.executor,
      );
      if (config.executor) {
        if (
          !executor ||
          PublicKey.isOnCurve(executor.key.toBytes()) ||
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
          throw new Error("Group permissions do not enforce guarded payouts.");
      } else if (
        config.executionMode !== "standard" &&
        squad.members.some((m) =>
          sqds.types.Permissions.has(
            m.permissions,
            sqds.types.Permission.Execute,
          ),
        )
      ) {
        throw new Error(
          "This group has an unguarded executor. Open a group created with guarded payout permissions.",
        );
      }
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
      const visible = records.filter((p): p is ProposalRecord => p !== null);
      let reviews: Record<string, Review | null> | undefined;
      if (isGuarded(config))
        try {
          reviews = await readReviews(
            rpc,
            new PublicKey(config.guardProgram!),
            new PublicKey(config.multisig),
            visible
              .filter((r) => r.kind === "vault" || r.kind === "archived")
              .map((r) => BigInt(r.proposal.transactionIndex.toString())),
          );
        } catch {
          reviews = undefined;
        }
      const tokens = tokenAccounts.value.map(({ pubkey, account }) => {
        const parsed = account.data.parsed.info;
        return {
          address: pubkey.toBase58(),
          mint: String(parsed.mint),
          amount: String(parsed.tokenAmount.amount),
          decimals: Number(parsed.tokenAmount.decimals),
        };
      });
      if (
        epoch !== refreshEpoch.current ||
        activeConfig.current?.multisig !== config.multisig
      )
        return;
      setSnapshot({
        squad,
        vault,
        sol,
        tokens,
        records: visible,
        latest,
        reviews,
      });
      setError("");
    } catch (e) {
      if (
        epoch !== refreshEpoch.current ||
        activeConfig.current?.multisig !== config.multisig
      )
        return;
      setSnapshot(undefined);
      setError(e instanceof Error ? e.message : "Chain read failed.");
    }
  }, [config, cursor]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => clearInterval(timer);
  }, [refresh]);
  async function run(
    label: string,
    build: (
      rpc: Connection,
      key: PublicKey,
    ) => Promise<TransactionInstruction[]>,
    options: { withoutGroup?: boolean; additionalSigners?: Signer[] } = {},
  ) {
    if (
      acting.current ||
      !auth.connected ||
      !auth.ready ||
      !account ||
      (!options.withoutGroup && (!config || !snapshot || !!error))
    )
      return;
    const actionEpoch = walletEpoch.current;
    acting.current = true;
    setBusy(label);
    setSignature("");
    setError("");
    let succeeded = false;
    try {
      const rpc = connection.current!;
      await assertDevnet(rpc);
      const key = new PublicKey(account.publicKey);
      const instructions = await build(rpc, key);
      await signAndConfirm(
        rpc,
        key,
        instructions,
        async (transaction) => {
          if (actionEpoch !== walletEpoch.current)
            throw new Error("Wallet session changed. Connect and retry.");
          authRef.current.assertConnected();
          if (
            actionEpoch !== walletEpoch.current ||
            !authRef.current.connected ||
            authRef.current.address !== account.address
          )
            throw new Error("Wallet session changed. Connect and retry.");
          const signed = await auth.sign(transaction, account.address);
          if (
            actionEpoch !== walletEpoch.current ||
            !authRef.current.connected ||
            authRef.current.address !== account.address
          )
            throw new Error("Wallet session changed. Connect and retry.");
          return signed;
        },
        setSignature,
        options.additionalSigners,
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
  ): Promise<{ guardInstruction: WireInstruction }> {
    const body = JSON.stringify({
      multisig: config!.multisig,
      action,
      index: index.toString(),
      member: member.toBase58(),
    });
    const response = await fetch("/api/squads/prepare", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await auth.authorizeRequest("/api/squads/prepare", body)),
      },
      body,
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error || "Settlement service unavailable.");
    return result;
  }
  async function vote(
    index: bigint,
    action: VoteAction,
    reviewed?: readonly string[],
  ) {
    await run(action, async (rpc, key) => {
      const squad = await readMultisig(rpc, config!);
      const record = await readProposal(rpc, config!, index);
      if (!record || !actionsForMember(squad, record.proposal, key)[action])
        throw new Error(
          "Your wallet cannot perform this action on the current proposal.",
        );
      if (action === "approve" && record.kind === "batch")
        throw new Error(
          "Batch approval is unavailable until every payment can be decoded.",
        );
      if (action === "approve" && record.kind === "vault") {
        const vault = sqds.getVaultPda({
          multisigPda: new PublicKey(config!.multisig),
          index: config!.vaultIndex,
        })[0];
        const preview = await readPaymentPreview(
          rpc,
          record.transaction.message,
          vault,
        );
        assertReviewedPreview(reviewed, preview);
      }
      return [buildVote(action, new PublicKey(config!.multisig), index, key)];
    });
  }
  async function execute(index: bigint, reviewed?: readonly string[]) {
    await run("execute", async (rpc, key) => {
      if (config!.executionMode === "standard") {
        const squad = await readMultisig(rpc, config!);
        const record = await readProposal(rpc, config!, index);
        if (!record) throw new Error("Proposal not found.");
        assertStandardExecution(
          config!,
          squad,
          record.proposal,
          key,
          undefined,
          record.kind === "archived" ? "vault" : record.kind,
        );
        const multisig = new PublicKey(config!.multisig);
        if (record.kind === "config") {
          if (
            !record.transaction.actions.length ||
            record.transaction.actions.some(
              (a) => a.__kind !== "ChangeThreshold" && a.__kind !== "AddMember",
            )
          )
            throw new Error("This settings change cannot be fully decoded.");
          return [
            sqds.instructions.configTransactionExecute({
              multisigPda: multisig,
              transactionIndex: index,
              member: key,
              rentPayer: key,
            }),
          ];
        }
        if (
          record.kind !== "vault" ||
          record.transaction.vaultIndex !== config!.vaultIndex
        )
          throw new Error(
            "This transaction type cannot be executed from this vault.",
          );
        const vault = sqds.getVaultPda({
          multisigPda: multisig,
          index: config!.vaultIndex,
        })[0];
        assertReviewedPreview(
          reviewed,
          await readPaymentPreview(rpc, record.transaction.message, vault),
        );
        const { instruction, lookupTableAccounts } =
          await sqds.instructions.vaultTransactionExecute({
            connection: rpc,
            multisigPda: multisig,
            transactionIndex: index,
            member: key,
          });
        if (lookupTableAccounts.length)
          throw new Error("Lookup table payments are not yet supported.");
        return [instruction];
      }
      if (!config!.settlementEnabled)
        throw new Error("Guard settlement adapter is unavailable.");
      const record = await readProposal(rpc, config!, index);
      if (
        !record ||
        record.kind !== "vault" ||
        record.proposal.status.__kind !== "Approved" ||
        record.transaction.message.addressTableLookups.length
      )
        throw new Error("Proposal is not executable.");
      const prepared = await prepare("execute", index, key);
      return buildGuardedExecute(
        fromWire(prepared.guardInstruction),
        new PublicKey(config!.guardProgram!),
        new PublicKey(config!.multisig),
        index,
        key,
      );
    });
  }
  async function proposePayment(input: PaymentInput) {
    let id: string | undefined;
    const success = await run("propose payment", async (rpc, key) => {
      const squad = await readMultisig(rpc, config!);
      const member = squad.members.find((m) => m.key.equals(key));
      if (!member || !(member.permissions.mask & 1))
        throw new Error("Your wallet cannot propose payments.");
      const multisig = new PublicKey(config!.multisig),
        vault = sqds.getVaultPda({
          multisigPda: multisig,
          index: config!.vaultIndex,
        })[0];
      // Re-read balances and token ownership before preparing the wallet signature.
      if (input.token) {
        const owned = await rpc.getParsedTokenAccountsByOwner(
          vault,
          { programId: TOKEN_PROGRAM_ID },
          "finalized",
        );
        const source = owned.value.find(
          (t) => t.pubkey.toBase58() === input.token!.source,
        )?.account.data.parsed.info;
        if (
          !source ||
          source.owner !== vault.toBase58() ||
          source.mint !== input.token.mint ||
          source.tokenAmount.decimals !== input.token.decimals
        )
          throw new Error(
            "Treasury token account changed. Refresh and try again.",
          );
        if (
          parseAmount(input.amount, input.token.decimals) >
          BigInt(source.tokenAmount.amount)
        )
          throw new Error("Insufficient treasury token balance.");
      } else if (
        parseAmount(input.amount, 9) >=
        BigInt(await rpc.getBalance(vault, "finalized"))
      )
        throw new Error("Keep SOL in the vault for account rent and payments.");
      const index = BigInt(squad.transactionIndex.toString()) + 1n;
      if (config!.executor) {
        if (!config!.settlementEnabled || !config!.guardProgram)
          throw new Error("Guard settlement adapter is unavailable.");
        // The guard policy approves exactly one payment instruction.
        const payment = await buildGuardedPaymentInstruction(rpc, {
          ...input,
          vault,
        });
        const message = new TransactionMessage({
          payerKey: vault,
          recentBlockhash: (await rpc.getLatestBlockhash("finalized"))
            .blockhash,
          instructions: [payment],
        });
        const prepared = await prepare("propose", index, key);
        id = index.toString();
        // vaultTransactionCreate + proposalCreate + request_review in one transaction.
        return buildPayoutProposal({
          multisig,
          member: key,
          index,
          vaultIndex: config!.vaultIndex,
          message,
          guard: new PublicKey(config!.guardProgram),
          requestReview: fromWire(prepared.guardInstruction),
        });
      }
      const message = new TransactionMessage({
        payerKey: vault,
        recentBlockhash: (await rpc.getLatestBlockhash("finalized")).blockhash,
        instructions: buildPaymentInstructions({ ...input, vault }),
      });
      id = index.toString();
      // Proposal creation never transfers funds. Guard review/execution remains a separate backend gate.
      return buildPaymentProposal({
        multisig,
        member: key,
        index,
        vaultIndex: config!.vaultIndex,
        message,
        memo: input.memo,
      });
    });
    if (success) {
      setCursor(undefined);
      return id;
    }
  }
  useEffect(() => {
    let cancelled = false;
    if (!account) {
      setFunding(undefined);
      return;
    }
    const load = async () => {
      try {
        const rpc = connection.current!;
        const owner = new PublicKey(account.address);
        const [sol, tokens] = await Promise.all([
          rpc.getBalance(owner, "finalized"),
          rpc.getParsedTokenAccountsByOwner(
            owner,
            { programId: TOKEN_PROGRAM_ID },
            "finalized",
          ),
        ]);
        if (!cancelled)
          setFunding({
            sol,
            tokens: tokens.value.map(({ pubkey, account: info }) => ({
              address: pubkey.toBase58(),
              mint: info.data.parsed.info.mint,
              amount: info.data.parsed.info.tokenAmount.amount,
              decimals: info.data.parsed.info.tokenAmount.decimals,
            })),
          });
      } catch {
        if (!cancelled) setFunding(undefined);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [account?.address, snapshot]);
  async function deposit(value: string, tokenAddress?: string) {
    await run("deposit", async (rpc, key) => {
      // Any connected wallet may fund the vault; deposits need no membership.
      if (key.toBase58() === config!.executor)
        throw new Error("Connect with a funded wallet.");
      const vault = sqds.getVaultPda({
        multisigPda: new PublicKey(config!.multisig),
        index: config!.vaultIndex,
      })[0];
      if (!tokenAddress) {
        const amount = parseAmount(value, 9);
        if (amount >= BigInt(await rpc.getBalance(key, "finalized")))
          throw new Error("Keep some SOL in your wallet for transaction fees.");
        return buildVaultDeposit({ member: key, vault, amount });
      }
      const owned = await rpc.getParsedTokenAccountsByOwner(
        key,
        { programId: TOKEN_PROGRAM_ID },
        "finalized",
      );
      const token = owned.value.find(
        (t) => t.pubkey.toBase58() === tokenAddress,
      );
      if (!token || token.account.data.parsed.info.owner !== key.toBase58())
        throw new Error("Token account is not owned by your wallet.");
      const info = token.account.data.parsed.info;
      const amount = parseAmount(value, info.tokenAmount.decimals);
      if (amount > BigInt(info.tokenAmount.amount))
        throw new Error("Insufficient token balance.");
      return buildVaultDeposit({
        member: key,
        vault,
        amount,
        token: {
          mint: new PublicKey(info.mint),
          source: token.pubkey,
          decimals: info.tokenAmount.decimals,
        },
      });
    });
  }
  async function setThreshold(threshold: number) {
    let id: string | undefined;
    const success = await run("threshold", async (rpc, key) => {
      if (fixedMembershipReason(config))
        throw new Error(
          "The threshold of a guarded treasury is fixed after creation.",
        );
      const squad = await readMultisig(rpc, config!);
      const instructions = buildThresholdChange({
        squad,
        multisig: new PublicKey(config!.multisig),
        member: key,
        threshold,
      });
      if (instructions.length === 2)
        id = (BigInt(squad.transactionIndex.toString()) + 1n).toString();
      return instructions;
    });
    if (success) {
      setCursor(undefined);
      return id;
    }
  }
  function remember(address: string, name: string) {
    setGroups((current) => {
      const next = [
        ...current.filter((g) => g.address !== address),
        { address, name },
      ];
      try {
        localStorage.setItem("wysiwys.groups", JSON.stringify(next));
      } catch {
        /* Chain state is authoritative. */
      }
      return next;
    });
  }
  async function openGroup(address: string, name?: string) {
    if (acting.current) return;
    const epoch = ++openEpoch.current;
    try {
      const key = new PublicKey(address).toBase58();
      ++refreshEpoch.current;
      setSnapshot(undefined);
      setError("");
      setSignature("");
      setCursor(undefined);
      let selected =
        deployment.current?.multisig === key
          ? deployment.current
          : groupConfigs.current[key];
      if (!selected) {
        const response = await fetch(`/api/squads/groups?multisig=${key}`, {
          cache: "no-store",
        });
        const result = await response.json();
        if (!response.ok)
          throw new Error(
            result.error || "This group could not be opened. Try again.",
          );
        selected = result.config;
        if (!selected || selected.multisig !== key)
          throw new Error("This group could not be opened.");
      }
      if (epoch !== openEpoch.current) return;
      groupConfigs.current[key] = selected;
      setConfig(selected);
      setGroupName(
        name || groups.find((g) => g.address === key)?.name || "Shared group",
      );
      setMode("live");
      try {
        localStorage.setItem("wysiwys.activeGroup", key);
      } catch {
        /* Public link remains usable. */
      }
    } catch (e) {
      if (epoch === openEpoch.current)
        setError(
          e instanceof Error
            ? e.message
            : "This group could not be opened. Try again.",
        );
    }
  }
  useEffect(() => {
    if (
      !urlGroup ||
      mode === "loading" ||
      activeConfig.current?.multisig === urlGroup
    )
      return;
    if (acting.current) {
      ++walletEpoch.current;
      ++refreshEpoch.current;
      return;
    }
    void openGroup(urlGroup);
    // URL changes and completed actions drive history synchronization.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlGroup, busy]);
  async function createGroup(
    name: string,
    members: string[],
    threshold: number,
    kind: "guarded" | "standard" = "guarded",
  ) {
    const createKey = Keypair.generate();
    let address: string | undefined;
    let protectedConfig: SquadConfig | undefined;
    const success = await run(
      kind === "guarded" ? "create treasury" : "create group",
      async (rpc, key) => {
        const [programConfigPda] = sqds.getProgramConfigPda({});
        const info = await rpc.getAccountInfo(programConfigPda, "finalized");
        if (
          !info ||
          !info.owner.equals(sqds.PROGRAM_ID) ||
          !info.data
            .subarray(0, 8)
            .equals(Buffer.from(sqds.accounts.programConfigDiscriminator))
        )
          throw new Error(
            "Squads program configuration is unavailable. Try again.",
          );
        const [programConfig] =
          sqds.accounts.ProgramConfig.fromAccountInfo(info);
        const multisig = sqds
          .getMultisigPda({ createKey: createKey.publicKey })[0]
          .toBase58();
        if (kind === "guarded") {
          // The runner builds initialize_guard; the server route and this
          // client both validate it before the wallet signs.
          const body = JSON.stringify({
            multisig,
            creator: key.toBase58(),
            createKey: createKey.publicKey.toBase58(),
          });
          const response = await fetch("/api/squads/groups", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(await auth.authorizeRequest("/api/squads/groups", body)),
            },
            body,
          });
          const prepared = await response.json();
          if (!response.ok)
            throw new Error(
              prepared.error || "Group protection could not be prepared.",
            );
          const guarded: SquadConfig = prepared.config;
          if (
            guarded?.multisig !== multisig ||
            !guarded.guardProgram ||
            !guarded.executor
          )
            throw new Error("Group protection could not be prepared.");
          const executor = new PublicKey(guarded.executor);
          const { guardInstruction } = validateInitializeGuard(
            fromWire(prepared.guardInstruction),
            {
              guardProgram: new PublicKey(guarded.guardProgram),
              multisig: new PublicKey(multisig),
              createKey: createKey.publicKey,
              creator: key,
              executor,
            },
          );
          const group = buildGroupCreation({
            creator: key,
            createKey: createKey.publicKey,
            treasury: programConfig.treasury,
            members,
            threshold,
            name,
            executor,
          });
          address = group.multisig.toBase58();
          // multisigCreateV2 then initialize_guard, atomically.
          return [group.instruction, guardInstruction];
        }
        protectedConfig = {
          multisig,
          vaultIndex: 0,
          settlementEnabled: false,
          executionMode: "standard",
        };
        const group = buildGroupCreation({
          creator: key,
          createKey: createKey.publicKey,
          treasury: programConfig.treasury,
          members,
          threshold,
          name,
        });
        address = group.multisig.toBase58();
        return [group.instruction];
      },
      { withoutGroup: true, additionalSigners: [createKey] },
    );
    if (success && address) {
      if (protectedConfig) groupConfigs.current[address] = protectedConfig;
      remember(address, name.trim());
      await openGroup(address, name.trim());
      return address;
    }
  }
  async function invite(address: string) {
    let id: string | undefined;
    const success = await run("invite member", async (rpc, key) => {
      const fixed = fixedMembershipReason(config);
      if (fixed) throw new Error(fixed);
      const squad = await readMultisig(rpc, config!);
      const member = squad.members.find((m) => m.key.equals(key));
      if (
        !member ||
        !sqds.types.Permissions.has(
          member.permissions,
          sqds.types.Permission.Initiate,
        )
      )
        throw new Error("Your wallet cannot invite members.");
      const newMember = new PublicKey(address);
      if (squad.members.some((m) => m.key.equals(newMember)))
        throw new Error("This wallet is already a member.");
      if (!squad.configAuthority.equals(PublicKey.default))
        throw new Error(
          "Membership changes require the group's existing configuration authority.",
        );
      const index = BigInt(squad.transactionIndex.toString()) + 1n;
      id = index.toString();
      return buildMemberInvitation({
        multisig: new PublicKey(config!.multisig),
        creator: key,
        index,
        newMember,
      });
    });
    if (success) {
      setCursor(undefined);
      return id;
    }
  }
  return (
    <Context.Provider
      value={{
        mode,
        config,
        groupName,
        groups,
        createGroup,
        openGroup,
        invite,
        snapshot,
        error,
        busy,
        signature,
        account,
        funding,
        deposit,
        setThreshold,
        refresh,
        older: () =>
          setCursor((current) => {
            const latest = current ?? snapshot?.latest ?? 0n;
            return latest > 20n ? latest - 20n : 1n;
          }),
        newest: () => setCursor(undefined),
        vote,
        execute,
        proposePayment,
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
