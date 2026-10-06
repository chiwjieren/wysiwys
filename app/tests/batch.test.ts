import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as sqds from "@sqds/multisig";
import { readProposal } from "../src/lib/squads/sdk";
test("batch proposals are readable without breaking the treasury snapshot", async () => {
  const createKey = Keypair.generate().publicKey,
    multisig = sqds.getMultisigPda({ createKey })[0];
  const creator = Keypair.generate().publicKey,
    index = 1n;
  const proposal = sqds.accounts.Proposal.fromArgs({
    multisig,
    transactionIndex: 1,
    bump: sqds.getProposalPda({
      multisigPda: multisig,
      transactionIndex: index,
    })[1],
    status: { __kind: "Active", timestamp: 1 },
    approved: [],
    rejected: [],
    cancelled: [],
  });
  const batch = sqds.accounts.Batch.fromArgs({
    multisig,
    creator,
    index: 1,
    bump: sqds.getTransactionPda({ multisigPda: multisig, index })[1],
    vaultIndex: 0,
    vaultBump: sqds.getVaultPda({ multisigPda: multisig, index: 0 })[1],
    size: 2,
    executedTransactionIndex: 0,
  });
  const info = (data: Buffer) => ({
    owner: sqds.PROGRAM_ID,
    data,
    lamports: 1,
    executable: false,
    rentEpoch: 0,
  });
  const rpc = {
    getMultipleAccountsInfo: async () => [
      info(proposal.serialize()[0]),
      info(batch.serialize()[0]),
    ],
  };
  const record = await readProposal(
    rpc as never,
    { multisig: multisig.toBase58(), vaultIndex: 0, settlementEnabled: false },
    index,
  );
  assert.equal(record?.kind, "batch");
});
