import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { parsePolicy, PolicyFormatError, policyHash, type PolicyV1 } from "./index";

const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const key = () => Keypair.generate().publicKey.toBase58();

// Synthetic values only; never the deployed policy.
const valid = (): Record<string, unknown> => ({
  version: 1,
  salt: "0123456789abcdef0123456789abcdef",
  allowedPrograms: [SYSTEM, TOKEN],
  allowedInstructions: ["system:transfer", "spl-token:transferChecked"],
  allowedMints: [{ mint: key(), decimals: 6 }],
  maxAmountPerPayment: "50000000000",
  destinationWhitelist: [key(), key()],
  screening: { provider: "scorechain", blockOn: ["SANCTIONED"] },
});

const reject = (doc: unknown, field: RegExp) =>
  assert.throws(() => parsePolicy(doc), (e: unknown) => e instanceof PolicyFormatError && field.test((e as Error).message));
const mutate = (f: (d: Record<string, any>) => void) => { const d = valid(); f(d); return d; };

test("accepts a document with today's key set", () => {
  const doc = valid();
  const p: PolicyV1 = parsePolicy(doc);
  assert.deepEqual(p, doc);
});

test("accepts a document without screening, and an SOL-only policy with no mints", () => {
  const noScreen = mutate((d) => { delete d.screening; });
  assert.equal(parsePolicy(noScreen).screening, undefined);
  assert.ok(!("screening" in parsePolicy(noScreen)));
  const solOnly = mutate((d) => { d.allowedPrograms = [SYSTEM]; d.allowedInstructions = ["system:transfer"]; d.allowedMints = []; });
  assert.deepEqual(parsePolicy(solOnly).allowedMints, []);
});

test("parsing does not change the policy hash and returns a new object", () => {
  const doc = valid();
  const p = parsePolicy(doc);
  assert.notEqual(p, doc);
  assert.deepEqual(policyHash(p as unknown as Record<string, unknown>, "dec-1"), policyHash(doc, "dec-1"));
});

test("rejects a non-object document", () => {
  for (const bad of [null, undefined, 1, "x", [], [valid()]]) reject(bad, /policy/);
});

test("rejects unknown keys", () => {
  reject(mutate((d) => { d.extra = 1; }), /unknown key "extra"/);
  reject(mutate((d) => { d.allowedMints[0].note = "x"; }), /allowedMints\[0\].*unknown key "note"/);
});

test("version: positive safe integer", () => {
  for (const v of [0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1, undefined]) reject(mutate((d) => { d.version = v; }), /version/);
  assert.equal(parsePolicy(mutate((d) => { d.version = 7; })).version, 7);
});

test("salt: hex, at least 32 characters", () => {
  const salt = "ab".repeat(15);
  for (const s of ["", "ab".repeat(15), "zz".repeat(16), 5, null, undefined]) reject(mutate((d) => { d.salt = s; }), /salt/);
  assert.equal(salt.length, 30);
  parsePolicy(mutate((d) => { d.salt = "AB".repeat(16); }));
});

test("error messages never echo the salt or whitelist entries", () => {
  const badSalt = "not-hex-secret-salt-value-0123456789";
  assert.throws(() => parsePolicy(mutate((d) => { d.salt = badSalt; })), (e: unknown) => !(e as Error).message.includes(badSalt));
  const addr = key();
  assert.throws(
    () => parsePolicy(mutate((d) => { d.destinationWhitelist = [addr, addr]; })),
    (e: unknown) => e instanceof PolicyFormatError && !(e as Error).message.includes(addr),
  );
  assert.throws(
    () => parsePolicy(mutate((d) => { d.destinationWhitelist = [addr + "0"]; })),
    (e: unknown) => e instanceof PolicyFormatError && !(e as Error).message.includes(addr),
  );
});

test("allowedPrograms: non-empty, unique, known", () => {
  reject(mutate((d) => { d.allowedPrograms = "x"; }), /allowedPrograms/);
  reject(mutate((d) => { d.allowedPrograms = []; }), /allowedPrograms/);
  reject(mutate((d) => { d.allowedPrograms = [SYSTEM, SYSTEM]; }), /allowedPrograms.*unique/);
  reject(mutate((d) => { d.allowedPrograms = [SYSTEM, key()]; }), /allowedPrograms\[1\]/);
  reject(mutate((d) => { d.allowedPrograms = [SYSTEM, 5]; }), /allowedPrograms\[1\]/);
});

test("allowedInstructions: non-empty, unique, known, program allowed", () => {
  reject(mutate((d) => { d.allowedInstructions = "x"; }), /allowedInstructions/);
  reject(mutate((d) => { d.allowedInstructions = []; }), /allowedInstructions/);
  reject(mutate((d) => { d.allowedInstructions = ["system:transfer", "system:transfer"]; }), /allowedInstructions.*unique/);
  reject(mutate((d) => { d.allowedInstructions = ["system:transfer", "system:createAccount"]; }), /allowedInstructions\[1\]/);
  reject(mutate((d) => { d.allowedPrograms = [TOKEN]; d.allowedInstructions = ["system:transfer"]; }), /allowedInstructions\[0\].*allowedPrograms/);
  reject(mutate((d) => { d.allowedPrograms = [SYSTEM]; d.allowedInstructions = ["spl-token:transferChecked"]; }), /allowedInstructions\[0\].*allowedPrograms/);
});

test("allowedMints: array, unique, valid key, decimals 0..9", () => {
  reject(mutate((d) => { d.allowedMints = "x"; }), /allowedMints/);
  reject(mutate((d) => { d.allowedMints = [1]; }), /allowedMints\[0\]/);
  reject(mutate((d) => { d.allowedMints = [{ mint: "abc", decimals: 6 }]; }), /allowedMints\[0\]\.mint/);
  reject(mutate((d) => { d.allowedMints = [{ decimals: 6 }]; }), /allowedMints\[0\]\.mint/);
  for (const dec of [-1, 10, 1.5, "6", null, undefined]) {
    reject(mutate((d) => { d.allowedMints = [{ mint: key(), decimals: dec }]; }), /allowedMints\[0\]\.decimals must be an integer 0\.\.9/);
  }
  const m = key();
  reject(mutate((d) => { d.allowedMints = [{ mint: key(), decimals: 6 }, { mint: m, decimals: 6 }, { mint: m, decimals: 9 }]; }), /allowedMints\[2\].*unique/);
  parsePolicy(mutate((d) => { d.allowedMints = [{ mint: key(), decimals: 0 }, { mint: key(), decimals: 9 }]; }));
});

test("allowedMints may be empty only when spl-token:transferChecked is not allowed", () => {
  reject(mutate((d) => { d.allowedMints = []; }), /allowedMints.*spl-token:transferChecked/);
});

test("maxAmountPerPayment: positive decimal string, no leading zero, at most u64 max", () => {
  for (const v of ["0", "01", "-5", "1.5", "1e6", " 1", "", "18446744073709551616", 5, null, undefined, "99999999999999999999999"]) {
    reject(mutate((d) => { d.maxAmountPerPayment = v; }), /maxAmountPerPayment/);
  }
  assert.equal(parsePolicy(mutate((d) => { d.maxAmountPerPayment = "18446744073709551615"; })).maxAmountPerPayment, "18446744073709551615");
  assert.equal(parsePolicy(mutate((d) => { d.maxAmountPerPayment = "1"; })).maxAmountPerPayment, "1");
});

test("destinationWhitelist: array of unique canonical base58 32-byte keys", () => {
  reject(mutate((d) => { d.destinationWhitelist = "x"; }), /destinationWhitelist/);
  reject(mutate((d) => { d.destinationWhitelist = [key(), "not-a-key"]; }), /destinationWhitelist\[1\]/);
  reject(mutate((d) => { d.destinationWhitelist = [key(), 7]; }), /destinationWhitelist\[1\]/);
  reject(mutate((d) => { d.destinationWhitelist = ["1111"]; }), /destinationWhitelist\[0\]/);
  reject(mutate((d) => { d.destinationWhitelist = [key() + "1"]; }), /destinationWhitelist\[0\]/);
  const a = key();
  reject(mutate((d) => { d.destinationWhitelist = [a, key(), a]; }), /destinationWhitelist\[2\].*unique/);
  assert.deepEqual(parsePolicy(mutate((d) => { d.destinationWhitelist = []; })).destinationWhitelist, []);
});

test("screening: absent, or exactly scorechain blocking SANCTIONED", () => {
  for (const s of [null, "scorechain", [], {}, { provider: "scorechain" }, { provider: "other", blockOn: ["SANCTIONED"] },
    { provider: "scorechain", blockOn: [] }, { provider: "scorechain", blockOn: ["HIGH_RISK"] },
    { provider: "scorechain", blockOn: ["SANCTIONED", "SANCTIONED"] },
    { provider: "scorechain", blockOn: ["SANCTIONED"], extra: 1 }]) {
    reject(mutate((d) => { d.screening = s; }), /screening/);
  }
});

test("missing required keys are rejected by name", () => {
  for (const k of ["version", "salt", "allowedPrograms", "allowedInstructions", "allowedMints", "maxAmountPerPayment", "destinationWhitelist"]) {
    reject(mutate((d) => { delete d[k]; }), new RegExp(k));
  }
});
