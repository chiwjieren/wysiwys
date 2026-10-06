import * as multisig from "@sqds/multisig";
import {
  AccountMeta, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
  TransactionInstruction, TransactionMessage,
} from "@solana/web3.js";
import {
  AuthorityType, createMint, createSetAuthorityInstruction, createTransferCheckedInstruction,
  getOrCreateAssociatedTokenAccount, mintTo,
} from "@solana/spl-token";
import { SEEDS } from "@omnicounter/shared";

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

  const humanPerms = opts.humanExecute
    ? Permissions.fromPermissions([Permission.Initiate, Permission.Vote, Permission.Execute])
    : Permissions.fromPermissions([Permission.Initiate, Permission.Vote]);
  const squadMembers = members.map((m, i) => ({
    key: m.publicKey,
    permissions: i === 0 ? humanPerms : Permissions.fromPermissions([Permission.Initiate, Permission.Vote]),
  }));
  const executorMode = opts.executor ?? "execute-only";
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
  const mint = await createMint(connection, payer, payer.publicKey, null, USDC_DECIMALS);
  const vaultAta = (await getOrCreateAssociatedTokenAccount(connection, payer, mint, vaultPda, true)).address;
  await mintTo(connection, payer, mint, vaultAta, payer, usdc(2_000_000));

  const counterparty = Keypair.generate();
  const counterpartyAta = (await getOrCreateAssociatedTokenAccount(connection, payer, mint, counterparty.publicKey)).address;
  const lookalike = Keypair.generate();
  const lookalikeAta = (await getOrCreateAssociatedTokenAccount(connection, payer, mint, lookalike.publicKey)).address;

  return { createKey, multisigPda, vaultPda, executorPda, members, mint, vaultAta, counterparty, counterpartyAta, lookalike, lookalikeAta };
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
