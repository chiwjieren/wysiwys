import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as anchor from "@anchor-lang/core";
import * as sqds from "@sqds/multisig";
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, NONCE_ACCOUNT_LENGTH, PublicKey, SystemProgram,
  Transaction, TransactionMessage, type TransactionInstruction,
} from "@solana/web3.js";
import {
  AuthorityType, TOKEN_PROGRAM_ID, createInitializeAccount3Instruction, createSetAuthorityInstruction,
  createTransferCheckedInstruction, getAccount,
} from "@solana/spl-token";
import { ReviewReason, txIndexSeed } from "@wysiwys/shared";
import idlJson from "../../packages/shared/idl/wysiwys_guard.json";
import { createSettlement, SettlementError } from "../../services/runner/src/settlement";
import type { Deployment } from "./bootstrap";
import { reviewPayment, type Policy } from "./local-review";
import { mockForwarderReportInstruction } from "./mock-forwarder";

// End-to-end scenarios shared by tests/e2e.ts (local validator) and scripts/e2e-devnet.ts (devnet).
// Flow per scenario: propose (+ request_review from the runner's builder) -> stand-in review delivered
// through the mock forwarder -> 3 votes -> guarded_execute from the runner's builder.

export const SCENARIOS = ["clean", "lookalike", "drift", "overCap", "ownershipSwap", "durableNonce"] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

const MUSD = (n: number) => BigInt(n) * 10n ** 6n;

export const EXPECTED: Record<ScenarioName, { describe: string; review: "approved" | "rejected"; reason: number; executed: boolean; error?: RegExp; amount: bigint }> = {
  clean: { describe: "whitelisted payment is approved, voted 3 of 3 and paid", review: "approved", reason: ReviewReason.WITHIN_POLICY, executed: true, amount: MUSD(250) },
  lookalike: { describe: "lookalike destination is rejected and never paid", review: "rejected", reason: ReviewReason.DESTINATION_NOT_WHITELISTED, executed: false, error: /not approved/, amount: MUSD(250) },
  drift: { describe: "hidden SetAuthority + nonce advance is rejected and never paid", review: "rejected", reason: ReviewReason.AUTHORITY_CHANGE_BLOCKED, executed: false, error: /not approved/, amount: MUSD(1) },
  overCap: { describe: "amount over the per-payment cap is rejected", review: "rejected", reason: ReviewReason.AMOUNT_OVER_CAP, executed: false, error: /not approved/, amount: MUSD(200_000) },
  ownershipSwap: { describe: "destination owner changed after approval: execution refused", review: "approved", reason: ReviewReason.WITHIN_POLICY, executed: false, error: /DestinationChanged/, amount: MUSD(10) },
  durableNonce: { describe: "guarded_execute in a durable-nonce transaction is refused, then a normal one pays", review: "approved", reason: ReviewReason.WITHIN_POLICY, executed: true, error: /DurableNonceDetected/, amount: MUSD(5) },
};

export type E2eContext = {
  connection: Connection;
  payer: Keypair;
  deployment: Deployment;
  signers: Keypair[];
  recipient: Keypair;
  policy: Policy;
  decoderVersion: string;
  workflowOwner: Uint8Array;
  log: (line: string) => void;
  recipientBalance: () => Promise<bigint>;
};

export type Outcome = {
  name: ScenarioName;
  txIndex: string;
  reviewStatus: string;
  reason: number | null;
  executed: boolean;
  summary?: string;
  reportError?: string;
  executeError?: string;
  signatures: Record<string, string>;
  matches: boolean;
};

const loadKey = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));

export function loadE2eContext(o: {
  connection: Connection;
  payer: Keypair;
  keysDir: string;
  deployment: Deployment;
  policy: Policy;
  decoderVersion: string;
  log?: (line: string) => void;
}): E2eContext {
  if (!o.deployment.guard) throw new Error("deployment has no guard config");
  const signers = [1, 2, 3].map((i) => loadKey(join(o.keysDir, `signer-${i}.json`)));
  if (signers.map((s) => s.publicKey.toBase58()).join() !== o.deployment.signers.join()) {
    throw new Error("e2e needs the generated signer keys of this treasury (keys/signer-1..3.json)");
  }
  const recipient = loadKey(join(o.keysDir, "recipient.json"));
  return {
    connection: o.connection,
    payer: o.payer,
    deployment: o.deployment,
    signers,
    recipient,
    policy: o.policy,
    decoderVersion: o.decoderVersion,
    workflowOwner: Uint8Array.from(Buffer.from(o.deployment.guard.workflowOwner, "hex")),
    log: o.log ?? console.log,
    recipientBalance: async () =>
      (await getAccount(o.connection, new PublicKey(o.deployment.recipients.whitelisted.tokenAccount), "confirmed")).amount,
  };
}

async function send(connection: Connection, ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: signers[0]!.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  tx.sign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize());
  const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(res.value.err)}`);
  return sig;
}

const errorText = (e: unknown) => {
  const logs = (e as { logs?: string[]; transactionLogs?: string[] })?.logs ?? (e as { transactionLogs?: string[] })?.transactionLogs ?? [];
  return [e instanceof Error ? e.message : String(e), ...logs].join("\n");
};

/** Keeps fee payers funded (devnet airdrops are unreliable). */
async function fund(ctx: E2eContext, keys: PublicKey[]) {
  const ixs: TransactionInstruction[] = [];
  for (const k of keys) {
    if ((await ctx.connection.getBalance(k, "confirmed")) < 0.05 * LAMPORTS_PER_SOL) {
      ixs.push(SystemProgram.transfer({ fromPubkey: ctx.payer.publicKey, toPubkey: k, lamports: 0.1 * LAMPORTS_PER_SOL }));
    }
  }
  if (ixs.length) await send(ctx.connection, ixs, [ctx.payer]);
}

/** Steps 1 and 2: store the scenario's payment in Squads and request its review (one transaction, as the app does). */
export async function proposeScenario(ctx: E2eContext, name: ScenarioName) {
  const { connection, deployment: d } = ctx;
  const expected = EXPECTED[name];
  const multisigPda = new PublicKey(d.multisig);
  const vault = new PublicKey(d.vault);
  const programId = new PublicKey(d.programId);
  const mint = new PublicKey(d.mint);
  const member = ctx.signers[0]!;
  const settlement = createSettlement({ connection, programId });
  const signatures: Record<string, string> = {};
  await fund(ctx, [...ctx.signers.map((s) => s.publicKey), ctx.recipient.publicKey]);

  // 1. The payment the proposer stores in Squads.
  const transfer = (destination: PublicKey, amount: bigint) =>
    createTransferCheckedInstruction(new PublicKey(d.vaultTokenAccount), mint, destination, vault, amount, d.token.decimals);
  let ownershipAccount: Keypair | null = null;
  let ixs: TransactionInstruction[];
  switch (name) {
    case "clean":
    case "overCap":
    case "durableNonce":
      ixs = [transfer(new PublicKey(d.recipients.whitelisted.tokenAccount), expected.amount)];
      break;
    case "lookalike":
      ixs = [transfer(new PublicKey(d.recipients.lookalike.tokenAccount), expected.amount)];
      break;
    case "drift":
      ixs = [
        transfer(new PublicKey(d.recipients.whitelisted.tokenAccount), expected.amount),
        createSetAuthorityInstruction(new PublicKey(d.vaultTokenAccount), vault, AuthorityType.AccountOwner, Keypair.generate().publicKey),
        SystemProgram.nonceAdvance({ noncePubkey: Keypair.generate().publicKey, authorizedPubkey: vault }),
      ];
      break;
    case "ownershipSwap": {
      // A fresh (non-ATA) token account owned by the whitelisted wallet, so the swap never touches the demo ATA.
      ownershipAccount = Keypair.generate();
      signatures.tokenAccount = await send(
        connection,
        [
          SystemProgram.createAccount({
            fromPubkey: ctx.payer.publicKey, newAccountPubkey: ownershipAccount.publicKey, space: 165,
            lamports: await connection.getMinimumBalanceForRentExemption(165), programId: TOKEN_PROGRAM_ID,
          }),
          createInitializeAccount3Instruction(ownershipAccount.publicKey, mint, ctx.recipient.publicKey),
        ],
        [ctx.payer, ownershipAccount],
      );
      ixs = [transfer(ownershipAccount.publicKey, expected.amount)];
      break;
    }
  }

  // 2. Propose + request_review in one transaction, as the app does.
  const ms = await sqds.accounts.Multisig.fromAccountAddress(connection, multisigPda, "confirmed");
  const txIndex = BigInt(ms.transactionIndex.toString()) + 1n;
  const ids = { multisig: d.multisig, txIndex: txIndex.toString(), member: member.publicKey.toBase58() };
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  signatures.propose = await send(
    connection,
    [
      sqds.instructions.vaultTransactionCreate({
        multisigPda, transactionIndex: txIndex, creator: member.publicKey, rentPayer: member.publicKey, vaultIndex: 0,
        ephemeralSigners: 0, transactionMessage: new TransactionMessage({ payerKey: vault, recentBlockhash: blockhash, instructions: ixs }),
      }),
      sqds.instructions.proposalCreate({ multisigPda, transactionIndex: txIndex, creator: member.publicKey, rentPayer: member.publicKey }),
      await settlement.requestReview(ids),
    ],
    [member],
  );
  const reviewPda = PublicKey.findProgramAddressSync([Buffer.from("review"), multisigPda.toBuffer(), txIndexSeed(txIndex)], programId)[0];

  return { txIndex, ids, reviewPda, signatures, ownershipAccount, settlement };
}

export async function runScenario(ctx: E2eContext, name: ScenarioName): Promise<Outcome> {
  const { connection, deployment: d } = ctx;
  const expected = EXPECTED[name];
  const multisigPda = new PublicKey(d.multisig);
  const vault = new PublicKey(d.vault);
  const programId = new PublicKey(d.programId);
  const member = ctx.signers[0]!;
  const program = new anchor.Program(
    { ...(idlJson as anchor.Idl), address: d.programId },
    new anchor.AnchorProvider(connection, new anchor.Wallet(ctx.payer), { commitment: "confirmed" }),
  );
  const { txIndex, ids, reviewPda, signatures, ownershipAccount, settlement } = await proposeScenario(ctx, name);

  // 3. Review (stand-in for CRE) delivered through the mock forwarder.
  const outcome: Outcome = { name, txIndex: txIndex.toString(), reviewStatus: "pending", reason: null, executed: false, signatures, matches: false };
  const verdict = await reviewPayment({ connection, multisig: multisigPda, txIndex, vault, policy: ctx.policy, decoderVersion: ctx.decoderVersion });
  outcome.summary = verdict.summary;
  try {
    signatures.report = await send(
      connection,
      [
        mockForwarderReportInstruction({
          forwarderProgram: new PublicKey(d.guard!.forwarderProgram),
          forwarderState: new PublicKey(d.guard!.forwarderState),
          transmitter: ctx.payer.publicKey,
          receiverProgram: programId,
          receiverAccounts: [{ pubkey: new PublicKey(d.configPda), isWritable: false }, { pubkey: reviewPda, isWritable: true }],
          payload: verdict.payload,
          workflowOwner: ctx.workflowOwner,
        }),
      ],
      [ctx.payer],
    );
  } catch (e) {
    outcome.reportError = errorText(e);
  }

  // 4. Three human votes.
  for (const [i, s] of ctx.signers.entries()) {
    signatures[`vote${i + 1}`] = await send(connection, [sqds.instructions.proposalApprove({ multisigPda, transactionIndex: txIndex, member: s.publicKey })], [s]);
  }

  // 5. Scenario-specific tampering, then execute with the runner's guarded_execute.
  if (name === "ownershipSwap") {
    signatures.swap = await send(
      connection,
      [createSetAuthorityInstruction(ownershipAccount!.publicKey, ctx.recipient.publicKey, AuthorityType.AccountOwner, Keypair.generate().publicKey)],
      [ctx.payer, ctx.recipient],
    );
  }
  const budget = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  try {
    const exec = await settlement.guardedExecute(ids);
    if (name === "durableNonce") {
      const nonce = Keypair.generate();
      await send(
        connection,
        SystemProgram.createNonceAccount({
          fromPubkey: ctx.payer.publicKey, noncePubkey: nonce.publicKey, authorizedPubkey: ctx.payer.publicKey,
          lamports: await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH),
        }).instructions,
        [ctx.payer, nonce],
      );
      const { nonce: value } = (await connection.getNonce(nonce.publicKey, "confirmed"))!;
      const tx = new Transaction({
        feePayer: ctx.payer.publicKey,
        nonceInfo: { nonce: value, nonceInstruction: SystemProgram.nonceAdvance({ noncePubkey: nonce.publicKey, authorizedPubkey: ctx.payer.publicKey }) },
      }).add(budget, exec);
      tx.sign(ctx.payer);
      try {
        await connection.sendRawTransaction(tx.serialize());
      } catch (e) {
        outcome.executeError = errorText(e);
      }
    }
    signatures.execute = await send(connection, [budget, exec], [member]);
  } catch (e) {
    outcome.executeError ??= e instanceof SettlementError ? e.message : errorText(e);
  }

  const r = await (program.account as any).review.fetch(reviewPda, "confirmed");
  outcome.reviewStatus = Object.keys(r.status)[0]!;
  outcome.reason = outcome.reviewStatus === "pending" ? null : r.reason;
  outcome.executed = outcome.reviewStatus === "executed";
  const reviewed = outcome.executed ? "approved" : outcome.reviewStatus;
  outcome.matches =
    !outcome.reportError &&
    reviewed === expected.review &&
    outcome.reason === expected.reason &&
    outcome.executed === expected.executed &&
    (!expected.error || expected.error.test(outcome.executeError ?? ""));
  ctx.log(`[e2e] ${name}: review ${outcome.reviewStatus} (reason ${outcome.reason}), executed ${outcome.executed}${outcome.matches ? "" : "  <-- UNEXPECTED"}`);
  return outcome;
}
