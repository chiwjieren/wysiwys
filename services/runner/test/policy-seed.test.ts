import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { policyHash } from "@wysiwys/shared";
import { openStore } from "../src/store";
import { seedPolicies } from "../src/policy-seed";

const DECODER = "@wysiwys/decoder@0.1.0";
const doc = (version: number) => ({
  version, salt: "cd".repeat(16), allowedPrograms: ["11111111111111111111111111111111"], allowedInstructions: ["system:transfer"],
  allowedMints: [], maxAmountPerPayment: "9", destinationWhitelist: [Keypair.generate().publicKey.toBase58()],
});
const hashOf = (d: unknown) => Buffer.from(policyHash(d as Record<string, unknown>, DECODER)).toString("hex");
const envFile = (line: string) => {
  const path = join(mkdtempSync(join(tmpdir(), "seed-")), ".env");
  writeFileSync(path, `CRE_OTHER=1\n${line}\nCRE_LAST=2\n`);
  return path;
};

test("seeds the store from a single CRE_POLICY_DOCUMENT", () => {
  const store = openStore(":memory:");
  const d = doc(1);
  const lines: string[] = [];
  assert.equal(seedPolicies(store, envFile(`CRE_POLICY_DOCUMENT='${JSON.stringify(d)}'`), DECODER, (l) => lines.push(l)), 1);
  assert.deepEqual(JSON.parse(store.getPolicyDocument(hashOf(d))!), d);
  assert.ok(!lines.join("\n").includes(d.destinationWhitelist[0]!), "never logs the whitelist");
});

test("seeds every valid entry of a registry array and skips invalid ones", () => {
  const store = openStore(":memory:");
  const [a, b] = [doc(1), doc(2)];
  const lines: string[] = [];
  const n = seedPolicies(store, envFile(`CRE_POLICY_DOCUMENT='${JSON.stringify([a, { ...b, extra: 1 }, b])}'`), DECODER, (l) => lines.push(l));
  assert.equal(n, 2);
  assert.ok(store.getPolicyDocument(hashOf(a)) && store.getPolicyDocument(hashOf(b)));
  assert.match(lines.join("\n"), /entry 1 skipped/);
});

test("a missing file or variable seeds nothing", () => {
  const store = openStore(":memory:");
  assert.equal(seedPolicies(store, "/nonexistent/.env", DECODER, () => {}), 0);
  assert.equal(seedPolicies(store, envFile("CRE_SOMETHING=1"), DECODER, () => {}), 0);
});
