import test from "node:test";
import assert from "node:assert/strict";
import * as sqds from "@sqds/multisig";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, decodeTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { parseAmount, buildVaultDeposit, buildThresholdChange } from "../src/lib/squads/governance";

const member = Keypair.generate().publicKey;
const multisig = Keypair.generate().publicKey;
const vault = sqds.getVaultPda({ multisigPda: multisig, index: 0 })[0];
const mint = Keypair.generate().publicKey;
const squad = { members: [{ key: member, permissions: { mask: 3 } }], threshold: 1, transactionIndex: 0, configAuthority: SystemProgram.programId };
test("deposit amounts use exact base units and reject zero, overflow and excessive precision", () => {
  assert.equal(parseAmount("500000.123456", 6), 500000123456n);
  for (const input of ["0", "-1", "1e3", "1.0000001", "18446744073709551616"]) assert.throws(() => parseAmount(input, 6));
});
test("SOL deposits pay from the member into the derived vault", () => {
  const [ix] = buildVaultDeposit({ member, vault, amount: 10n });
  assert.ok(ix.programId.equals(SystemProgram.programId));
  assert.ok(ix.keys[0].pubkey.equals(member));
  assert.ok(ix.keys[1].pubkey.equals(vault));
});
test("SPL deposits initialize the vault ATA and transfer the exact amount with wallet authority", () => {
  const source = getAssociatedTokenAddressSync(mint, member);
  const instructions = buildVaultDeposit({ member, vault, amount: 1234567n, token: { mint, source, decimals: 6 } });
  assert.equal(instructions.length, 2);
  const decoded = decodeTransferCheckedInstruction(instructions[1], TOKEN_PROGRAM_ID);
  assert.equal(decoded.data.amount, 1234567n);
  assert.ok(decoded.keys.owner.pubkey.equals(member));
  assert.ok(decoded.keys.destination.pubkey.equals(getAssociatedTokenAddressSync(mint, vault, true)));
});
test("threshold configuration uses SDK governance without granting human Execute permission", () => {
  const another = Keypair.generate().publicKey;
  const voters = { ...squad, members: [...squad.members, { key: another, permissions: { mask: 3 } }] };
  const instructions = buildThresholdChange({ squad: voters, multisig, member, threshold: 2 });
  assert.equal(instructions.length, 2);
  assert.ok(instructions.every((i) => i.programId.equals(sqds.PROGRAM_ID)));
  assert.deepEqual(Array.from(instructions[0].data.subarray(0, 8)), sqds.generated.configTransactionCreateInstructionDiscriminator);
  assert.throws(() => buildThresholdChange({ squad: voters, multisig, member, threshold: 0 }));
  assert.throws(() => buildThresholdChange({ squad: voters, multisig, member, threshold: 3 }));
  assert.throws(() => buildThresholdChange({ squad: voters, multisig, member: Keypair.generate().publicKey, threshold: 2 }));
  assert.equal(buildThresholdChange({ squad: { ...voters, configAuthority: member }, multisig, member, threshold: 2 }).length, 1);
  assert.throws(() => buildThresholdChange({ squad: { ...voters, configAuthority: another }, multisig, member, threshold: 2 }));
});
