// Votes 3 of 3 with the test treasury's generated signers and executes through the guard (runner-built
// guarded_execute). For a review that the CRE review workflow (or the stand-in) already decided.
// Usage: npx tsx scripts/finish-devnet.ts <txIndex>
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as anchor from "@anchor-lang/core";
import * as sqds from "@sqds/multisig";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import { txIndexSeed } from "@wysiwys/shared";
import idlJson from "../packages/shared/idl/wysiwys_guard.json";
import { createSettlement } from "../services/runner/src/settlement";
import type { Deployment } from "./lib/bootstrap";

const root = resolve(__dirname, "..");
try {
  process.loadEnvFile(join(root, ".env"));
} catch {
  // No .env: use the process environment.
}
const loadKey = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));

async function send(c: Connection, ixs: TransactionInstruction[], signers: Keypair[]) {
  const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: signers[0]!.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  tx.sign(...signers);
  const sig = await c.sendRawTransaction(tx.serialize());
  const r = await c.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (r.value.err) throw new Error(`${sig} failed: ${JSON.stringify(r.value.err)}`);
  return sig;
}

async function main() {
  const txIndex = BigInt(process.argv[2] ?? "");
  const env = process.env;
  const c = new Connection(env.HELIUS_DEVNET_RPC_URL || "https://api.devnet.solana.com", "confirmed");
  const d: Deployment = JSON.parse(readFileSync(resolve(root, process.env.WYSIWYS_DEPLOYMENT || "deployments/devnet.json"), "utf8"));
  const signers = [1, 2, 3].map((i) => loadKey(join(root, `keys/signer-${i}.json`)));
  const ms = new PublicKey(d.multisig);
  const programId = new PublicKey(d.programId);
  const program = new anchor.Program({ ...(idlJson as anchor.Idl), address: d.programId }, new anchor.AnchorProvider(c, new anchor.Wallet(signers[0]!), {}));
  const reviewPda = PublicKey.findProgramAddressSync([Buffer.from("review"), ms.toBuffer(), txIndexSeed(txIndex)], programId)[0];
  const status = async () => Object.keys(((await (program.account as any).review.fetch(reviewPda, "confirmed")) as any).status)[0];
  console.log(`[finish] review ${reviewPda.toBase58()}: ${await status()}`);
  const proposal = await sqds.accounts.Proposal.fromAccountAddress(c, sqds.getProposalPda({ multisigPda: ms, transactionIndex: txIndex })[0], "confirmed");
  for (const [i, s] of signers.entries()) {
    if (proposal.approved.some((k) => k.equals(s.publicKey))) continue;
    console.log(`[finish] vote ${i + 1}: ${await send(c, [sqds.instructions.proposalApprove({ multisigPda: ms, transactionIndex: txIndex, member: s.publicKey })], [s])}`);
  }
  const before = (await getAccount(c, new PublicKey(d.recipients.whitelisted.tokenAccount), "confirmed")).amount;
  const ix = await createSettlement({ connection: c, programId }).guardedExecute({ multisig: d.multisig, txIndex: txIndex.toString(), member: signers[0]!.publicKey.toBase58() });
  console.log(`[finish] guarded_execute: ${await send(c, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix], [signers[0]!])}`);
  const after = (await getAccount(c, new PublicKey(d.recipients.whitelisted.tokenAccount), "confirmed")).amount;
  console.log(`[finish] review now ${await status()}; whitelisted recipient received ${after - before} base units`);
}

main().catch((e) => {
  console.error(`[finish] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
