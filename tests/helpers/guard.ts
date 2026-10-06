import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { expect } from "chai";
import { SEEDS, txIndexSeed } from "@omnicounter/shared";
import type { OmnicounterGuard } from "../../target/types/omnicounter_guard";
import { createDesk, DeskFixture, DeskOptions } from "./squads";

export const provider = () => anchor.getProvider() as anchor.AnchorProvider;
export const payer = () => (provider().wallet as anchor.Wallet).payer as Keypair;
export const guardProgram = () => anchor.workspace.omnicounterGuard as Program<OmnicounterGuard>;

export const POLICY_HASH = new Uint8Array(32).fill(7);
export const randomHash = () => crypto.getRandomValues(new Uint8Array(32));

export const configPda = (multisig: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from(SEEDS.config), multisig.toBuffer()], guardProgram().programId)[0];
export const reviewPda = (multisig: PublicKey, txIndex: bigint) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.review), multisig.toBuffer(), Buffer.from(txIndexSeed(txIndex))],
    guardProgram().programId,
  )[0];
export const executorPda = (multisig: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from(SEEDS.executor), multisig.toBuffer()], guardProgram().programId)[0];

export async function expectError(p: Promise<unknown>, ...names: string[]) {
  let err: any;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  if (!err) expect.fail(`expected failure with one of: ${names.join(", ")}`);
  const text = [String(err), JSON.stringify(err.logs ?? err.transactionLogs ?? []), err.error?.errorCode?.code ?? ""].join("\n");
  expect(names.some((n) => text.includes(n)), `expected ${names.join("|")}, got:\n${text}`).to.equal(true);
}

/** Validator clock (unix_timestamp is at offset 32 of the Clock sysvar). */
export async function chainNow(connection: Connection): Promise<bigint> {
  const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed");
  return info!.data.readBigInt64LE(32);
}

export async function guardEvents(sig: string): Promise<{ name: string; data: any }[]> {
  const program = guardProgram();
  const tx = await program.provider.connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const parser = new anchor.EventParser(program.programId, new anchor.BorshCoder(program.idl));
  return [...parser.parseLogs(tx!.meta!.logMessages!)];
}

export const statusOf = (review: { status: object }) => Object.keys(review.status)[0];

export type GuardedDesk = DeskFixture & { config: PublicKey };

export async function setupGuardedDesk(
  opts: { forwarderProgram?: PublicKey; forwarderState?: PublicKey; desk?: DeskOptions } = {},
): Promise<GuardedDesk> {
  const desk = await createDesk(provider().connection, payer(), guardProgram().programId, opts.desk);
  const config = configPda(desk.multisigPda);
  await guardProgram()
    .methods.initializeGuard(
      opts.forwarderProgram ?? Keypair.generate().publicKey,
      opts.forwarderState ?? Keypair.generate().publicKey,
      Array.from(POLICY_HASH),
    )
    .accountsPartial({
      multisig: desk.multisigPda,
      createKey: desk.createKey.publicKey,
      config,
      executor: desk.executorPda,
      payer: payer().publicKey,
    })
    .signers([desk.createKey])
    .rpc({ commitment: "confirmed" });
  return { ...desk, config };
}
