import test from "node:test";
import assert from "node:assert/strict";
import * as sqds from "@sqds/multisig";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  buildGroupCreation,
  encodeInitializeGuardArgs,
  GUARDED_GROUP_MAX_INVITES,
  validateInitializeGuard,
  type GuardInitArgs,
} from "../src/lib/squads/groups";
import {
  parseDeployment,
  parseGuardArgs,
} from "../src/lib/squads/server-config";
import { fromWire, toWire, withComputeBudget } from "../src/lib/squads/sdk";
import {
  parseCreateGroupRequest,
  parsePreparedGroup,
  parseRunnerGroup,
} from "../src/lib/squads/guard-groups";

const guardProgram = Keypair.generate().publicKey;
const creator = Keypair.generate().publicKey;
const createKey = Keypair.generate().publicKey;
const multisig = sqds.getMultisigPda({ createKey })[0];
const pda = (seed: string) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from(seed), multisig.toBuffer()],
    guardProgram,
  )[0];
const config = pda("config");
const executor = pda("executor");
const args: GuardInitArgs = {
  forwarderProgram: Keypair.generate().publicKey.toBase58(),
  forwarderState: Keypair.generate().publicKey.toBase58(),
  policyHash: "ab".repeat(32),
  workflowOwner: "cd".repeat(20),
  maxReviewLifetime: "3600",
  reviewDeadlineSecs: "900",
};
function initializeGuard(
  overrides: {
    keys?: TransactionInstruction["keys"];
    programId?: PublicKey;
    data?: Buffer;
  } = {},
) {
  return new TransactionInstruction({
    programId: overrides.programId ?? guardProgram,
    keys: overrides.keys ?? [
      { pubkey: multisig, isSigner: false, isWritable: false },
      { pubkey: createKey, isSigner: true, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: executor, isSigner: false, isWritable: false },
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: overrides.data ?? encodeInitializeGuardArgs(args),
  });
}
const expected = { guardProgram, multisig, createKey, creator, executor };

test("initialize_guard args encode the Anchor discriminator and fixed 140-byte layout", () => {
  const data = encodeInitializeGuardArgs(args);
  assert.equal(data.length, 140);
  assert.deepEqual(
    [...data.subarray(0, 8)],
    [63, 189, 246, 157, 77, 125, 157, 142],
  );
  assert.equal(data.readBigInt64LE(124), 3600n);
  assert.equal(data.readBigInt64LE(132), 900n);
});

test("a runner-built initialize_guard is accepted only with the exact contract accounts", () => {
  const ix = initializeGuard();
  const result = validateInitializeGuard(ix, { ...expected, args });
  assert.ok(result.config.equals(config));
  assert.equal(result.guardInstruction, ix);
  // Without pinned args the layout is still checked.
  assert.ok(validateInitializeGuard(ix, expected).config.equals(config));
  const keys = ix.keys;
  const swap = (i: number, change: Partial<(typeof keys)[number]>) =>
    keys.map((k, j) => (j === i ? { ...k, ...change } : k));
  const stranger = Keypair.generate().publicKey;
  const bad: [string, TransactionInstruction, RegExp][] = [
    ["program", initializeGuard({ programId: stranger }), /guard program/i],
    [
      "squads",
      initializeGuard({ programId: sqds.PROGRAM_ID }),
      /guard program/i,
    ],
    [
      "order",
      initializeGuard({ keys: [keys[1], keys[0], ...keys.slice(2)] }),
      /account/i,
    ],
    [
      "extra",
      initializeGuard({
        keys: [
          ...keys,
          { pubkey: stranger, isSigner: false, isWritable: false },
        ],
      }),
      /account/i,
    ],
    ["missing", initializeGuard({ keys: keys.slice(0, 5) }), /account/i],
    [
      "config",
      initializeGuard({ keys: swap(2, { pubkey: stranger }) }),
      /account/i,
    ],
    [
      "executor",
      initializeGuard({ keys: swap(3, { pubkey: stranger }) }),
      /account/i,
    ],
    [
      "payer",
      initializeGuard({ keys: swap(4, { pubkey: stranger }) }),
      /account/i,
    ],
    [
      "extra signer",
      initializeGuard({ keys: swap(0, { isSigner: true }) }),
      /account/i,
    ],
    [
      "writable create key",
      initializeGuard({ keys: swap(1, { isWritable: true }) }),
      /account/i,
    ],
    [
      "unsigned payer",
      initializeGuard({ keys: swap(4, { isSigner: false }) }),
      /account/i,
    ],
    [
      "system",
      initializeGuard({ keys: swap(5, { pubkey: stranger }) }),
      /account/i,
    ],
    [
      "discriminator",
      initializeGuard({ data: Buffer.alloc(140) }),
      /initialize_guard/i,
    ],
    [
      "length",
      initializeGuard({
        data: encodeInitializeGuardArgs(args).subarray(0, 139),
      }),
      /initialize_guard/i,
    ],
  ];
  for (const [label, instruction, pattern] of bad)
    assert.throws(
      () => validateInitializeGuard(instruction, expected),
      pattern,
      label,
    );
  // The runner-reported executor must equal the derived PDA.
  assert.throws(
    () => validateInitializeGuard(ix, { ...expected, executor: stranger }),
    /executor/i,
  );
  // The multisig must be the Squads PDA of the create key.
  assert.throws(
    () =>
      validateInitializeGuard(ix, {
        ...expected,
        createKey: Keypair.generate().publicKey,
      }),
    /create key/i,
  );
  // A forwarder, policy or lifetime different from the deployment is refused.
  for (const change of [
    { forwarderProgram: stranger.toBase58() },
    { forwarderState: stranger.toBase58() },
    { policyHash: "00".repeat(32) },
    { workflowOwner: "00".repeat(20) },
    { maxReviewLifetime: "7200" },
    { reviewDeadlineSecs: "60" },
  ])
    assert.throws(
      () =>
        validateInitializeGuard(ix, {
          ...expected,
          args: { ...args, ...change },
        }),
      /guard configuration/i,
    );
  for (const change of [
    { maxReviewLifetime: "0" },
    { reviewDeadlineSecs: "-1" },
  ])
    assert.throws(
      () =>
        validateInitializeGuard(
          initializeGuard({
            data: encodeInitializeGuardArgs({ ...args, ...change }),
          }),
          expected,
        ),
      /initialize_guard/i,
    );
});

test("wire round trip keeps only public instruction fields", () => {
  const ix = initializeGuard();
  const wire = toWire(ix);
  assert.deepEqual(Object.keys(wire).sort(), ["data", "keys", "programId"]);
  const back = fromWire(wire);
  assert.ok(back.programId.equals(ix.programId));
  assert.ok(back.data.equals(ix.data));
  assert.deepEqual(
    back.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
  );
});

test("a guarded treasury with the maximum members is created in one transaction", () => {
  const members = Array.from({ length: GUARDED_GROUP_MAX_INVITES }, () =>
    Keypair.generate().publicKey.toBase58(),
  );
  const group = buildGroupCreation({
    creator,
    createKey,
    treasury: Keypair.generate().publicKey,
    members,
    threshold: members.length + 1,
    name: "x".repeat(80),
    executor,
  });
  const message = new TransactionMessage({
    payerKey: creator,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    // As sent: signAndConfirm adds the compute budget (limit + priority fee) to every transaction.
    instructions: withComputeBudget([group.instruction, initializeGuard()]),
  }).compileToV0Message();
  assert.equal(message.header.numRequiredSignatures, 2);
  const size = new VersionedTransaction(message).serialize().length;
  assert.ok(size <= 1232, `${size} bytes`);
  assert.throws(
    () =>
      buildGroupCreation({
        creator,
        createKey,
        treasury: Keypair.generate().publicKey,
        members: [...members, Keypair.generate().publicKey.toBase58()],
        threshold: 1,
        name: "Desk",
        executor,
      }),
    /members/i,
  );
});

test("runner group responses carry the guard program, executor and nested token", () => {
  const mint = Keypair.generate().publicKey.toBase58();
  const parsed = parseDeployment(
    {
      multisig: multisig.toBase58(),
      programId: guardProgram.toBase58(),
      executorPda: executor.toBase58(),
      vaultIndex: 0,
      guardReady: true,
      token: { mint, symbol: "mUSD", decimals: 6 },
    },
    true,
  );
  assert.equal(parsed.guardProgram, guardProgram.toBase58());
  assert.equal(parsed.executor, executor.toBase58());
  assert.deepEqual(parsed.token, { mint, symbol: "mUSD", decimals: 6 });
  assert.equal(parsed.settlementEnabled, true);
  assert.equal(parsed.executionMode, "guarded");
});

const request = {
  multisig: multisig.toBase58(),
  creator: creator.toBase58(),
  createKey: createKey.toBase58(),
};
const runnerGroup = {
  multisig: multisig.toBase58(),
  programId: guardProgram.toBase58(),
  executorPda: executor.toBase58(),
  vaultIndex: 0,
  guardReady: false,
  token: {
    mint: Keypair.generate().publicKey.toBase58(),
    symbol: "mUSD",
    decimals: 6,
  },
  guardInstruction: toWire(initializeGuard()),
};

test("group creation requests bind the multisig to its create key", () => {
  assert.deepEqual(parseCreateGroupRequest(request), request);
  for (const bad of [
    { ...request, multisig: Keypair.generate().publicKey.toBase58() },
    { ...request, createKey: creator.toBase58() },
    { ...request, creator: "nope" },
    null,
  ])
    assert.throws(() => parseCreateGroupRequest(bad));
});

test("prepared guarded groups return only the validated config and instruction", () => {
  const prepared = parsePreparedGroup(
    { ...runnerGroup, extra: "secret" },
    request,
    { guardProgram: guardProgram.toBase58(), guardArgs: args },
  );
  assert.deepEqual(Object.keys(prepared).sort(), [
    "config",
    "guardInstruction",
  ]);
  assert.equal(prepared.config.multisig, request.multisig);
  assert.equal(prepared.config.settlementEnabled, false);
  assert.deepEqual(prepared.guardInstruction, runnerGroup.guardInstruction);
  const stranger = Keypair.generate().publicKey.toBase58();
  const otherPolicy = toWire(
    initializeGuard({
      data: encodeInitializeGuardArgs({ ...args, policyHash: "00".repeat(32) }),
    }),
  );
  const cases: [
    unknown,
    { guardProgram?: string; guardArgs?: GuardInitArgs }?,
  ][] = [
    [{ ...runnerGroup, multisig: stranger }],
    [runnerGroup, { guardProgram: stranger }],
    [{ ...runnerGroup, executorPda: stranger }],
    [{ ...runnerGroup, guardInstruction: otherPolicy }, { guardArgs: args }],
    [{ ...runnerGroup, guardInstruction: undefined }],
  ];
  for (const [bad, deployment] of cases)
    assert.throws(() => parsePreparedGroup(bad, request, deployment));
});

test("runner-opened guarded groups must use the deployed guard and its derived executor", () => {
  const config = parseRunnerGroup(
    { ...runnerGroup, guardReady: true },
    request.multisig,
    guardProgram.toBase58(),
  );
  assert.equal(config.settlementEnabled, true);
  assert.equal(config.guardProgram, guardProgram.toBase58());
  assert.equal(config.executor, executor.toBase58());
  assert.equal(config.token?.symbol, "mUSD");
  const other = PublicKey.findProgramAddressSync(
    [Buffer.from("x")],
    guardProgram,
  )[0].toBase58();
  assert.throws(() =>
    parseRunnerGroup({ ...runnerGroup, executorPda: other }, request.multisig),
  );
  assert.throws(() =>
    parseRunnerGroup(
      runnerGroup,
      request.multisig,
      Keypair.generate().publicKey.toBase58(),
    ),
  );
});

test("the checked-in devnet deployment pins guard args", async () => {
  const { readFile } = await import("node:fs/promises");
  const raw = JSON.parse(
    await readFile(
      new URL("../../deployments/devnet.json", import.meta.url),
      "utf8",
    ),
  );
  const pinned = parseGuardArgs(raw);
  assert.equal(pinned?.policyHash, raw.guard.policyHash);
  assert.equal(encodeInitializeGuardArgs(pinned!).length, 140);
});

test("deployment guard args are parsed strictly", () => {
  assert.deepEqual(parseGuardArgs({ guard: args }), args);
  assert.equal(parseGuardArgs({}), undefined);
  for (const bad of [
    { ...args, policyHash: "zz" },
    { ...args, workflowOwner: "ab" },
    { ...args, forwarderState: "nope" },
    { ...args, maxReviewLifetime: "1.5" },
  ])
    assert.throws(() => parseGuardArgs({ guard: bad }), /guard/i);
});

test("a creator-chosen policy: the request carries its hash and initialize_guard must commit to exactly it", () => {
  const request = { multisig: multisig.toBase58(), creator: creator.toBase58(), createKey: createKey.toBase58() };
  const chosen = "ef".repeat(32);
  assert.deepEqual(parseCreateGroupRequest({ ...request, policyHash: chosen }), { ...request, policyHash: chosen });
  for (const policyHash of ["EF".repeat(32), "ef".repeat(31), 5])
    assert.throws(() => parseCreateGroupRequest({ ...request, policyHash }));

  const ix = initializeGuard({ data: encodeInitializeGuardArgs({ ...args, policyHash: chosen }) });
  assert.ok(validateInitializeGuard(ix, { ...expected, policyHash: chosen }));
  assert.ok(validateInitializeGuard(ix, { ...expected, args: { ...args, policyHash: chosen } }));
  assert.throws(() => validateInitializeGuard(initializeGuard(), { ...expected, policyHash: chosen }), /policy/i);
});
