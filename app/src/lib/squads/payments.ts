import { Buffer } from "buffer";
import * as sqds from "@sqds/multisig";
import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  type Connection,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createTransferCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
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
// App-only local preview. This is not the shared CRE DecodedAction contract or an on-chain policy verdict.
type Message = {
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
};
export function previewMessage(
  message: Message,
  vault: PublicKey,
  tokens?: TokenContext,
): PaymentPreview {
  const lines: string[] = [];
  try {
    if (message.addressTableLookups.length || !message.instructions.length)
      throw new Error(
        "This transaction cannot be fully decoded. Approval is unavailable.",
      );
    const created = new Map<string, { owner: PublicKey; mint: PublicKey }>();
    for (const ix of message.instructions) {
      const program = message.accountKeys[ix.programIdIndex];
      const keys = Array.from(ix.accountIndexes, (i) => message.accountKeys[i]);
      if (!program || keys.some((k) => !k))
        throw new Error("Invalid instruction accounts.");
      const data = Buffer.from(ix.data);
      if (
        program.equals(SystemProgram.programId) &&
        data.length === 12 &&
        data.readUInt32LE(0) === 2 &&
        keys.length === 2 &&
        keys[0].equals(vault)
      ) {
        lines.push(
          `Send ${tokenAmount(data.readBigUInt64LE(4).toString(), 9)} SOL from the treasury vault to ${keys[1].toBase58()}.`,
        );
      } else if (
        program.equals(ASSOCIATED_TOKEN_PROGRAM_ID) &&
        data.length === 1 &&
        data[0] === 1 &&
        keys.length === 6 &&
        keys[0].equals(vault) &&
        keys[4].equals(SystemProgram.programId) &&
        keys[5].equals(TOKEN_PROGRAM_ID) &&
        getAssociatedTokenAddressSync(keys[3], keys[2], true).equals(keys[1])
      ) {
        created.set(keys[1].toBase58(), { owner: keys[2], mint: keys[3] });
        lines.push(
          `Create token account ${keys[1].toBase58()} for wallet ${keys[2].toBase58()} and mint ${keys[3].toBase58()} if needed. Treasury SOL pays account rent.`,
        );
      } else if (
        program.equals(TOKEN_PROGRAM_ID) &&
        data.length === 10 &&
        data[0] === 12 &&
        keys.length === 4 &&
        keys[3].equals(vault)
      ) {
        const recipient = created.get(keys[2].toBase58());
        const source = tokens?.accounts.get(keys[0].toBase58());
        const destination = tokens?.accounts.get(keys[2].toBase58());
        const decimals = tokens?.mints.get(keys[1].toBase58());
        if (
          !source ||
          !source.owner.equals(vault) ||
          !source.mint.equals(keys[1]) ||
          decimals !== data[9]
        )
          throw new Error(
            "Token ownership or mint decimals could not be verified. Approval is unavailable.",
          );
        if (recipient && !recipient.mint.equals(keys[1]))
          throw new Error("Token mint mismatch.");
        if (
          destination &&
          (!destination.mint.equals(keys[1]) ||
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
          `Send ${tokenAmount(data.readBigUInt64LE(1).toString(), data[9])} tokens (mint ${keys[1].toBase58()}) from token account ${keys[0].toBase58()} to wallet ${owner.toBase58()} via token account ${keys[2].toBase58()}.`,
        );
      } else
        throw new Error(
          "An instruction is unsupported. Do not approve a transaction you cannot fully understand.",
        );
    }
    return { supported: true, lines };
  } catch (e) {
    return {
      supported: false,
      lines,
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
    return previewMessage(message, vault, context);
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
