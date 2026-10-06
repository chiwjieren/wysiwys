import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { ACTION_KIND, ReportPayload, SEEDS, VERDICT, encodeReportMetadata, encodeReportPayload } from "@wysiwys/shared";
import type { TestForwarder } from "../../target/types/test_forwarder";
import { GuardedDesk, POLICY_HASH, WORKFLOW_OWNER, chainNow, guardProgram, payer, setupGuardedDesk } from "./guard";

export const forwarderProgram = () => anchor.workspace.testForwarder as Program<TestForwarder>;

export async function createForwarderState(): Promise<PublicKey> {
  const state = Keypair.generate();
  await forwarderProgram()
    .methods.initState()
    .accountsPartial({ state: state.publicKey, payer: payer().publicKey })
    .signers([state])
    .rpc({ commitment: "confirmed" });
  return state.publicKey;
}

export const forwarderAuthority = (state: PublicKey, seedProgram = guardProgram().programId) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.forwarder), state.toBuffer(), seedProgram.toBuffer()],
    forwarderProgram().programId,
  )[0];

export type ForwardedDesk = GuardedDesk & { forwarderState: PublicKey };

export async function setupForwardedDesk(): Promise<ForwardedDesk> {
  const forwarderState = await createForwarderState();
  const desk = await setupGuardedDesk({ forwarderProgram: forwarderProgram().programId, forwarderState });
  return { ...desk, forwarderState };
}

/**
 * Approve payload that echoes the Review's tx_hash and names the desk's counterparty token
 * account (owner counterparty, desk mint) as the SPL destination, valid for 10 minutes.
 */
export async function approvePayload(
  desk: GuardedDesk,
  review: PublicKey,
  overrides: Partial<ReportPayload> = {},
): Promise<Uint8Array> {
  const r = await guardProgram().account.review.fetch(review, "confirmed");
  const now = await chainNow(guardProgram().provider.connection);
  return encodeReportPayload({
    verdict: VERDICT.APPROVE,
    reason: 0,
    txHash: Uint8Array.from(r.txHash),
    policyHash: POLICY_HASH,
    actionKind: ACTION_KIND.SPL,
    destination: desk.counterpartyAta.toBytes(),
    destinationOwner: desk.counterparty.publicKey.toBytes(),
    mint: desk.mint.toBytes(),
    issuedAt: now,
    expiresAt: now + 600n,
    ...overrides,
  });
}

/** Keystone metadata as the forwarder passes it; the guard checks the workflow owner. */
export const reportMetadata = (workflowOwner: Uint8Array = WORKFLOW_OWNER) =>
  encodeReportMetadata({
    workflowCid: new Uint8Array(32).fill(0xaa),
    workflowName: new Uint8Array(10).fill(0xbb),
    workflowOwner,
    reportId: new Uint8Array([0, 1]),
  });

export async function deliverReport(
  desk: ForwardedDesk,
  review: PublicKey,
  payload: Uint8Array,
  opts: { state?: PublicKey; seedProgram?: PublicKey; metadata?: Uint8Array } = {},
): Promise<string> {
  const state = opts.state ?? desk.forwarderState;
  const seedProgram = opts.seedProgram ?? guardProgram().programId;
  return forwarderProgram()
    .methods.forward(seedProgram, Buffer.from(opts.metadata ?? reportMetadata()), Buffer.from(payload))
    .accountsPartial({ state, authority: forwarderAuthority(state, seedProgram), receiverProgram: guardProgram().programId })
    .remainingAccounts([
      { pubkey: desk.config, isSigner: false, isWritable: false },
      { pubkey: review, isSigner: false, isWritable: true },
    ])
    .rpc({ commitment: "confirmed" });
}
