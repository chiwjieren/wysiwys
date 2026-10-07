import { test } from "node:test";
import assert from "node:assert/strict";
import anchor from "@anchor-lang/core";
import { PublicKey, type Connection } from "@solana/web3.js";
import { SEEDS, txIndexSeed } from "@wysiwys/shared";
import { createReviewVerifier } from "../src/delivery";
import { idl, PROGRAM_ID, key, bytes32 } from "./helpers";

const req = { multisig: key(2).toBase58(), txIndex: "7" };
const coder = new anchor.BorshCoder(idl);
const statusNames = (
  idl.types!.find((t) => t.name === "ReviewStatus")!.type as {
    variants: { name: string }[];
  }
).variants.map((v) => v.name);
async function account(status: number, change: Record<string, unknown> = {}) {
  const data = await coder.accounts.encode("Review", {
    version: 2,
    multisig: key(2),
    vault_transaction: key(3),
    proposal: key(4),
    tx_index: new anchor.BN(7),
    tx_hash: bytes32(5),
    status: { [statusNames[status] ?? statusNames[0]!]: {} },
    reason: 0,
    policy_hash: bytes32(6),
    action_kind: 2,
    destination_hash: bytes32(7),
    issued_at: new anchor.BN(100),
    expires_at: new anchor.BN(200),
    created_at: new anchor.BN(90),
    bump: 1,
    ...change,
  });
  if (status >= statusNames.length) data[145] = status;
  return {
    owner: PROGRAM_ID,
    data,
    executable: false,
    lamports: 1,
    rentEpoch: 0,
  };
}

test("verifies finalized decided Review at the derived PDA, not CLI output", async () => {
  for (const status of [1, 2, 3]) {
    const a = await account(status);
    const connection = {
      getAccountInfo: async (address: PublicKey, commitment: unknown) => {
        assert.equal(commitment, "finalized");
        const expected = PublicKey.findProgramAddressSync(
          [Buffer.from(SEEDS.review), key(2).toBuffer(), txIndexSeed(7n)],
          PROGRAM_ID,
        )[0];
        assert.ok(address.equals(expected));
        return a;
      },
    };
    assert.equal(
      await createReviewVerifier(
        connection as unknown as Connection,
        PROGRAM_ID,
      )(req),
      true,
    );
  }
});

test("missing, pending, wrong owner, wrong identity, unsupported version and malformed accounts cannot acknowledge delivery", async () => {
  const valid = await account(1);
  const values = [
    null,
    await account(0),
    { ...valid, owner: key(9) },
    await account(1, { multisig: key(8) }),
    await account(1, { tx_index: new anchor.BN(8) }),
    await account(1, { version: 99 }),
    await account(99),
    { ...valid, data: Buffer.from([1, 2]) },
  ];
  for (const value of values) {
    const connection = { getAccountInfo: async () => value };
    assert.equal(
      await createReviewVerifier(
        connection as unknown as Connection,
        PROGRAM_ID,
      )(req),
      false,
    );
  }
});

test("RPC errors propagate so the runner retains a retryable failure", async () => {
  const connection = {
    getAccountInfo: async () => {
      throw new Error("RPC failed");
    },
  };
  await assert.rejects(
    createReviewVerifier(connection as unknown as Connection, PROGRAM_ID)(req),
    /RPC failed/,
  );
});
