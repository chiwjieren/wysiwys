import { Buffer } from "buffer";
import * as sqds from "@sqds/multisig";
import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createTransferCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { parseAmount } from "./governance";
import { decodeVaultTransaction, type DecodeResult } from "@wysiwys/decoder";
import { txHash } from "@wysiwys/shared";

export type StoredPayment = {
  data: Uint8Array;
  address: PublicKey;
  hash: Uint8Array;
};

export type PaymentInput = {
  recipient: string;
  amount: string;
  token?: { mint: string; source: string; decimals: number };
  memo?: string;
};
export function tokenAmount(raw: string, decimals: number) {
  const padded = raw.padStart(decimals + 1, "0");
  return decimals
    ? `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`.replace(
        /\.?0+$/,
        "",
      )
    : padded;
}
// Unit label for an amount: SOL, the deployment token symbol, or generic tokens.
export function assetLabel(
  config: { token?: { mint: string; symbol: string } } | undefined,
  mint: string | undefined,
) {
  if (!mint) return "SOL";
  return config?.token?.mint === mint ? config.token.symbol : "tokens";
}
export function buildPaymentInstructions({
  vault,
  ...input
}: PaymentInput & { vault: PublicKey }) {
  const recipient = new PublicKey(input.recipient);
  if (!PublicKey.isOnCurve(recipient.toBytes()) || recipient.equals(vault))
    throw new Error(
      "Enter a recipient wallet different from the treasury vault.",
    );
  const amount = parseAmount(input.amount, input.token?.decimals ?? 9);
  if (!input.token)
    return [
      SystemProgram.transfer({
        fromPubkey: vault,
        toPubkey: recipient,
        lamports: amount,
      }),
    ];
  const mint = new PublicKey(input.token.mint),
    destination = getAssociatedTokenAddressSync(mint, recipient);
  return [
    createAssociatedTokenAccountIdempotentInstruction(
      vault,
      destination,
      recipient,
      mint,
    ),
    createTransferCheckedInstruction(
      new PublicKey(input.token.source),
      mint,
      destination,
      vault,
      amount,
      input.token.decimals,
    ),
  ];
}
// The guard's policy approves a stored transaction with exactly one instruction:
// a System SOL transfer or a legacy SPL TransferChecked into an existing account.
export async function buildGuardedPaymentInstruction(
  rpc: Pick<Connection, "getAccountInfo">,
  input: PaymentInput & { vault: PublicKey },
): Promise<TransactionInstruction> {
  const instructions = buildPaymentInstructions(input);
  const transfer = instructions[instructions.length - 1];
  if (!input.token) return transfer;
  const mint = new PublicKey(input.token.mint);
  const recipient = new PublicKey(input.recipient);
  const destination = getAssociatedTokenAddressSync(mint, recipient);
  const missing = new Error(
    "The recipient has no token account for this token. Guarded payouts cannot create accounts, so ask the recipient to create one first.",
  );
  const info = await rpc.getAccountInfo(destination, "finalized");
  if (!info || !info.owner.equals(TOKEN_PROGRAM_ID)) throw missing;
  try {
    const account = unpackAccount(destination, info);
    if (
      !account.isInitialized ||
      account.isFrozen ||
      !account.mint.equals(mint) ||
      !account.owner.equals(recipient)
    )
      throw missing;
  } catch {
    throw missing;
  }
  return transfer;
}
export function buildPaymentProposal(args: {
  multisig: PublicKey;
  member: PublicKey;
  index: bigint;
  vaultIndex: number;
  message: TransactionMessage;
  memo?: string;
}) {
  const { multisig, member, index, vaultIndex, message, memo } = args;
  const [vault] = sqds.getVaultPda({
    multisigPda: multisig,
    index: vaultIndex,
  });
  if (!message.payerKey.equals(vault) || !message.instructions.length)
    throw new Error("Payment must originate from the treasury vault.");
  if (memo && new TextEncoder().encode(memo).length > 180)
    throw new Error("Keep the memo under 180 bytes.");
  return [
    sqds.instructions.vaultTransactionCreate({
      multisigPda: multisig,
      creator: member,
      rentPayer: member,
      transactionIndex: index,
      vaultIndex,
      ephemeralSigners: 0,
      transactionMessage: message,
      memo,
    }),
    sqds.instructions.proposalCreate({
      multisigPda: multisig,
      creator: member,
      rentPayer: member,
      transactionIndex: index,
      isDraft: false,
    }),
  ];
}
// Shared decoder output is descriptive. These display checks do not grant a Guard verdict.
type Message = {
  numSigners?: number;
  numWritableSigners?: number;
  numWritableNonSigners?: number;
  accountKeys: PublicKey[];
  instructions: {
    programIdIndex: number;
    accountIndexes: Uint8Array;
    data: Uint8Array;
  }[];
  addressTableLookups: unknown[];
};
export type PaymentPreview = {
  supported: boolean;
  lines: string[];
  reason?: string;
  decoder?: DecodeResult;
};
export function previewMessage(
  message: Message,
  vault: PublicKey,
  tokens?: TokenContext,
): PaymentPreview {
  // Drafts have no stored account yet. Use the SDK account serializer rather
  // than maintaining a second instruction decoder or a hand-written layout.
  if (message.addressTableLookups.length)
    return {
      supported: false,
      lines: [],
      reason: "Address lookup table payments are unsupported.",
    };
  try {
    const data = sqds.accounts.VaultTransaction.fromArgs({
      multisig: PublicKey.default,
      creator: PublicKey.default,
      index: 0,
      bump: 0,
      vaultIndex: 0,
      vaultBump: 0,
      ephemeralSignerBumps: new Uint8Array(),
      message: {
        ...message,
        numSigners: message.numSigners ?? 1,
        numWritableSigners: message.numWritableSigners ?? 1,
        numWritableNonSigners: message.numWritableNonSigners ?? 0,
        addressTableLookups: [],
      },
    }).serialize()[0];
    return previewVaultTransaction(data, vault, tokens);
  } catch {
    return {
      supported: false,
      lines: [],
      reason: "This draft cannot be decoded. Approval is unavailable.",
    };
  }
}

export function previewVaultTransaction(
  data: Uint8Array,
  vault: PublicKey,
  tokens?: TokenContext,
  binding?: Omit<StoredPayment, "data">,
): PaymentPreview {
  if (binding) {
    const actual = txHash(binding.address.toBytes(), data);
    if (
      binding.hash.length !== actual.length ||
      actual.some((byte, i) => byte !== binding.hash[i])
    )
      return {
        supported: false,
        lines: [],
        reason:
          "The stored transaction changed. Refresh and request a new review.",
      };
  }
  const decoder = decodeVaultTransaction(data);
  if (decoder.status !== "success")
    return {
      supported: false,
      lines: [],
      decoder,
      reason: `The decoder could not fully inspect this transaction (${decoder.error}). Approval is unavailable.`,
    };
  const lines: string[] = [];
  try {
    const [transaction] = sqds.accounts.VaultTransaction.deserialize(
      Buffer.from(data),
    );
    const created = new Map<string, { owner: PublicKey; mint: PublicKey }>();
    for (const action of decoder.actions) {
      if (action.kind === "system.transfer") {
        if (
          transaction.message.instructions[action.instructionIndex]
            .accountIndexes.length !== 2
        )
          throw new Error(
            "The payment has unexpected instruction accounts. Approval is unavailable.",
          );
        if (action.source !== vault.toBase58())
          throw new Error("Payment must originate from the treasury vault.");
        lines.push(
          `Send ${tokenAmount(action.lamports, 9)} SOL from the treasury vault to ${action.destination}.`,
        );
      } else if (action.kind === "ata.createIdempotent") {
        const owner = new PublicKey(action.walletOwner);
        const mint = new PublicKey(action.mint);
        if (
          action.payer !== vault.toBase58() ||
          getAssociatedTokenAddressSync(mint, owner, true).toBase58() !==
            action.associatedTokenAccount
        )
          throw new Error("Invalid recipient token account derivation.");
        created.set(action.associatedTokenAccount, { owner, mint });
        lines.push(
          `Create token account ${action.associatedTokenAccount} for wallet ${action.walletOwner} and mint ${action.mint} if needed. Treasury SOL pays account rent.`,
        );
      } else if (action.kind === "token.transferChecked") {
        if (
          action.authority !== vault.toBase58() ||
          action.multisigSigners?.length
        )
          throw new Error("Payment must be authorized by the treasury vault.");
        const mint = new PublicKey(action.mint);
        const recipient = created.get(action.destinationTokenAccount);
        const source = tokens?.accounts.get(action.sourceTokenAccount);
        const destination = tokens?.accounts.get(
          action.destinationTokenAccount,
        );
        const decimals = tokens?.mints.get(action.mint);
        if (
          !source ||
          !source.owner.equals(vault) ||
          !source.mint.equals(mint) ||
          decimals !== action.decimals
        )
          throw new Error(
            "Token ownership or mint decimals could not be verified. Approval is unavailable.",
          );
        if (recipient && !recipient.mint.equals(mint))
          throw new Error("Token mint mismatch.");
        if (
          destination &&
          (!destination.mint.equals(mint) ||
            (recipient && !destination.owner.equals(recipient.owner)))
        )
          throw new Error(
            "Recipient token account does not match the payment.",
          );
        const owner = recipient?.owner ?? destination?.owner;
        if (!owner)
          throw new Error(
            "Recipient token owner could not be verified. Approval is unavailable.",
          );
        lines.push(
          `Send ${tokenAmount(action.amount, action.decimals)} tokens (mint ${action.mint}) from token account ${action.sourceTokenAccount} to wallet ${owner.toBase58()} via token account ${action.destinationTokenAccount}.`,
        );
      } else
        throw new Error(
          "An instruction is unsupported. Do not approve a transaction you cannot fully understand.",
        );
    }
    return { supported: true, lines, decoder };
  } catch (e) {
    return {
      supported: false,
      lines,
      decoder,
      reason:
        e instanceof Error ? e.message : "Could not decode the transaction.",
    };
  }
}

// Resolve mutable SPL account owners and mint decimals from finalized chain state, never labels.
export type TokenContext = {
  accounts: Map<string, { owner: PublicKey; mint: PublicKey }>;
  mints: Map<string, number>;
};
export async function readPaymentPreview(
  rpc: Pick<Connection, "getMultipleAccountsInfo">,
  message: Message,
  vault: PublicKey,
  stored?: StoredPayment,
) {
  const keys = new Map<string, PublicKey>();
  for (const ix of message.instructions) {
    if (message.accountKeys[ix.programIdIndex]?.equals(TOKEN_PROGRAM_ID))
      for (const i of Array.from(ix.accountIndexes).slice(0, 3)) {
        const key = message.accountKeys[i];
        if (key) keys.set(key.toBase58(), key);
      }
  }
  const context: TokenContext = { accounts: new Map(), mints: new Map() };
  try {
    const addresses = Array.from(keys.values());
    if (addresses.length) {
      const infos = await rpc.getMultipleAccountsInfo(addresses, "finalized");
      addresses.forEach((address, i) => {
        const info = infos[i];
        if (!info) return;
        try {
          const account = unpackAccount(address, info);
          if (account.isInitialized)
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
    }
    return stored
      ? previewVaultTransaction(stored.data, vault, context, stored)
      : previewMessage(message, vault, context);
  } catch {
    return {
      supported: false,
      lines: [],
      reason: "Token accounts could not be read. Refresh before approving.",
    };
  }
}

// Re-read mutable token ownership before voting and compare against the displayed review.
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
