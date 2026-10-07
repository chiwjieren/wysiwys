import { Buffer } from "buffer";
import * as sqds from "@sqds/multisig";
import {
  PublicKey,
  type Connection,
  type TransactionMessage,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import {
  decodeVaultTransaction,
  type DecodeResult,
  type DecodedAction,
} from "@wysiwys/decoder";
import { txHash } from "@wysiwys/shared";
import { tokenAmount } from "./payments";

// Payment previews come from @wysiwys/decoder's structured output for the exact VaultTransaction
// account bytes (stored on chain, or serialized by the Squads SDK for a draft). The app only turns
// decoded actions into text and checks live token accounts. A preview never authorizes: the
// guard's on-chain Review stays the verdict.

export type DisplayPayment = {
  asset: "SOL" | "token";
  /** Decimal amount for display, derived from the decoded base units. */
  amount: string;
  rawAmount: string;
  decimals: number;
  /** "SOL", the configured token's symbol, or "tokens" for any other token. */
  symbol: string;
  /** Token address (the SPL mint account); absent for SOL. */
  mint?: string;
  /** Account debited: the vault for SOL, the treasury's token account for SPL. */
  source: string;
  /** Recipient wallet: the SOL destination, or the destination token account's owner. */
  recipient: string;
  /** Account credited by the instruction (the wallet for SOL, the token account for SPL). */
  destination: string;
};
export type PaymentPreview = {
  supported: boolean;
  lines: string[];
  payments: DisplayPayment[];
  reason?: string;
  /** Decoder JSON, shown under Technical details. */
  decoded?: DecodeResult;
  /** Canonical tx_hash (hex) of the decoded bytes. */
  txHash?: string;
};
// Mutable SPL account owners and mint decimals, read from finalized chain state, never labels.
export type TokenContext = {
  accounts: Map<string, { owner: PublicKey; mint: PublicKey }>;
  mints: Map<string, number>;
};

const UNSUPPORTED =
  "An instruction is unsupported. Do not approve a transaction you cannot fully understand.";
const MALFORMED =
  "This transaction cannot be fully decoded. Approval is unavailable.";
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

function blocked(
  reason: string,
  lines: string[] = [],
  payments: DisplayPayment[] = [],
): PaymentPreview {
  return { supported: false, lines, payments, reason };
}

// The deployment's token, named by its symbol in previews. Other tokens show their address.
export type KnownToken = { mint: string; symbol: string };

export function describeDecoded(
  result: DecodeResult,
  vault: PublicKey,
  tokens: TokenContext = { accounts: new Map(), mints: new Map() },
  known?: KnownToken,
): PaymentPreview {
  const symbol = (mint: string) =>
    known?.mint === mint ? known.symbol : "tokens";
  const named = (mint: string) =>
    known?.mint === mint ? known.symbol : `token address ${mint}`;
  if (result.status === "unsupported") return blocked(UNSUPPORTED);
  if (result.status !== "success") return blocked(MALFORMED);
  if (!result.actions.length) return blocked(MALFORMED);
  const lines: string[] = [];
  const payments: DisplayPayment[] = [];
  const created = new Map<string, { owner: string; mint: string }>();
  const fromVault = vault.toBase58();
  for (const action of result.actions) {
    if (action.kind === "system.transfer" && action.source === fromVault) {
      const amount = tokenAmount(action.lamports, 9);
      payments.push({
        asset: "SOL",
        amount,
        rawAmount: action.lamports,
        decimals: 9,
        symbol: "SOL",
        source: fromVault,
        recipient: action.destination,
        destination: action.destination,
      });
      lines.push(
        `Send ${amount} SOL from the treasury vault to ${action.destination}.`,
      );
    } else if (
      (action.kind === "ata.create" ||
        action.kind === "ata.createIdempotent") &&
      action.payer === fromVault &&
      getAssociatedTokenAddressSync(
        new PublicKey(action.mint),
        new PublicKey(action.walletOwner),
        true,
      ).toBase58() === action.associatedTokenAccount
    ) {
      created.set(action.associatedTokenAccount, {
        owner: action.walletOwner,
        mint: action.mint,
      });
      lines.push(
        `Create wallet ${action.walletOwner} token account ${action.associatedTokenAccount} for ${named(action.mint)} if needed. Treasury SOL pays account rent.`,
      );
    } else if (
      action.kind === "token.transferChecked" &&
      action.programId === TOKEN_PROGRAM_ID.toBase58() &&
      action.authority === fromVault &&
      !action.multisigSigners?.length
    ) {
      const source = tokens.accounts.get(action.sourceTokenAccount);
      const live = tokens.accounts.get(action.destinationTokenAccount);
      const pending = created.get(action.destinationTokenAccount);
      if (
        !source ||
        source.owner.toBase58() !== fromVault ||
        source.mint.toBase58() !== action.mint ||
        tokens.mints.get(action.mint) !== action.decimals
      )
        return blocked(
          "Token ownership or mint decimals could not be verified. Approval is unavailable.",
          lines,
          payments,
        );
      if (
        (pending && pending.mint !== action.mint) ||
        (live &&
          (live.mint.toBase58() !== action.mint ||
            (pending && live.owner.toBase58() !== pending.owner)))
      )
        return blocked(
          "Recipient token account does not match the payment.",
          lines,
          payments,
        );
      const owner = pending?.owner ?? live?.owner.toBase58();
      if (!owner)
        return blocked(
          "Recipient token owner could not be verified. Approval is unavailable.",
          lines,
          payments,
        );
      const amount = tokenAmount(action.amount, action.decimals);
      payments.push({
        asset: "token",
        amount,
        rawAmount: action.amount,
        decimals: action.decimals,
        symbol: symbol(action.mint),
        mint: action.mint,
        source: action.sourceTokenAccount,
        recipient: owner,
        destination: action.destinationTokenAccount,
      });
      lines.push(
        `Send ${amount} ${known?.mint === action.mint ? known.symbol : `tokens (token address ${action.mint})`} from the treasury's token account ${action.sourceTokenAccount} to wallet ${owner}, into their token account ${action.destinationTokenAccount}.`,
      );
    } else
      return blocked(
        `Instruction ${action.instructionIndex + 1} (${action.kind}) is not a treasury payment. Do not approve a transaction you cannot fully understand.`,
        lines,
        payments,
      );
  }
  return { supported: true, lines, payments };
}

// Token accounts and mints named by decoded TransferChecked actions.
export async function readTokenContext(
  rpc: Pick<Connection, "getMultipleAccountsInfo">,
  result: DecodeResult,
): Promise<TokenContext> {
  const context: TokenContext = { accounts: new Map(), mints: new Map() };
  if (result.status !== "success") return context;
  const keys = new Set<string>();
  for (const action of result.actions)
    if (action.kind === "token.transferChecked")
      for (const key of [
        action.sourceTokenAccount,
        action.mint,
        action.destinationTokenAccount,
      ])
        keys.add(key);
  const addresses = Array.from(keys, (k) => new PublicKey(k));
  if (!addresses.length) return context;
  const infos = await rpc.getMultipleAccountsInfo(addresses, "finalized");
  addresses.forEach((address, i) => {
    const info = infos[i];
    if (!info || !info.owner.equals(TOKEN_PROGRAM_ID)) return;
    try {
      const account = unpackAccount(address, info);
      if (account.isInitialized && !account.isFrozen)
        context.accounts.set(address.toBase58(), {
          owner: account.owner,
          mint: account.mint,
        });
    } catch {
      /* May be a mint account. */
    }
    try {
      const mint = unpackMint(address, info);
      if (mint.isInitialized)
        context.mints.set(address.toBase58(), mint.decimals);
    } catch {
      /* May be a token account. */
    }
  });
  return context;
}

// Decode the exact VaultTransaction account bytes and bind them to the canonical tx_hash. When the
// on-chain Review names a tx_hash, any disagreement blocks approval.
export async function previewVaultTransaction(
  rpc: Pick<Connection, "getMultipleAccountsInfo">,
  account: { address: PublicKey; data: Uint8Array },
  vault: PublicKey,
  expectedTxHash?: Uint8Array,
  known?: KnownToken,
): Promise<PaymentPreview> {
  const decoded = decodeVaultTransaction(account.data);
  const hash = hex(txHash(account.address.toBytes(), account.data));
  const bound = (preview: PaymentPreview): PaymentPreview => ({
    ...preview,
    decoded,
    txHash: hash,
  });
  if (expectedTxHash && hex(expectedTxHash) !== hash)
    return bound(
      blocked(
        "The stored transaction does not match the transaction hash the guard reviewed. Approval is unavailable.",
      ),
    );
  try {
    return bound(
      describeDecoded(
        decoded,
        vault,
        await readTokenContext(rpc, decoded),
        known,
      ),
    );
  } catch {
    return bound(
      blocked("Token accounts could not be read. Refresh before approving."),
    );
  }
}

// The VaultTransaction account bytes vaultTransactionCreate would store for this draft, built with the
// Squads SDK serializers so a draft is decoded exactly like a stored proposal.
export function draftVaultTransaction(args: {
  multisig: PublicKey;
  creator: PublicKey;
  index: bigint;
  vaultIndex: number;
  message: TransactionMessage;
}): { address: PublicKey; data: Uint8Array } {
  const [address, bump] = sqds.getTransactionPda({
    multisigPda: args.multisig,
    index: args.index,
  });
  const [vault, vaultBump] = sqds.getVaultPda({
    multisigPda: args.multisig,
    index: args.vaultIndex,
  });
  const [compact] = sqds.types.transactionMessageBeet.deserialize(
    Buffer.from(
      sqds.utils.transactionMessageToMultisigTransactionMessageBytes({
        message: args.message,
        vaultPda: vault,
      }),
    ),
  );
  const [data] = sqds.accounts.VaultTransaction.fromArgs({
    multisig: args.multisig,
    creator: args.creator,
    // beet's u64 serializes a bigint; its typing only names number | BN.
    index: args.index as unknown as number,
    bump,
    vaultIndex: args.vaultIndex,
    vaultBump,
    ephemeralSignerBumps: new Uint8Array(),
    message: {
      numSigners: compact.numSigners,
      numWritableSigners: compact.numWritableSigners,
      numWritableNonSigners: compact.numWritableNonSigners,
      accountKeys: compact.accountKeys,
      instructions: compact.instructions.map((ix) => ({
        programIdIndex: ix.programIdIndex,
        accountIndexes: Uint8Array.from(ix.accountIndexes),
        data: Uint8Array.from(ix.data),
      })),
      addressTableLookups: compact.addressTableLookups.map((l) => ({
        accountKey: l.accountKey,
        writableIndexes: Uint8Array.from(l.writableIndexes),
        readonlyIndexes: Uint8Array.from(l.readonlyIndexes),
      })),
    },
  }).serialize();
  return { address, data: new Uint8Array(data) };
}

// Short list label (amount and asset) for a decoded payment. Not an approval input.
export function paymentLabel(
  result: DecodeResult,
  label: (mint: string | undefined) => string,
): string | undefined {
  if (result.status !== "success") return undefined;
  const transfers = result.actions.filter(
    (
      a,
    ): a is Extract<
      DecodedAction,
      { kind: "system.transfer" | "token.transferChecked" }
    > => a.kind === "system.transfer" || a.kind === "token.transferChecked",
  );
  const first = transfers[0];
  if (!first) return undefined;
  return first.kind === "system.transfer"
    ? `Send ${tokenAmount(first.lamports, 9)} ${label(undefined)}`
    : `Send ${tokenAmount(first.amount, first.decimals)} ${label(first.mint)}`;
}

// Re-decode before voting or executing and compare against what the signer reviewed.
export function assertReviewedPreview(
  reviewed: readonly string[] | undefined,
  fresh: PaymentPreview,
) {
  if (!fresh.supported)
    throw new Error(fresh.reason || "Transaction cannot be fully decoded.");
  if (!reviewed?.length)
    throw new Error("Review the decoded payment before approving.");
  if (JSON.stringify(reviewed) !== JSON.stringify(fresh.lines))
    throw new Error(
      "Payment details changed. Refresh and review the recipient again before approving.",
    );
}
