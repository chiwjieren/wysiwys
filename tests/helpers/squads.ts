import * as multisig from "@sqds/multisig";
import {
  AccountMeta, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, TransactionMessage,
} from "@solana/web3.js";
import {
  AuthorityType, MINT_SIZE, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction, createMintToInstruction, createSetAuthorityInstruction,
  createTransferCheckedInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { SEEDS } from "@wysiwys/shared";

export const SQUADS_PROGRAM_ID = new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
export const USDC_DECIMALS = 6;
export const usdc = (n: number) => BigInt(n) * 10n ** BigInt(USDC_DECIMALS);

const { Permission, Permissions } = multisig.types;

export type DeskOptions = {
  executor?: "execute-only" | "with-vote" | "absent";
  humanExecute?: boolean;
  configAuthority?: PublicKey;
};

export type DeskFixture = {
  createKey: Keypair;
  multisigPda: PublicKey;
  vaultPda: PublicKey;
  executorPda: PublicKey;
  members: Keypair[];
  mint: PublicKey;
  vaultAta: PublicKey;
  counterparty: Keypair;
  counterpartyAta: PublicKey;
  lookalike: Keypair;
  lookalikeAta: PublicKey;
};

export type Proposed = { transactionIndex: bigint; transactionPda: PublicKey; proposalPda: PublicKey };

export async function confirm(connection: Connection, sig: Promise<string> | string): Promise<string> {
  const s = await sig;
  await connection.confirmTransaction(s, "confirmed");
  return s;
}

/**
 * Sends with a blockhash fetched at "confirmed". web3.js's internal blockhash cache (used by the
 * spl-token convenience helpers) polls "finalized", which lags on the local validator and can hand
 * out an already expired blockhash ("Blockhash not found").
 */
export async function sendWithFreshBlockhash(
  connection: Connection,
  ixs: TransactionInstruction[],
  signers: Keypair[],
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: signers[0].publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  tx.sign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

async function airdrop(connection: Connection, to: PublicKey, sol: number) {
  await confirm(connection, connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL));
}

export async function createDesk(
  connection: Connection,
  payer: Keypair,
  guardProgramId: PublicKey,
  opts: DeskOptions = {},
): Promise<DeskFixture> {
  const createKey = Keypair.generate();
  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const [executorPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.executor), multisigPda.toBuffer()],
    guardProgramId,
  );
  const members = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  await Promise.all(members.map((m) => airdrop(connection, m.publicKey, 2)));

  // Squads requires at least one executor, so "absent" hands Execute to a human instead.
  const executorMode = opts.executor ?? "execute-only";
  const humanPerms = opts.humanExecute || executorMode === "absent"
    ? Permissions.fromPermissions([Permission.Initiate, Permission.Vote, Permission.Execute])
    : Permissions.fromPermissions([Permission.Initiate, Permission.Vote]);
  const squadMembers = members.map((m, i) => ({
    key: m.publicKey,
    permissions: i === 0 ? humanPerms : Permissions.fromPermissions([Permission.Initiate, Permission.Vote]),
  }));
  if (executorMode !== "absent") {
    squadMembers.push({
      key: executorPda,
      permissions:
        executorMode === "execute-only"
          ? Permissions.fromPermissions([Permission.Execute])
          : Permissions.fromPermissions([Permission.Vote, Permission.Execute]),
    });
  }

  const [programConfigPda] = multisig.getProgramConfigPda({});
  const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(connection, programConfigPda);
  await confirm(
    connection,
    multisig.rpc.multisigCreateV2({
      connection,
      treasury: programConfig.treasury,
      createKey,
      creator: payer,
      multisigPda,
      configAuthority: opts.configAuthority ?? null,
      threshold: 3,
      members: squadMembers,
      timeLock: 0,
      rentCollector: null,
    }),
  );

  const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });
  await airdrop(connection, vaultPda, 1);
  const mint = Keypair.generate();
  const counterparty = Keypair.generate();
  const lookalike = Keypair.generate();
  const vaultAta = getAssociatedTokenAddressSync(mint.publicKey, vaultPda, true);
  const counterpartyAta = getAssociatedTokenAddressSync(mint.publicKey, counterparty.publicKey);
  const lookalikeAta = getAssociatedTokenAddressSync(mint.publicKey, lookalike.publicKey);
  const ata = (address: PublicKey, owner: PublicKey) =>
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, address, owner, mint.publicKey);
  await sendWithFreshBlockhash(
    connection,
    [
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        space: MINT_SIZE,
        lamports: await connection.getMinimumBalanceForRentExemption(MINT_SIZE),
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(mint.publicKey, USDC_DECIMALS, payer.publicKey, null),
      ata(vaultAta, vaultPda),
      ata(counterpartyAta, counterparty.publicKey),
      ata(lookalikeAta, lookalike.publicKey),
      createMintToInstruction(mint.publicKey, vaultAta, payer.publicKey, usdc(10_000_000)),
    ],
    [payer, mint],
  );

  return { createKey, multisigPda, vaultPda, executorPda, members, mint: mint.publicKey, vaultAta, counterparty, counterpartyAta, lookalike, lookalikeAta };
}

export function payoutIxs(desk: DeskFixture, destinationAta: PublicKey, amount: bigint): TransactionInstruction[] {
  return [createTransferCheckedInstruction(desk.vaultAta, desk.mint, destinationAta, desk.vaultPda, amount, USDC_DECIMALS)];
}

/** Payout with a hidden authority takeover and nonce advance (Drift-style). Never executed. */
export function driftStyleIxs(desk: DeskFixture, amount: bigint): TransactionInstruction[] {
  const attacker = Keypair.generate().publicKey;
  return [
    ...payoutIxs(desk, desk.counterpartyAta, amount),
    createSetAuthorityInstruction(desk.vaultAta, desk.vaultPda, AuthorityType.AccountOwner, attacker),
    SystemProgram.nonceAdvance({ noncePubkey: Keypair.generate().publicKey, authorizedPubkey: desk.vaultPda }),
  ];
}

export async function proposePayout(connection: Connection, desk: DeskFixture, ixs: TransactionInstruction[]): Promise<Proposed> {
  const proposer = desk.members[0];
  const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, desk.multisigPda, "confirmed");
  const transactionIndex = BigInt(ms.transactionIndex.toString()) + 1n;
  const { blockhash } = await connection.getLatestBlockhash();
  const transactionMessage = new TransactionMessage({ payerKey: desk.vaultPda, recentBlockhash: blockhash, instructions: ixs });
  await confirm(
    connection,
    multisig.rpc.vaultTransactionCreate({
      connection, feePayer: proposer, multisigPda: desk.multisigPda, transactionIndex,
      creator: proposer.publicKey, vaultIndex: 0, ephemeralSigners: 0, transactionMessage,
    }),
  );
  await confirm(
    connection,
    multisig.rpc.proposalCreate({ connection, feePayer: proposer, creator: proposer, multisigPda: desk.multisigPda, transactionIndex }),
  );
  const [transactionPda] = multisig.getTransactionPda({ multisigPda: desk.multisigPda, index: transactionIndex });
  const [proposalPda] = multisig.getProposalPda({ multisigPda: desk.multisigPda, transactionIndex });
  return { transactionIndex, transactionPda, proposalPda };
}

export async function approve(connection: Connection, desk: DeskFixture, transactionIndex: bigint, count = 3) {
  for (const member of desk.members.slice(0, count)) {
    await confirm(
      connection,
      multisig.rpc.proposalApprove({ connection, feePayer: member, member, multisigPda: desk.multisigPda, transactionIndex }),
    );
  }
}

/** Message accounts Squads expects after [multisig, proposal, transaction, member]. */
export async function executeRemainingAccounts(
  connection: Connection,
  desk: DeskFixture,
  transactionIndex: bigint,
): Promise<AccountMeta[]> {
  const { instruction } = await multisig.instructions.vaultTransactionExecute({
    connection, multisigPda: desk.multisigPda, transactionIndex, member: desk.executorPda,
  });
  return instruction.keys.slice(4);
}
