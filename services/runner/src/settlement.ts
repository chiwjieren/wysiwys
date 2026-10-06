import * as anchorNs from "@anchor-lang/core";
import type { Idl } from "@anchor-lang/core";
import * as sqds from "@sqds/multisig";
import { Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { decodeVaultTransaction } from "@wysiwys/decoder";
import idlJson from "@wysiwys/shared/idl/wysiwys_guard.json" with { type: "json" };
import { txIndexSeed } from "@wysiwys/shared";

// Builds the guard instructions the app asks for. The app validates them again and the member signs;
// the guard and Squads enforce every rule on chain, so a wrong instruction can only fail, not pay.

// CommonJS package: under ESM the API sits on `default`, under CJS (root mocha tests) on the namespace.
const anchor = ((anchorNs as any).default ?? anchorNs) as typeof anchorNs;

export class SettlementError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type WireInstruction = { programId: string; keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
export type Ids = { multisig: string; txIndex: string; member: string };
export type GuardedGroup = { multisig: string; programId: string; executorPda: string; vaultIndex: number; guardReady: true };
export type Destination = { kind: "sol" | "spl"; destination: string };

export function toWire(ix: TransactionInstruction): WireInstruction {
  return {
    programId: ix.programId.toBase58(),
    keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
    data: Buffer.from(ix.data).toString("base64"),
  };
}

const U64_MAX = 18446744073709551615n;

/** Strict identifier parsing; anything else is a 400. */
export function parseIds(input: unknown): { multisig: PublicKey; txIndex: bigint; member: PublicKey } {
  const o = (input ?? {}) as Record<string, unknown>;
  try {
    if (typeof o.multisig !== "string" || typeof o.member !== "string") throw new Error();
    const txIndex = typeof o.txIndex === "string" && /^\d{1,20}$/.test(o.txIndex) ? BigInt(o.txIndex) : -1n;
    if (txIndex < 1n || txIndex > U64_MAX) throw new Error();
    return { multisig: new PublicKey(o.multisig), txIndex, member: new PublicKey(o.member) };
  } catch {
    throw new SettlementError(400, "invalid identifiers: expected { multisig, txIndex, member }");
  }
}

export function createSettlement(o: { connection: Connection; programId: PublicKey }) {
  const { connection, programId } = o;
  // Read-only provider: instructions are built here and signed by the member's wallet in the app.
  const wallet = new anchor.Wallet(Keypair.generate());
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "finalized" });
  const program = new anchor.Program({ ...(idlJson as Idl), address: programId.toBase58() }, provider);

  const pda = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
  const configPda = (ms: PublicKey) => pda([Buffer.from("config"), ms.toBuffer()]);
  const executorPda = (ms: PublicKey) => pda([Buffer.from("executor"), ms.toBuffer()]);
  const reviewPda = (ms: PublicKey, i: bigint) => pda([Buffer.from("review"), ms.toBuffer(), txIndexSeed(i)]);
  const squadsAccounts = (ms: PublicKey, i: bigint) => ({
    vaultTransaction: sqds.getTransactionPda({ multisigPda: ms, index: i })[0],
    proposal: sqds.getProposalPda({ multisigPda: ms, transactionIndex: i })[0],
  });

  async function requireGuarded(ms: PublicKey) {
    const info = await connection.getAccountInfo(configPda(ms), "confirmed");
    if (!info || !info.owner.equals(programId)) throw new SettlementError(404, "multisig has no guard config");
  }

  /** request_review for a proposal that the same transaction creates (PDAs only, no reads of it). */
  async function requestReview(input: unknown): Promise<TransactionInstruction> {
    const { multisig, txIndex, member } = parseIds(input);
    await requireGuarded(multisig);
    const { vaultTransaction, proposal } = squadsAccounts(multisig, txIndex);
    return program.methods
      .requestReview()
      .accountsPartial({ multisig, vaultTransaction, proposal, review: reviewPda(multisig, txIndex), proposer: member, payer: member })
      .instruction();
  }

  /** The single payment in a stored vault transaction, or a 409. */
  async function destinationOf(multisig: string, txIndex: string): Promise<Destination> {
    const ms = new PublicKey(multisig);
    const { vaultTransaction } = squadsAccounts(ms, BigInt(txIndex));
    const info = await connection.getAccountInfo(vaultTransaction, "confirmed");
    if (!info) throw new SettlementError(404, "vault transaction not found");
    const decoded = decodeVaultTransaction(info.data);
    const only = decoded.status === "success" && decoded.actions.length === 1 ? decoded.actions[0] : null;
    if (only?.kind === "token.transferChecked") return { kind: "spl", destination: only.destinationTokenAccount };
    if (only?.kind === "system.transfer") return { kind: "sol", destination: only.destination };
    throw new SettlementError(409, "stored transaction is not exactly one supported payment");
  }

  /** guarded_execute for an Approved review: destination from the stored payment, Squads execute accounts. */
  async function guardedExecute(input: unknown): Promise<TransactionInstruction> {
    const { multisig, txIndex } = parseIds(input);
    await requireGuarded(multisig);
    const review = reviewPda(multisig, txIndex);
    const r = await (program.account as any).review.fetchNullable(review, "confirmed");
    if (!r || Object.keys(r.status)[0] !== "approved") throw new SettlementError(409, "review is not approved");
    const { destination } = await destinationOf(multisig.toBase58(), txIndex.toString());
    const executor = executorPda(multisig);
    const { instruction, lookupTableAccounts } = await sqds.instructions.vaultTransactionExecute({
      connection, multisigPda: multisig, transactionIndex: txIndex, member: executor,
    });
    if (lookupTableAccounts.length) throw new SettlementError(409, "address lookup tables are not supported");
    const { vaultTransaction, proposal } = squadsAccounts(multisig, txIndex);
    return program.methods
      .guardedExecute()
      .accountsPartial({
        config: configPda(multisig), review, multisig, proposal, vaultTransaction,
        destination: new PublicKey(destination), executor, squadsProgram: sqds.PROGRAM_ID, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      // Message accounts in the order Squads expects; the executor is never passed as a signer.
      .remainingAccounts(instruction.keys.slice(4).map((k) => ({ ...k, isSigner: false })))
      .instruction();
  }

  async function guardedGroup(multisig: string): Promise<GuardedGroup | null> {
    let ms: PublicKey;
    try {
      ms = new PublicKey(multisig);
    } catch {
      throw new SettlementError(400, "invalid multisig");
    }
    const info = await connection.getAccountInfo(configPda(ms), "confirmed");
    if (!info || !info.owner.equals(programId)) return null;
    return { multisig: ms.toBase58(), programId: programId.toBase58(), executorPda: executorPda(ms).toBase58(), vaultIndex: 0, guardReady: true };
  }

  return { requestReview, guardedExecute, destinationOf, guardedGroup };
}

export type Settlement = ReturnType<typeof createSettlement>;
