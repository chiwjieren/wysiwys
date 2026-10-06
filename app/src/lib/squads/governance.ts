import * as sqds from "@sqds/multisig";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";

export function parseAmount(value: string, decimals: number) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255 || !/^\d+(\.\d+)?$/.test(value)) throw new Error("Enter a positive decimal amount.");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error(`This asset supports ${decimals} decimal places.`);
  const amount = BigInt(whole + fraction.padEnd(decimals, "0"));
  if (amount < 1n || amount > 18446744073709551615n) throw new Error("Amount is outside the supported range.");
  return amount;
}
export function buildVaultDeposit({ member, vault, amount, token }: {
  member: PublicKey; vault: PublicKey; amount: bigint;
  token?: { mint: PublicKey; source: PublicKey; decimals: number };
}) {
  if (amount < 1n || amount > 18446744073709551615n || member.equals(vault)) throw new Error("Invalid deposit.");
  if (!token) return [SystemProgram.transfer({ fromPubkey: member, toPubkey: vault, lamports: amount })];
  const destination = getAssociatedTokenAddressSync(token.mint, vault, true);
  return [
    createAssociatedTokenAccountIdempotentInstruction(member, destination, vault, token.mint),
    createTransferCheckedInstruction(token.source, token.mint, destination, member, amount, token.decimals),
  ];
}
export function buildThresholdChange({ squad, multisig, member, threshold }: {
  squad: Pick<sqds.accounts.Multisig, "members" | "threshold" | "transactionIndex" | "configAuthority">;
  multisig: PublicKey; member: PublicKey; threshold: number;
}) {
  const voters = squad.members.filter((m) => sqds.types.Permissions.has(m.permissions, sqds.types.Permission.Vote)).length;
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > voters || threshold === squad.threshold) throw new Error("Choose a different threshold between 1 and the number of voters.");
  if (!squad.configAuthority.equals(SystemProgram.programId)) {
    if (!squad.configAuthority.equals(member)) throw new Error("Only the on-chain configuration authority can set this threshold.");
    return [sqds.instructions.multisigChangeThreshold({ multisigPda: multisig, configAuthority: member, rentPayer: member, newThreshold: threshold })];
  }
  const membership = squad.members.find((m) => m.key.equals(member));
  if (!membership || !sqds.types.Permissions.has(membership.permissions, sqds.types.Permission.Initiate)) throw new Error("Your wallet cannot propose configuration changes.");
  const index = BigInt(squad.transactionIndex.toString()) + 1n;
  return [
    sqds.instructions.configTransactionCreate({ multisigPda: multisig, transactionIndex: index, creator: member, rentPayer: member, actions: [{ __kind: "ChangeThreshold", newThreshold: threshold }] }),
    sqds.instructions.proposalCreate({ multisigPda: multisig, transactionIndex: index, creator: member, rentPayer: member, isDraft: false }),
  ];
}
