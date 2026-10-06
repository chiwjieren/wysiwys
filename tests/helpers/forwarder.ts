import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { ReportPayload, SEEDS, VERDICT, encodeReportPayload, intentHash } from "@omnicounter/shared";
import type { TestForwarder } from "../../target/types/test_forwarder";
import { GuardedDesk, POLICY_HASH, chainNow, guardProgram, payer, setupGuardedDesk } from "./guard";

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

/** Approve payload that echoes the Review's stored hashes, valid for 10 minutes. */
export async function approvePayload(review: PublicKey, overrides: Partial<ReportPayload> = {}): Promise<Uint8Array> {
  const r = await guardProgram().account.review.fetch(review, "confirmed");
  const now = await chainNow(guardProgram().provider.connection);
  return encodeReportPayload({
    verdict: VERDICT.APPROVE,
    reason: 0,
    msgHash: Uint8Array.from(r.msgHash),
    intentHash: intentHash(Uint8Array.from(r.settlementIntentHash), Uint8Array.from(r.tradeRefHash)),
    policyHash: POLICY_HASH,
    expiresAt: now + 600n,
    ...overrides,
  });
}

export async function deliverReport(
  desk: ForwardedDesk,
  review: PublicKey,
  payload: Uint8Array,
  opts: { state?: PublicKey; seedProgram?: PublicKey } = {},
): Promise<string> {
  const state = opts.state ?? desk.forwarderState;
  const seedProgram = opts.seedProgram ?? guardProgram().programId;
  return forwarderProgram()
    .methods.forward(seedProgram, Buffer.alloc(64), Buffer.from(payload))
    .accountsPartial({ state, authority: forwarderAuthority(state, seedProgram), receiverProgram: guardProgram().programId })
    .remainingAccounts([
      { pubkey: desk.config, isSigner: false, isWritable: false },
      { pubkey: review, isSigner: false, isWritable: true },
    ])
    .rpc({ commitment: "confirmed" });
}
