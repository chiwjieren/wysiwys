import * as anchorNs from "@anchor-lang/core";
import type { Idl } from "@anchor-lang/core";
import * as sqds from "@sqds/multisig";
import { Keypair, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { decodeVaultTransaction } from "@wysiwys/decoder";
import idlJson from "@wysiwys/shared/idl/wysiwys_guard.json" with { type: "json" };
import { policyChangePda, txIndexSeed } from "@wysiwys/shared";

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
export type TokenInfo = { mint: string; symbol: string; decimals: number };
export type GuardedGroup = { multisig: string; programId: string; executorPda: string; vaultIndex: number; guardReady: true; token?: TokenInfo };
/** GuardConfig values for new treasuries, from deployments/devnet.json `guard` (same strings). */
export type GuardSetup = {
  forwarderProgram: string;
  forwarderState: string;
  policyHash: string;
  workflowOwner: string;
  maxReviewLifetime: string;
  reviewDeadlineSecs: string;
};
export type PreparedGroup = Omit<GuardedGroup, "guardReady"> & { guardReady: false; instruction: TransactionInstruction };
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

export function createSettlement(o: { connection: Connection; programId: PublicKey; guardSetup?: GuardSetup | null; token?: TokenInfo | null }) {
  const { connection, programId } = o;
  const token = o.token ?? undefined;
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

  const CONFIG_TX_DISCRIMINATOR = Buffer.from([94, 8, 4, 35, 113, 139, 139, 112]);

  /**
   * guarded_config_execute for a voted Squads config transaction (membership, threshold, time lock).
   * The guard checks every action on chain; the member pays any rent from resizing the multisig.
   */
  async function guardedConfigExecute(input: unknown): Promise<TransactionInstruction> {
    const { multisig, txIndex, member } = parseIds(input);
    await requireGuarded(multisig);
    const { vaultTransaction: configTransaction, proposal } = squadsAccounts(multisig, txIndex);
    const info = await connection.getAccountInfo(configTransaction, "confirmed");
    if (!info || !info.owner.equals(sqds.PROGRAM_ID) || !info.data.subarray(0, 8).equals(CONFIG_TX_DISCRIMINATOR)) {
      throw new SettlementError(409, "not a config transaction");
    }
    return program.methods
      .guardedConfigExecute()
      .accountsPartial({
        config: configPda(multisig), multisig, proposal, configTransaction, executor: executorPda(multisig),
        rentPayer: member, squadsProgram: sqds.PROGRAM_ID, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
  }

  /**
   * apply_policy_change for a Squads proposal whose only instruction is the policy change marker. The guard
   * checks the vote, the waiting period, staleness and the expected current hash; the member pays the
   * PolicyChange record's rent.
   */
  async function applyPolicyChange(input: unknown): Promise<TransactionInstruction> {
    const { multisig, txIndex, member } = parseIds(input);
    await requireGuarded(multisig);
    const { vaultTransaction, proposal } = squadsAccounts(multisig, txIndex);
    return program.methods
      .applyPolicyChange()
      .accountsPartial({
        config: configPda(multisig), multisig, proposal, vaultTransaction,
        policyChange: policyChangePda(programId, multisig, txIndex), payer: member, systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /** The treasury's current policy hash (hex) from its GuardConfig, or null when it has none. */
  async function currentPolicyHash(multisig: string): Promise<string | null> {
    let ms: PublicKey;
    try {
      ms = new PublicKey(multisig);
    } catch {
      return null;
    }
    const info = await connection.getAccountInfo(configPda(ms), "confirmed");
    if (!info || !info.owner.equals(programId)) return null;
    // anchor.Program camel-cases IDL names.
    const config = program.coder.accounts.decode("guardConfig", info.data) as { policyHash: number[] };
    return Buffer.from(config.policyHash).toString("hex");
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
    return {
      multisig: ms.toBase58(), programId: programId.toBase58(), executorPda: executorPda(ms).toBase58(), vaultIndex: 0, guardReady: true,
      ...(token ? { token } : {}),
    };
  }

  /**
   * initialize_guard for a treasury the creator is about to make in the same transaction as
   * multisigCreateV2 (the guard checks the create key, the multisig PDA and that the executor PDA is the
   * only Execute member). Uses this deployment's guard values, so every guarded treasury shares the
   * forwarder, workflow owner and policy commitment.
   */
  async function prepareGuardedGroup(input: unknown): Promise<PreparedGroup> {
    if (!o.guardSetup) throw new SettlementError(503, "guard values are not configured on the runner");
    const i = (input ?? {}) as Record<string, unknown>;
    let ms: PublicKey, creator: PublicKey, createKey: PublicKey;
    try {
      ms = new PublicKey(String(i.multisig));
      creator = new PublicKey(String(i.creator));
      createKey = new PublicKey(String(i.createKey));
    } catch {
      throw new SettlementError(400, "invalid identifiers: expected { multisig, creator, createKey }");
    }
    if (!sqds.getMultisigPda({ createKey })[0].equals(ms)) throw new SettlementError(400, "multisig is not derived from this create key");
    if (await connection.getAccountInfo(configPda(ms), "confirmed")) throw new SettlementError(409, "guard config already exists for this multisig");
    const g = o.guardSetup;
    // A creator-chosen policy (stored and checked by the server route) or the deployment's default.
    const policyHash = typeof i.policyHash === "string" ? i.policyHash : g.policyHash;
    const hex = (s: string, n: number) => {
      const b = Buffer.from(s.replace(/^0x/, ""), "hex");
      if (b.length !== n) throw new SettlementError(503, "guard values are malformed on the runner");
      return Array.from(b);
    };
    const instruction = await program.methods
      .initializeGuard(
        new PublicKey(g.forwarderProgram),
        new PublicKey(g.forwarderState),
        hex(policyHash, 32),
        hex(g.workflowOwner, 20),
        new anchor.BN(g.maxReviewLifetime),
        new anchor.BN(g.reviewDeadlineSecs),
      )
      .accountsPartial({ multisig: ms, createKey, config: configPda(ms), executor: executorPda(ms), payer: creator })
      .instruction();
    return {
      multisig: ms.toBase58(), programId: programId.toBase58(), executorPda: executorPda(ms).toBase58(), vaultIndex: 0, guardReady: false,
      ...(token ? { token } : {}),
      instruction,
    };
  }

  return { requestReview, guardedExecute, guardedConfigExecute, applyPolicyChange, currentPolicyHash, destinationOf, guardedGroup, prepareGuardedGroup };
}

export type Settlement = ReturnType<typeof createSettlement>;
