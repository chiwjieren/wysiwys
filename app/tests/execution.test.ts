import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as sqds from "@sqds/multisig";
import { assertStandardExecution } from "../src/lib/squads/execution";
const creator = Keypair.generate().publicKey,
  voter = Keypair.generate().publicKey;
const config = {
  multisig: Keypair.generate().publicKey.toBase58(),
  vaultIndex: 0,
  settlementEnabled: false,
  executionMode: "standard" as const,
};
const squad = {
  members: [
    { key: creator, permissions: { mask: 7 } },
    { key: voter, permissions: { mask: 3 } },
  ],
  threshold: 2,
  timeLock: 10,
  staleTransactionIndex: 0,
};
const proposal = sqds.accounts.Proposal.fromArgs({
  multisig: new PublicKey(config.multisig),
  transactionIndex: 1,
  bump: 1,
  status: { __kind: "Approved", timestamp: 100 },
  approved: [creator, voter],
  rejected: [],
  cancelled: [],
});
test("standard execution requires Execute permission, Approved status and elapsed timelock", () => {
  assert.doesNotThrow(() =>
    assertStandardExecution(config, squad, proposal, creator, 110),
  );
  assert.throws(
    () => assertStandardExecution(config, squad, proposal, voter, 110),
    /permission/,
  );
  assert.throws(
    () => assertStandardExecution(config, squad, proposal, creator, 109),
    /timelock/,
  );
  assert.throws(
    () =>
      assertStandardExecution(
        config,
        squad,
        { ...proposal, status: { __kind: "Active", timestamp: 100 } },
        creator,
        110,
      ),
    /approved/,
  );
});
test("guarded groups cannot enter the standard execution path", () => {
  assert.throws(
    () =>
      assertStandardExecution(
        { ...config, executionMode: undefined },
        squad,
        proposal,
        creator,
        110,
      ),
    /standard/,
  );
  assert.throws(
    () =>
      assertStandardExecution(
        { ...config, guardProgram: Keypair.generate().publicKey.toBase58() },
        squad,
        proposal,
        creator,
        110,
      ),
    /standard/,
  );
});

test("already-approved vault payments remain executable after later governance changes", () => {
  const changed = { ...squad, threshold: 3, staleTransactionIndex: 2 };
  assert.doesNotThrow(() =>
    assertStandardExecution(config, changed, proposal, creator, 110, "vault"),
  );
  assert.throws(
    () =>
      assertStandardExecution(
        config,
        changed,
        proposal,
        creator,
        110,
        "config",
      ),
    /stale/,
  );
});
