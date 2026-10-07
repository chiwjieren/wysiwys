import { Buffer } from "buffer";
import * as sqds from "@sqds/multisig";
import {
  ComputeBudgetProgram,
  type VersionedMessage,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
} from "@solana/web3.js";

export type SquadConfig = {
  multisig: string;
  guardProgram?: string;
  executor?: string;
  vaultIndex: number;
  settlementEnabled: boolean;
  executionMode?: "standard" | "guarded";
  // Public display metadata for the deployment mint (e.g. mUSD).
  token?: { mint: string; symbol: string; decimals: number };
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
// guarded_execute CPIs into Squads execute, which needs more than the default compute.
export const GUARDED_EXECUTE_COMPUTE_UNITS = 400_000;
export function buildGuardedExecute(
  ix: TransactionInstruction,
  guard: PublicKey,
  multisig: PublicKey,
  index: bigint,
  member: PublicKey,
) {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({
      units: GUARDED_EXECUTE_COMPUTE_UNITS,
    }),
    validateGuardInstruction(ix, guard, multisig, index, member),
  ];
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
export function toWire(ix: TransactionInstruction): WireInstruction {
  return {
    programId: ix.programId.toBase58(),
    keys: ix.keys.map((k) => ({
      pubkey: k.pubkey.toBase58(),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: Buffer.from(ix.data).toString("base64"),
  };
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
  address: PublicKey;
  transactionAddress: PublicKey;
} & (
  | { kind: "vault"; transaction: sqds.accounts.VaultTransaction }
  | { kind: "config"; transaction: sqds.accounts.ConfigTransaction }
  | { kind: "batch"; transaction: sqds.accounts.Batch }
  | { kind: "archived"; transaction: null }
);
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
  const proposal = p ? decodeBoundProposal(p, multisig, index) : undefined;
  if (!tx && proposal?.status.__kind === "Executed")
    return {
      kind: "archived",
      proposal,
      address,
      transactionAddress,
      transaction: null,
    };
  const transactionInfo = owned(tx);
  const isConfig = transactionInfo.data
    .subarray(0, 8)
    .equals(Buffer.from(sqds.accounts.configTransactionDiscriminator));
  const isBatch = transactionInfo.data
    .subarray(0, 8)
    .equals(Buffer.from(sqds.accounts.batchDiscriminator));
  if (
    !isConfig &&
    !isBatch &&
    !transactionInfo.data
      .subarray(0, 8)
      .equals(Buffer.from(sqds.accounts.vaultTransactionDiscriminator))
  )
    throw new Error("Invalid Squads account discriminator.");

  const [transaction] = isConfig
    ? sqds.accounts.ConfigTransaction.fromAccountInfo(transactionInfo)
    : isBatch
      ? sqds.accounts.Batch.fromAccountInfo(transactionInfo)
      : sqds.accounts.VaultTransaction.fromAccountInfo(transactionInfo);
  // Squads empties VaultTransaction with mem::take after a successful execution.
  if (
    !isConfig &&
    !isBatch &&
    proposal?.status.__kind === "Executed" &&
    transaction.multisig.equals(PublicKey.default) &&
    transaction.index.toString() === "0"
  ) {
    const cleared = transaction as sqds.accounts.VaultTransaction;
    if (
      !cleared.creator.equals(PublicKey.default) ||
      cleared.bump ||
      cleared.vaultIndex ||
      cleared.vaultBump ||
      cleared.ephemeralSignerBumps.length ||
      cleared.message.numSigners ||
      cleared.message.numWritableSigners ||
      cleared.message.numWritableNonSigners ||
      cleared.message.accountKeys.length ||
      cleared.message.instructions.length ||
      cleared.message.addressTableLookups.length
    )
      throw new Error("Invalid cleared transaction account.");
    return {
      kind: "archived",
      proposal,
      address,
      transactionAddress,
      transaction: null,
    };
  }
  if (
    !transaction.multisig.equals(multisig) ||
    BigInt(transaction.index.toString()) !== index
  )
    throw new Error("Transaction account binding mismatch.");
  if (!proposal) return null; // SDK transactions can exist before proposalCreate.
  if (isBatch)
    return {
      kind: "batch",
      proposal,
      transaction: transaction as sqds.accounts.Batch,
      address,
      transactionAddress,
    };
  return isConfig
    ? {
        kind: "config",
        proposal,
        transaction: transaction as sqds.accounts.ConfigTransaction,
        address,
        transactionAddress,
      }
    : {
        kind: "vault",
        proposal,
        transaction: transaction as sqds.accounts.VaultTransaction,
        address,
        transactionAddress,
      };
}
function decodeBoundProposal(
  info: AccountInfo<Buffer>,
  multisig: PublicKey,
  index: bigint,
) {
  const proposalInfo = owned(info);
  if (
    !proposalInfo.data
      .subarray(0, 8)
      .equals(Buffer.from(sqds.accounts.proposalDiscriminator))
  )
    throw new Error("Invalid Squads proposal discriminator.");
  const [proposal] = sqds.accounts.Proposal.fromAccountInfo(proposalInfo);
  if (
    !proposal.multisig.equals(multisig) ||
    BigInt(proposal.transactionIndex.toString()) !== index
  )
    throw new Error("Proposal account binding mismatch.");
  return proposal;
}
// Every transaction carries its own compute limit and priority fee. Wallets such as Phantom add
// their own fee instructions when a transaction has none, which changes the signed bytes.
export const COMPUTE_UNIT_LIMIT = 400_000;
export const PRIORITY_FEE_MICROLAMPORTS = 10_000;
const isComputeBudget = (ix: TransactionInstruction) =>
  ix.programId.equals(ComputeBudgetProgram.programId);
const SET_COMPUTE_UNIT_LIMIT = 2;
const SET_COMPUTE_UNIT_PRICE = 3;

/** Prepends a compute limit and a priority fee unless the instructions already set them. */
export function withComputeBudget(instructions: TransactionInstruction[]) {
  const has = (tag: number) =>
    instructions.some((ix) => isComputeBudget(ix) && ix.data[0] === tag);
  return [
    ...(has(SET_COMPUTE_UNIT_LIMIT)
      ? []
      : [ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT })]),
    ...(has(SET_COMPUTE_UNIT_PRICE)
      ? []
      : [
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: PRIORITY_FEE_MICROLAMPORTS,
          }),
        ]),
    ...instructions,
  ];
}

/**
 * What you see is what you sign: the wallet may only add or change compute budget (fee)
 * instructions. Same fee payer, same blockhash, and every other instruction identical and in
 * the same order (program, accounts with signer/writable flags, data). Anything else throws.
 */
export function assertSameIntent(built: VersionedMessage, signed: VersionedMessage) {
  if (Buffer.from(built.serialize()).equals(Buffer.from(signed.serialize()))) return;
  const changed = () => new Error("Wallet changed the transaction message.");
  let a: TransactionMessage, b: TransactionMessage;
  try {
    // Lookup tables are never used by this app; a wallet adding one is a change.
    if (signed.addressTableLookups.length || built.addressTableLookups.length) throw changed();
    a = TransactionMessage.decompile(built);
    b = TransactionMessage.decompile(signed);
  } catch {
    throw changed();
  }
  if (!a.payerKey.equals(b.payerKey) || a.recentBlockhash !== b.recentBlockhash) throw changed();
  const work = (m: TransactionMessage) => m.instructions.filter((ix) => !isComputeBudget(ix));
  const x = work(a);
  const y = work(b);
  const same = (p: TransactionInstruction, q: TransactionInstruction) =>
    p.programId.equals(q.programId) &&
    p.data.equals(q.data) &&
    p.keys.length === q.keys.length &&
    p.keys.every(
      (k, i) =>
        k.pubkey.equals(q.keys[i].pubkey) &&
        k.isSigner === q.keys[i].isSigner &&
        k.isWritable === q.keys[i].isWritable,
    );
  if (x.length !== y.length || !x.every((ix, i) => same(ix, y[i]))) throw changed();
}

export async function signAndConfirm(
  connection: Connection,
  wallet: PublicKey,
  instructions: TransactionInstruction[],
  sign: (bytes: Uint8Array) => Promise<Uint8Array>,
  onSubmitted: (signature: string) => void,
  additionalSigners: import("@solana/web3.js").Signer[] = [],
) {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("finalized");
  const transaction = new VersionedTransaction(
    new TransactionMessage({
      payerKey: wallet,
      recentBlockhash: blockhash,
      instructions: withComputeBudget(instructions),
    }).compileToV0Message(),
  );
  if (additionalSigners.length) transaction.sign(additionalSigners);
  const response = await sign(transaction.serialize());
  // Some WalletConnect connectors return only the 64-byte Ed25519 signature.
  let signed: VersionedTransaction;
  if (response.length === 64) {
    transaction.addSignature(wallet, response);
    signed = transaction;
  } else {
    signed = VersionedTransaction.deserialize(response);
  }
  assertSameIntent(transaction.message, signed.message);
  // The wallet may have changed fee instructions or rebuilt the message with only its own
  // signature: additional signers sign the message actually being sent.
  if (additionalSigners.length) signed.sign(additionalSigners);
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
