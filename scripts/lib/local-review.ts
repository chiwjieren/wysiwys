import * as sqds from "@sqds/multisig";
import { PublicKey, SYSVAR_CLOCK_PUBKEY, type Connection } from "@solana/web3.js";
import { decodeVaultTransaction, type DecodedAction } from "@wysiwys/decoder";
import { ACTION_KIND, ReviewReason, VERDICT, destinationHash, encodeReportPayload, policyHash, txHash } from "@wysiwys/shared";

// Stand-in for the CRE review workflow, for end-to-end tests while the workflow is being built.
// It applies the same rules in the same order (docs/specs/guard-cre-interface.md) and produces the
// same 117-byte payload. Single reader, no RPC quorum and no Scorechain screening: not a substitute
// for the CRE workflow in the demo.

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ZERO32 = new Uint8Array(32);
const APPROVAL_SECONDS = 600n;

export type Policy = {
  version: number;
  salt: string;
  allowedMints: { mint: string; decimals: number }[];
  maxAmountPerPayment: string;
  destinationWhitelist: string[];
  [k: string]: unknown;
};

export type ReviewOutcome = { verdict: 1 | 2; reason: number; payload: Uint8Array; summary: string };

const AUTHORITY_KINDS = new Set(["token.setAuthority", "token.approve", "token.approveChecked", "system.assign", "system.authorizeNonce"]);
const NONCE_KINDS = new Set(["system.advanceNonce", "system.withdrawNonce", "system.initializeNonce"]);

async function chainNow(connection: Connection): Promise<bigint> {
  const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed");
  return info!.data.readBigInt64LE(32);
}

/** Reads the stored payment for (multisig, txIndex) and decides like the CRE workflow would. */
export async function reviewPayment(o: {
  connection: Connection;
  multisig: PublicKey;
  txIndex: bigint;
  vault: PublicKey;
  policy: Policy;
  decoderVersion: string;
}): Promise<ReviewOutcome> {
  const { connection } = o;
  const [vaultTx] = sqds.getTransactionPda({ multisigPda: o.multisig, index: o.txIndex });
  const info = await connection.getAccountInfo(vaultTx, "confirmed");
  if (!info) throw new Error(`vault transaction ${vaultTx.toBase58()} not found`);
  const hash = txHash(vaultTx.toBytes(), info.data);
  const commitment = policyHash(o.policy, o.decoderVersion);
  const issuedAt = await chainNow(connection);
  const base = { txHash: hash, policyHash: commitment, issuedAt, expiresAt: issuedAt + APPROVAL_SECONDS };
  const reject = (reason: number, summary: string): ReviewOutcome => ({
    verdict: VERDICT.REJECT,
    reason,
    summary,
    payload: encodeReportPayload({ ...base, verdict: VERDICT.REJECT, reason, actionKind: ACTION_KIND.NONE, destinationHash: ZERO32 }),
  });

  const decoded = decodeVaultTransaction(info.data);
  if (decoded.status === "unsupported") return reject(ReviewReason.UNSUPPORTED_FEATURE, decoded.error);
  if (decoded.status === "malformed") return reject(ReviewReason.UNEXPECTED_INSTRUCTION, decoded.error);
  const actions: DecodedAction[] = decoded.actions;
  if (actions.some((a) => AUTHORITY_KINDS.has(a.kind))) return reject(ReviewReason.AUTHORITY_CHANGE_BLOCKED, "authority change in payload");
  if (actions.some((a) => NONCE_KINDS.has(a.kind))) return reject(ReviewReason.DURABLE_NONCE_DETECTED, "durable nonce operation in payload");
  if (actions.length !== 1) return reject(ReviewReason.UNEXPECTED_INSTRUCTION, `expected exactly one payment, got ${actions.length} instructions`);
  const a = actions[0]!;
  const cap = BigInt(o.policy.maxAmountPerPayment);
  const whitelisted = (wallet: string) => o.policy.destinationWhitelist.includes(wallet);

  if (a.kind === "system.transfer") {
    if (a.source !== o.vault.toBase58()) return reject(ReviewReason.UNEXPECTED_INSTRUCTION, "transfer is not from the vault");
    if (BigInt(a.lamports) > cap) return reject(ReviewReason.AMOUNT_OVER_CAP, "amount over cap");
    if (!whitelisted(a.destination)) return reject(ReviewReason.DESTINATION_NOT_WHITELISTED, `${a.destination} is not whitelisted`);
    const dest = new PublicKey(a.destination);
    return approve(destinationHash(ACTION_KIND.SOL, dest.toBytes(), dest.toBytes(), ZERO32), ACTION_KIND.SOL, `pay ${a.lamports} lamports to ${a.destination}`);
  }
  if (a.kind === "token.transferChecked") {
    if (a.programId !== TOKEN_PROGRAM.toBase58()) return reject(ReviewReason.UNSUPPORTED_FEATURE, "not the legacy Token program");
    if (a.authority !== o.vault.toBase58()) return reject(ReviewReason.UNEXPECTED_INSTRUCTION, "transfer authority is not the vault");
    const mint = o.policy.allowedMints.find((m) => m.mint === a.mint);
    if (!mint || mint.decimals !== a.decimals) return reject(ReviewReason.MINT_NOT_ALLOWED, `mint ${a.mint} not allowed`);
    if (BigInt(a.amount) > cap) return reject(ReviewReason.AMOUNT_OVER_CAP, "amount over cap");
    const destKey = new PublicKey(a.destinationTokenAccount);
    const dest = await connection.getAccountInfo(destKey, "confirmed");
    if (!dest || !dest.owner.equals(TOKEN_PROGRAM) || dest.data.length !== 165 || dest.data[108] !== 1) {
      return reject(ReviewReason.DESTINATION_OWNER_UNRESOLVED, "destination is not a live legacy token account");
    }
    const destMint = new PublicKey(dest.data.subarray(0, 32));
    const owner = new PublicKey(dest.data.subarray(32, 64));
    if (destMint.toBase58() !== a.mint) return reject(ReviewReason.MINT_NOT_ALLOWED, "destination holds another mint");
    if (!whitelisted(owner.toBase58())) return reject(ReviewReason.DESTINATION_NOT_WHITELISTED, `owner ${owner.toBase58()} is not whitelisted`);
    return approve(
      destinationHash(ACTION_KIND.SPL, destKey.toBytes(), owner.toBytes(), destMint.toBytes()),
      ACTION_KIND.SPL,
      `pay ${a.amount} base units of ${a.mint} to ${owner.toBase58()}`,
    );
  }
  return reject(ReviewReason.UNEXPECTED_INSTRUCTION, `${a.kind} is not an allowed payment`);

  function approve(dh: Uint8Array, kind: 1 | 2, summary: string): ReviewOutcome {
    return {
      verdict: VERDICT.APPROVE,
      reason: ReviewReason.WITHIN_POLICY,
      summary,
      payload: encodeReportPayload({ ...base, verdict: VERDICT.APPROVE, reason: ReviewReason.WITHIN_POLICY, actionKind: kind, destinationHash: dh }),
    };
  }
}

