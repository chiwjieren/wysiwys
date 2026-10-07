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
} from "@solana/spl-token";
import { parseAmount } from "./governance";

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
