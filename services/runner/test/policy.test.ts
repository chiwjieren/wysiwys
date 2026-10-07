import { test } from "node:test";
import assert from "node:assert/strict";
import anchor, { type Idl } from "@anchor-lang/core";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import * as sqds from "@sqds/multisig";
import { policyChangePda } from "@wysiwys/shared";
import { createSettlement } from "../src/settlement";
import { PROGRAM_ID, idl } from "./helpers";

// apply_policy_change and the treasury's current policy hash, built against a fake connection.
const coder = new anchor.BorshCoder(idl as Idl);
const ms = Keypair.generate().publicKey;
const member = Keypair.generate().publicKey;
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config"), ms.toBuffer()], PROGRAM_ID);

async function guardConfigData(policyHash: number[]) {
  return coder.accounts.encode("GuardConfig", {
    multisig: ms, forwarder_program: PublicKey.default, forwarder_state: PublicKey.default, policy_hash: policyHash,
    workflow_owner: new Array(20).fill(0), max_review_lifetime: new anchor.BN(3600), review_deadline_secs: new anchor.BN(900),
    bump: 255, executor_bump: 254,
  });
}

async function settlementWith(accounts: Map<string, { owner: PublicKey; data: Buffer }>) {
  const connection = {
    getAccountInfo: async (k: PublicKey) => {
      const a = accounts.get(k.toBase58());
      return a ? { ...a, executable: false, lamports: 1, rentEpoch: 0 } : null;
    },
  };
  return createSettlement({ connection: connection as never, programId: PROGRAM_ID });
}

test("builds apply_policy_change with the Squads and guard PDAs, paid by the member", async () => {
  const s = await settlementWith(new Map([[config.toBase58(), { owner: PROGRAM_ID, data: await guardConfigData(new Array(32).fill(7)) }]]));
  const ix = await s.applyPolicyChange({ multisig: ms.toBase58(), txIndex: "12", member: member.toBase58() });
  assert.equal(ix.programId.toBase58(), PROGRAM_ID.toBase58());
  const disc = idl.instructions.find((i) => i.name === "apply_policy_change")!.discriminator;
  assert.deepEqual(Array.from(ix.data.subarray(0, 8)), disc);
  const [vaultTransaction] = sqds.getTransactionPda({ multisigPda: ms, index: 12n });
  const [proposal] = sqds.getProposalPda({ multisigPda: ms, transactionIndex: 12n });
  assert.deepEqual(
    ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    [
      [config.toBase58(), false, true],
      [ms.toBase58(), false, false],
      [proposal.toBase58(), false, false],
      [vaultTransaction.toBase58(), false, false],
      [policyChangePda(PROGRAM_ID, ms, 12n).toBase58(), false, true],
      [member.toBase58(), true, true],
      [SystemProgram.programId.toBase58(), false, false],
    ],
  );
});

test("apply_policy_change needs a guarded multisig and valid identifiers", async () => {
  const s = await settlementWith(new Map());
  await assert.rejects(s.applyPolicyChange({ multisig: ms.toBase58(), txIndex: "12", member: member.toBase58() }), { status: 404 });
  await assert.rejects(s.applyPolicyChange({ multisig: ms.toBase58(), txIndex: "0", member: member.toBase58() }), { status: 400 });
});

test("reads the treasury's current policy hash from its GuardConfig", async () => {
  const s = await settlementWith(new Map([[config.toBase58(), { owner: PROGRAM_ID, data: await guardConfigData(new Array(32).fill(7)) }]]));
  assert.equal(await s.currentPolicyHash(ms.toBase58()), "07".repeat(32));
  assert.equal(await (await settlementWith(new Map())).currentPolicyHash(ms.toBase58()), null);
  const foreign = await settlementWith(new Map([[config.toBase58(), { owner: Keypair.generate().publicKey, data: await guardConfigData(new Array(32).fill(7)) }]]));
  assert.equal(await foreign.currentPolicyHash(ms.toBase58()), null);
});

test("prepares initialize_guard with a chosen policy hash instead of the deployment's", async () => {
  const createKey = Keypair.generate().publicKey;
  const newMs = sqds.getMultisigPda({ createKey })[0];
  const guardSetup = {
    forwarderProgram: Keypair.generate().publicKey.toBase58(), forwarderState: Keypair.generate().publicKey.toBase58(),
    policyHash: "11".repeat(32), workflowOwner: "22".repeat(20), maxReviewLifetime: "3600", reviewDeadlineSecs: "900",
  };
  const connection = { getAccountInfo: async () => null };
  const s = createSettlement({ connection: connection as never, programId: PROGRAM_ID, guardSetup });
  const input = { multisig: newMs.toBase58(), creator: member.toBase58(), createKey: createKey.toBase58() };
  const policyAt = (data: Buffer) => data.subarray(72, 104).toString("hex");
  assert.equal(policyAt((await s.prepareGuardedGroup(input)).instruction.data), "11".repeat(32));
  assert.equal(policyAt((await s.prepareGuardedGroup({ ...input, policyHash: "33".repeat(32) })).instruction.data), "33".repeat(32));
});
