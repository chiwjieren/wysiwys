import assert from "node:assert/strict";
import test from "node:test";
import {
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
} from "@solana/web3.js";
import BN from "bn.js";
import * as sqds from "@sqds/multisig";
import {
  actionsForMember,
  buildVote,
  buildPayoutProposal,
  buildGuardedExecute,
  validateGuardInstruction,
  proposalIndices,
  decodeProposal,
} from "../src/lib/squads/sdk";
import { validateRpcRequest } from "../src/lib/squads/rpc-policy";

test("configuration proposals are readable and can receive votes without being treated as vault payouts", async () => {
  const { readProposal } = await import("../src/lib/squads/sdk");
  const transaction = sqds.accounts.ConfigTransaction.fromArgs({
    multisig,
    creator: member,
    index: new BN(index.toString()),
    bump: 1,
    actions: [{ __kind: "ChangeThreshold", newThreshold: 1 }],
  });
  const p = proposal();
  const info = (data: Buffer) => ({
    data,
    owner: sqds.PROGRAM_ID,
    executable: false,
    lamports: 1,
    rentEpoch: 0,
  });
  const rpc = {
    getMultipleAccountsInfo: async () => [
      info(p.serialize()[0]),
      info(transaction.serialize()[0]),
    ],
  };
  const record = await readProposal(
    rpc as never,
    {
      multisig: multisig.toBase58(),
      guardProgram: guard.toBase58(),
      executor: executor.toBase58(),
      vaultIndex: 0,
      settlementEnabled: false,
    },
    index,
  );
  assert.equal(record?.kind, "config");
  assert.equal(actionsForMember(squad, record!.proposal, member).approve, true);
});
test("a transaction created before its proposal does not make the proposal list unreadable", async () => {
  const { readProposal } = await import("../src/lib/squads/sdk");
  const transaction = sqds.accounts.ConfigTransaction.fromArgs({
    multisig,
    creator: member,
    index: new BN(index.toString()),
    bump: 1,
    actions: [{ __kind: "ChangeThreshold", newThreshold: 1 }],
  });
  const info = {
    data: transaction.serialize()[0],
    owner: sqds.PROGRAM_ID,
    executable: false,
    lamports: 1,
    rentEpoch: 0,
  };
  const config = {
    multisig: multisig.toBase58(),
    guardProgram: guard.toBase58(),
    executor: executor.toBase58(),
    vaultIndex: 0,
    settlementEnabled: false,
  };
  assert.equal(
    await readProposal(
      { getMultipleAccountsInfo: async () => [null, info] } as never,
      config,
      index,
    ),
    null,
  );
  await assert.rejects(
    readProposal(
      {
        getMultipleAccountsInfo: async () => [null, { ...info, owner: member }],
      } as never,
      config,
      index,
    ),
  );
});

const multisig = Keypair.generate().publicKey;
const member = Keypair.generate().publicKey;
const guard = Keypair.generate().publicKey;
const executor = Keypair.generate().publicKey;
const index = 9007199254740993n;
function proposal(status: "Active" | "Approved" | "Executed" = "Active") {
  return sqds.accounts.Proposal.fromArgs({
    multisig,
    transactionIndex: new BN(index.toString()),
    status: { __kind: status, timestamp: 100 },
    bump: 1,
    approved: [],
    rejected: [],
    cancelled: [],
  });
}
const squad = {
  members: [{ key: member, permissions: { mask: 3 } }],
  staleTransactionIndex: 0,
};

test("Wallet connector raw signatures are attached to the original SDK transaction", async () => {
  const { signAndConfirm } = await import("../src/lib/squads/sdk");
  const { VersionedTransaction } = await import("@solana/web3.js");
  const signer = Keypair.generate();
  let submitted = false;
  const rpc = {
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 500,
    }),
    sendRawTransaction: async (bytes: Uint8Array) => {
      const tx = VersionedTransaction.deserialize(bytes);
      assert.ok(tx.signatures[0].some((byte) => byte !== 0));
      assert.ok(tx.message.staticAccountKeys[0].equals(signer.publicKey));
      submitted = true;
      return "signature";
    },
    getSignatureStatuses: async () => ({
      value: [{ err: null, confirmationStatus: "finalized" }],
    }),
  };
  await signAndConfirm(
    rpc as never,
    signer.publicKey,
    [
      SystemProgram.transfer({
        fromPubkey: signer.publicKey,
        toPubkey: member,
        lamports: 1,
      }),
    ],
    async (bytes) => {
      const tx = VersionedTransaction.deserialize(bytes);
      tx.sign([signer]);
      return tx.signatures[0];
    },
    () => {},
  );
  assert.equal(submitted, true);
});

test("SDK permissions permit human votes and block executor-only wallets", () => {
  assert.equal(actionsForMember(squad, proposal(), member).approve, true);
  assert.equal(
    actionsForMember(
      { ...squad, members: [{ key: member, permissions: { mask: 4 } }] },
      proposal(),
      member,
    ).approve,
    false,
  );
  assert.equal(actionsForMember(squad, proposal(), executor).approve, false);
  assert.equal(
    actionsForMember(squad, proposal("Executed"), member).approve,
    false,
  );
});
test("a wallet can change its vote but cannot repeat it, and stale proposals cannot be approved", () => {
  const p = sqds.accounts.Proposal.fromArgs({
    ...proposal(),
    approved: [member],
  });
  assert.equal(actionsForMember(squad, p, member).approve, false);
  assert.equal(actionsForMember(squad, p, member).reject, true);
  assert.equal(
    actionsForMember(
      { ...squad, staleTransactionIndex: new BN(index.toString()) },
      p,
      member,
    ).approve,
    false,
  );
  assert.equal(
    actionsForMember(
      { ...squad, staleTransactionIndex: new BN(index.toString()) },
      p,
      member,
    ).cancel,
    true,
  );
});
test("vote instructions bind the exact proposal PDA without rounding u64 indices", () => {
  const ix = buildVote("approve", multisig, index, member);
  const [pda] = sqds.getProposalPda({
    multisigPda: multisig,
    transactionIndex: index,
  });
  assert(ix.programId.equals(sqds.PROGRAM_ID));
  assert(ix.keys.some((k) => k.pubkey.equals(pda)));
  assert.deepEqual(
    ix.data,
    sqds.instructions.proposalApprove({
      multisigPda: multisig,
      transactionIndex: index,
      member,
    }).data,
  );
  assert.equal(decodeProposal(proposal()).index, index.toString());
  assert.deepEqual(proposalIndices(index, 2), [index, index - 1n]);
  assert.deepEqual(proposalIndices(0n, 20), []);
});
test("payout creation includes both SDK instructions before the guard review request", () => {
  const index = 7n;
  const [vault] = sqds.getVaultPda({ multisigPda: multisig, index: 0 });
  const [tx] = sqds.getTransactionPda({ multisigPda: multisig, index });
  const [pda] = sqds.getProposalPda({
    multisigPda: multisig,
    transactionIndex: index,
  });
  const request = new TransactionInstruction({
    programId: guard,
    keys: [multisig, tx, pda].map((pubkey) => ({
      pubkey,
      isSigner: false,
      isWritable: true,
    })),
    data: Buffer.from([1]),
  });
  const message = new TransactionMessage({
    payerKey: vault,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [
      SystemProgram.transfer({
        fromPubkey: vault,
        toPubkey: member,
        lamports: 1,
      }),
    ],
  });
  const result = buildPayoutProposal({
    multisig,
    member,
    index,
    vaultIndex: 0,
    message,
    guard,
    requestReview: request,
  });
  assert.equal(result.length, 3);
  assert(result[0].programId.equals(sqds.PROGRAM_ID));
  assert(result[1].programId.equals(sqds.PROGRAM_ID));
  assert.equal(result[2], request);
  assert.throws(
    () =>
      buildPayoutProposal({
        multisig,
        member,
        index,
        vaultIndex: 0,
        message,
        guard,
        requestReview: SystemProgram.transfer({
          fromPubkey: member,
          toPubkey: vault,
          lamports: 1,
        }),
      }),
    /guard/i,
  );
});
test("guarded execution refuses direct Squads execution, missing accounts and additional signers", () => {
  const [tx] = sqds.getTransactionPda({ multisigPda: multisig, index });
  const [pda] = sqds.getProposalPda({
    multisigPda: multisig,
    transactionIndex: index,
  });
  const ix = new TransactionInstruction({
    programId: guard,
    keys: [multisig, tx, pda].map((pubkey) => ({
      pubkey,
      isSigner: false,
      isWritable: true,
    })),
    data: Buffer.from([1]),
  });
  assert.equal(
    validateGuardInstruction(ix, guard, multisig, index, member),
    ix,
  );
  assert.throws(
    () =>
      validateGuardInstruction(
        new TransactionInstruction({ ...ix, programId: sqds.PROGRAM_ID }),
        guard,
        multisig,
        index,
        member,
      ),
    /guard/i,
  );
  assert.throws(
    () =>
      validateGuardInstruction(
        new TransactionInstruction({ ...ix, keys: [] }),
        guard,
        multisig,
        index,
        member,
      ),
    /account/i,
  );
  assert.throws(
    () =>
      validateGuardInstruction(
        new TransactionInstruction({
          ...ix,
          keys: [
            ...ix.keys,
            { pubkey: executor, isSigner: true, isWritable: false },
          ],
        }),
        guard,
        multisig,
        index,
        member,
      ),
    /signer/i,
  );
});
test("guarded execute raises the compute limit for the Squads CPI and validates the guard instruction", () => {
  const [tx] = sqds.getTransactionPda({ multisigPda: multisig, index });
  const [pda] = sqds.getProposalPda({
    multisigPda: multisig,
    transactionIndex: index,
  });
  const ix = new TransactionInstruction({
    programId: guard,
    keys: [multisig, tx, pda].map((pubkey) => ({
      pubkey,
      isSigner: false,
      isWritable: true,
    })),
    data: Buffer.from([2]),
  });
  const result = buildGuardedExecute(ix, guard, multisig, index, member);
  assert.equal(result.length, 2);
  assert(result[0].programId.equals(ComputeBudgetProgram.programId));
  assert.equal(result[0].data[0], 2); // SetComputeUnitLimit
  assert.equal(result[0].data.readUInt32LE(1), 400_000);
  assert.equal(result[1], ix);
  assert.throws(
    () =>
      buildGuardedExecute(
        new TransactionInstruction({ ...ix, programId: sqds.PROGRAM_ID }),
        guard,
        multisig,
        index,
        member,
      ),
    /guard/i,
  );
});
test("RPC proxy accepts needed reads and signed submissions but refuses arbitrary or nonfinalized reads", () => {
  assert.equal(
    validateRpcRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [
        multisig.toBase58(),
        { encoding: "base64", commitment: "finalized" },
      ],
    }).method,
    "getAccountInfo",
  );
  assert.throws(
    () =>
      validateRpcRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "requestAirdrop",
        params: [],
      }),
    /method/i,
  );
  assert.throws(
    () =>
      validateRpcRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [multisig.toBase58(), { commitment: "processed" }],
      }),
    /finalized/i,
  );
  assert.throws(
    () =>
      validateRpcRequest([
        { jsonrpc: "2.0", id: 1, method: "getBalance", params: [] },
      ]),
    /request/i,
  );
});

test("RPC account reads reject foreign ownership before decoding", async () => {
  const { readMultisig } = await import("../src/lib/squads/sdk");
  const { Connection } = await import("@solana/web3.js");
  const connection = new Connection("http://localhost:3105", {
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            context: { slot: 1 },
            value: {
              owner: SystemProgram.programId.toBase58(),
              data: [Buffer.alloc(100).toString("base64"), "base64"],
              lamports: 1,
              executable: false,
              rentEpoch: 0,
            },
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  });
  await assert.rejects(
    readMultisig(connection, {
      multisig: multisig.toBase58(),
      guardProgram: guard.toBase58(),
      executor: executor.toBase58(),
      vaultIndex: 0,
      settlementEnabled: false,
    }),
    /owned by another/,
  );
});

test("a wallet-modified transaction message never reaches RPC submission", async () => {
  const { signAndConfirm } = await import("../src/lib/squads/sdk");
  const { Connection, VersionedTransaction } = await import("@solana/web3.js");
  const wallet = Keypair.generate();
  let sends = 0;
  const connection = new Connection("http://localhost:3105", {
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.method === "sendTransaction") sends++;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            context: { slot: 1 },
            value: {
              blockhash: multisig.toBase58(),
              lastValidBlockHeight: 200,
            },
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  });
  await assert.rejects(
    signAndConfirm(
      connection,
      wallet.publicKey,
      [
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: member,
          lamports: 1,
        }),
      ],
      async () => {
        const changed = new VersionedTransaction(
          new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: multisig.toBase58(),
            instructions: [
              SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: executor,
                lamports: 2,
              }),
            ],
          }).compileToV0Message(),
        );
        changed.sign([wallet]);
        return changed.serialize();
      },
      () => {},
    ),
    /changed the transaction message/,
  );
  assert.equal(sends, 0);
});

test("a proposal page decodes 20 account pairs with one finalized RPC request", async () => {
  const { readProposalPage } = await import("../src/lib/squads/sdk");
  const { Connection } = await import("@solana/web3.js");
  let requests = 0;
  const connection = new Connection("http://localhost:3105", {
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      requests++;
      assert.equal(request.method, "getMultipleAccounts");
      assert.equal(request.params[0].length, 40);
      assert.equal(request.params[1].commitment, "finalized");
      const value = proposalIndices(20n).flatMap((i) => {
        const [vault, vaultBump] = sqds.getVaultPda({
          multisigPda: multisig,
          index: 0,
        });
        const p = sqds.accounts.Proposal.fromArgs({
          multisig,
          transactionIndex: Number(i),
          status: { __kind: "Active", timestamp: 100 },
          bump: sqds.getProposalPda({
            multisigPda: multisig,
            transactionIndex: i,
          })[1],
          approved: [],
          rejected: [],
          cancelled: [],
        });
        const tx = sqds.accounts.VaultTransaction.fromArgs({
          multisig,
          creator: member,
          index: Number(i),
          bump: sqds.getTransactionPda({ multisigPda: multisig, index: i })[1],
          vaultIndex: 0,
          vaultBump,
          ephemeralSignerBumps: new Uint8Array(),
          message: {
            numSigners: 1,
            numWritableSigners: 1,
            numWritableNonSigners: 0,
            accountKeys: [vault],
            instructions: [],
            addressTableLookups: [],
          },
        });
        return [p, tx].map((account) => ({
          owner: sqds.PROGRAM_ID.toBase58(),
          data: [account.serialize()[0].toString("base64"), "base64"],
          lamports: 1,
          executable: false,
          rentEpoch: 0,
        }));
      });
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { context: { slot: 1 }, value },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  });
  const records = await readProposalPage(
    connection,
    {
      multisig: multisig.toBase58(),
      guardProgram: guard.toBase58(),
      executor: executor.toBase58(),
      vaultIndex: 0,
      settlementEnabled: false,
    },
    20n,
  );
  assert.equal(requests, 1);
  assert.equal(records.length, 20);
  assert.equal(records[0].proposal.transactionIndex.toString(), "20");
  assert.equal(records[19].proposal.transactionIndex.toString(), "1");
});
