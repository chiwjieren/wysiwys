import { Buffer } from "buffer";
import * as sqds from "@sqds/multisig";
import {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
} from "@solana/web3.js";

export type SquadConfig = {
  multisig: string;
  guardProgram: string;
  executor: string;
  vaultIndex: number;
  settlementEnabled: boolean;
};
export type WireInstruction = {
  programId: string;
  keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
};
export type VoteAction = "approve" | "reject" | "cancel";
export function proposalIndices(latest: bigint, count = 20) {
  if (
    latest < 0n ||
    latest > 18446744073709551615n ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 40
  )
    throw new Error("Invalid proposal range.");
  return Array.from(
    { length: Number(latest < BigInt(count) ? latest : BigInt(count)) },
    (_, i) => latest - BigInt(i),
  );
}
export function actionsForMember(
  squad: Pick<sqds.accounts.Multisig, "members" | "staleTransactionIndex">,
  proposal: sqds.accounts.Proposal,
  wallet?: PublicKey,
) {
  const member = squad.members.find((m) => wallet?.equals(m.key));
  const canVote =
    !!member &&
    sqds.types.Permissions.has(member.permissions, sqds.types.Permission.Vote);
  const stale =
    BigInt(proposal.transactionIndex.toString()) <=
    BigInt(squad.staleTransactionIndex.toString());
  const active = proposal.status.__kind === "Active" && !stale;
  const includes = (keys: PublicKey[]) => keys.some((k) => wallet?.equals(k));
  return {
    approve: canVote && active && !includes(proposal.approved),
    reject: canVote && active && !includes(proposal.rejected),
    cancel:
      canVote &&
      !includes(proposal.cancelled) &&
      (proposal.status.__kind === "Approved" ||
        (stale && ["Draft", "Active"].includes(proposal.status.__kind))),
  };
}
export function decodeProposal(proposal: sqds.accounts.Proposal) {
  return {
    index: proposal.transactionIndex.toString(),
    status: proposal.status.__kind,
    approved: proposal.approved.map((k) => k.toBase58()),
    rejected: proposal.rejected.map((k) => k.toBase58()),
    cancelled: proposal.cancelled.map((k) => k.toBase58()),
  };
}
export function buildVote(
  action: VoteAction,
  multisig: PublicKey,
  index: bigint,
  member: PublicKey,
) {
  const args = { multisigPda: multisig, transactionIndex: index, member };
  if (action === "approve") return sqds.instructions.proposalApprove(args);
  if (action === "reject") return sqds.instructions.proposalReject(args);
  return sqds.instructions.proposalCancel(args);
}
export function validateGuardInstruction(
  ix: TransactionInstruction,
  guard: PublicKey,
  multisig: PublicKey,
  index: bigint,
  member: PublicKey,
) {
  if (
    !ix.programId.equals(guard) ||
    guard.equals(sqds.PROGRAM_ID) ||
    ix.data.length === 0
  )
    throw new Error("A guard instruction is required.");
  const [transaction] = sqds.getTransactionPda({
    multisigPda: multisig,
    index,
  });
  const [proposal] = sqds.getProposalPda({
    multisigPda: multisig,
    transactionIndex: index,
  });
  for (const key of [multisig, transaction, proposal]) {
    if (!ix.keys.some((k) => k.pubkey.equals(key)))
      throw new Error(
        "Guard instruction is missing the selected proposal accounts.",
      );
  }
  if (ix.keys.some((k) => k.isSigner && !k.pubkey.equals(member)))
    throw new Error("Unexpected guard instruction signer.");
  return ix;
}
export function buildPayoutProposal(args: {
  multisig: PublicKey;
  member: PublicKey;
  index: bigint;
  vaultIndex: number;
  message: TransactionMessage;
  guard: PublicKey;
  requestReview: TransactionInstruction;
}) {
  const { multisig, member, index, vaultIndex, message, guard, requestReview } =
    args;
  validateGuardInstruction(requestReview, guard, multisig, index, member);
  const [vault] = sqds.getVaultPda({
    multisigPda: multisig,
    index: vaultIndex,
  });
  if (!message.payerKey.equals(vault) || message.instructions.length === 0)
    throw new Error("The payout must use the configured vault.");
  return [
    sqds.instructions.vaultTransactionCreate({
      multisigPda: multisig,
      transactionIndex: index,
      creator: member,
      rentPayer: member,
      vaultIndex,
      ephemeralSigners: 0,
      transactionMessage: message,
    }),
    sqds.instructions.proposalCreate({
      multisigPda: multisig,
      transactionIndex: index,
      creator: member,
      rentPayer: member,
      isDraft: false,
    }),
    requestReview,
  ];
}
export function fromWire(ix: WireInstruction) {
  if (
    !ix ||
    !Array.isArray(ix.keys) ||
    ix.keys.length > 64 ||
    typeof ix.data !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      ix.data,
    )
  )
    throw new Error("Invalid settlement instruction.");
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.keys.map((k) => {
      if (typeof k.isSigner !== "boolean" || typeof k.isWritable !== "boolean")
        throw new Error("Invalid account flags.");
      return { ...k, pubkey: new PublicKey(k.pubkey) };
    }),
    data: Buffer.from(ix.data, "base64"),
  });
}
function owned(info: AccountInfo<Buffer> | null) {
  if (!info || !info.owner.equals(sqds.PROGRAM_ID))
    throw new Error("Squads account missing or owned by another program.");
  return info;
}
export async function readMultisig(
  connection: Connection,
  config: SquadConfig,
) {
  const address = new PublicKey(config.multisig);
  const info = owned(await connection.getAccountInfo(address, "finalized"));
  if (
    !info.data
      .subarray(0, 8)
      .equals(Buffer.from(sqds.accounts.multisigDiscriminator))
  )
    throw new Error("Invalid Multisig account discriminator.");
  const [squad] = sqds.accounts.Multisig.fromAccountInfo(info);
  const [expected] = sqds.getMultisigPda({ createKey: squad.createKey });
  if (!expected.equals(address)) throw new Error("Multisig PDA mismatch.");
  return squad;
}
export type ProposalRecord = {
  proposal: sqds.accounts.Proposal;
  transaction: sqds.accounts.VaultTransaction;
  address: PublicKey;
  transactionAddress: PublicKey;
};
export async function readProposal(
  connection: Connection,
  config: SquadConfig,
  index: bigint,
): Promise<ProposalRecord | null> {
  const multisig = new PublicKey(config.multisig);
  const [address] = sqds.getProposalPda({
    multisigPda: multisig,
    transactionIndex: index,
  });
  const [transactionAddress] = sqds.getTransactionPda({
    multisigPda: multisig,
    index,
  });
  const [p, tx] = await connection.getMultipleAccountsInfo(
    [address, transactionAddress],
    "finalized",
  );
  return decodeProposalPair(config, index, p, tx);
}
function decodeProposalPair(
  config: SquadConfig,
  index: bigint,
  p: AccountInfo<Buffer> | null,
  tx: AccountInfo<Buffer> | null,
): ProposalRecord | null {
  const multisig = new PublicKey(config.multisig);
  const [address] = sqds.getProposalPda({
    multisigPda: multisig,
    transactionIndex: index,
  });
  const [transactionAddress] = sqds.getTransactionPda({
    multisigPda: multisig,
    index,
  });
  if (!p && !tx) return null;
  const proposalInfo = owned(p);
  const transactionInfo = owned(tx);
  // Config transactions are not settlement payouts and cannot be acted on here.
  if (
    transactionInfo.data
      .subarray(0, 8)
      .equals(Buffer.from(sqds.accounts.configTransactionDiscriminator))
  )
    return null;
  if (
    !proposalInfo.data
      .subarray(0, 8)
      .equals(Buffer.from(sqds.accounts.proposalDiscriminator)) ||
    !transactionInfo.data
      .subarray(0, 8)
      .equals(Buffer.from(sqds.accounts.vaultTransactionDiscriminator))
  )
    throw new Error("Invalid Squads account discriminator.");
  const [proposal] = sqds.accounts.Proposal.fromAccountInfo(proposalInfo);
  const [transaction] =
    sqds.accounts.VaultTransaction.fromAccountInfo(transactionInfo);
  if (
    !proposal.multisig.equals(multisig) ||
    !transaction.multisig.equals(multisig) ||
    BigInt(proposal.transactionIndex.toString()) !== index ||
    BigInt(transaction.index.toString()) !== index
  )
    throw new Error("Proposal account binding mismatch.");
  return { proposal, transaction, address, transactionAddress };
}
export async function signAndConfirm(
  connection: Connection,
  wallet: PublicKey,
  instructions: TransactionInstruction[],
  sign: (bytes: Uint8Array) => Promise<Uint8Array>,
  onSubmitted: (signature: string) => void,
) {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("finalized");
  const transaction = new VersionedTransaction(
    new TransactionMessage({
      payerKey: wallet,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(),
  );
  const signed = VersionedTransaction.deserialize(
    await sign(transaction.serialize()),
  );
  if (
    !Buffer.from(signed.message.serialize()).equals(
      Buffer.from(transaction.message.serialize()),
    )
  )
    throw new Error("Wallet changed the transaction message.");
  const signature = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    preflightCommitment: "finalized",
    maxRetries: 3,
  });
  onSubmitted(signature);
  // Poll HTTP so RPC credentials never appear in a client WebSocket URL.
  while (true) {
    const [status] = (
      await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      })
    ).value;
    if (status?.err)
      throw new Error(
        "Transaction failed on-chain. Inspect the signature for details.",
      );
    if (status?.confirmationStatus === "finalized") return signature;
    if ((await connection.getBlockHeight("finalized")) > lastValidBlockHeight)
      throw new Error(
        "Confirmation not observed before expiry. Refresh chain state before retrying.",
      );
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

export async function readProposalPage(
  connection: Connection,
  config: SquadConfig,
  latest: bigint,
): Promise<ProposalRecord[]> {
  const indices = proposalIndices(latest);
  if (!indices.length) return [];
  const multisig = new PublicKey(config.multisig);
  const addresses = indices.flatMap((index) => [
    sqds.getProposalPda({ multisigPda: multisig, transactionIndex: index })[0],
    sqds.getTransactionPda({ multisigPda: multisig, index })[0],
  ]);
  const accounts = await connection.getMultipleAccountsInfo(
    addresses,
    "finalized",
  );
  return indices
    .map((index, i) =>
      decodeProposalPair(config, index, accounts[i * 2], accounts[i * 2 + 1]),
    )
    .filter((record): record is ProposalRecord => record !== null);
}
