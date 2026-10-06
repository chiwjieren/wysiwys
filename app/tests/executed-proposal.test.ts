import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as sqds from "@sqds/multisig";
import { readProposal } from "../src/lib/squads/sdk";
const multisig = sqds.getMultisigPda({
  createKey: Keypair.generate().publicKey,
})[0];
const cleared = sqds.accounts.VaultTransaction.fromArgs({
  multisig: PublicKey.default,
  creator: PublicKey.default,
  index: 0,
  bump: 0,
  vaultIndex: 0,
  vaultBump: 0,
  ephemeralSignerBumps: new Uint8Array(),
  message: {
    numSigners: 0,
    numWritableSigners: 0,
    numWritableNonSigners: 0,
    accountKeys: [],
    instructions: [],
    addressTableLookups: [],
  },
});
const info = (data: Buffer) => ({
  owner: sqds.PROGRAM_ID,
  data,
  lamports: 1,
  executable: false,
  rentEpoch: 0,
});
async function read(status: "Executed" | "Approved", missing = false) {
  const proposal = sqds.accounts.Proposal.fromArgs({
    multisig,
    transactionIndex: 1,
    bump: 1,
    status: { __kind: status, timestamp: 100 },
    approved: [],
    rejected: [],
    cancelled: [],
  });
  const rpc = {
    getMultipleAccountsInfo: async () => [
      info(proposal.serialize()[0]),
      missing ? null : info(cleared.serialize()[0]),
    ],
  };
  return readProposal(
    rpc as never,
    { multisig: multisig.toBase58(), vaultIndex: 0, settlementEnabled: false },
    1n,
  );
}
test("executed proposals remain readable after Squads clears the VaultTransaction", async () => {
  assert.equal((await read("Executed"))?.kind, "archived");
  assert.equal((await read("Executed", true))?.kind, "archived");
});
test("a cleared payment account never makes an approved proposal executable", async () => {
  await assert.rejects(() => read("Approved"), /binding/);
});
