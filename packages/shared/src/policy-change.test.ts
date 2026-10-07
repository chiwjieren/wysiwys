import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha256";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  POLICY_CHANGE_MARKER_DISCRIMINATOR, POLICY_CHANGE_MARKER_LEN, SEEDS, decodePolicyChangeMarker, encodePolicyChangeMarker,
  policyChangePda, txIndexSeed,
} from "./index";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const filled = (n: number) => new Uint8Array(32).fill(n);

test("discriminator is sha256('global:policy_change_marker')[0..8]", () => {
  assert.equal(POLICY_CHANGE_MARKER_DISCRIMINATOR.length, 8);
  assert.deepEqual(POLICY_CHANGE_MARKER_DISCRIMINATOR, sha256(new TextEncoder().encode("global:policy_change_marker")).subarray(0, 8));
});

test("marker is 72 bytes: discriminator, new hash, expected hash", () => {
  const b = encodePolicyChangeMarker({ newPolicyHash: filled(1), expectedPolicyHash: filled(2) });
  assert.equal(POLICY_CHANGE_MARKER_LEN, 72);
  assert.equal(b.length, 72);
  assert.deepEqual(b.subarray(0, 8), POLICY_CHANGE_MARKER_DISCRIMINATOR);
  assert.deepEqual(b.subarray(8, 40), filled(1));
  assert.deepEqual(b.subarray(40, 72), filled(2));
});

test("marker round trips", () => {
  const m = { newPolicyHash: filled(7), expectedPolicyHash: filled(9) };
  assert.deepEqual(decodePolicyChangeMarker(encodePolicyChangeMarker(m)), m);
});

test("decode returns null for wrong length, wrong discriminator and equal hashes", () => {
  const good = encodePolicyChangeMarker({ newPolicyHash: filled(1), expectedPolicyHash: filled(2) });
  assert.equal(decodePolicyChangeMarker(good.subarray(0, 71)), null);
  assert.equal(decodePolicyChangeMarker(new Uint8Array([...good, 0])), null);
  assert.equal(decodePolicyChangeMarker(new Uint8Array(0)), null);
  const wrong = good.slice(); wrong[0] ^= 1;
  assert.equal(decodePolicyChangeMarker(wrong), null);
  const equal = good.slice(); equal.set(filled(1), 40);
  assert.equal(decodePolicyChangeMarker(equal), null);
});

test("encode rejects bad hash lengths and equal hashes", () => {
  assert.throws(() => encodePolicyChangeMarker({ newPolicyHash: new Uint8Array(31), expectedPolicyHash: filled(2) }));
  assert.throws(() => encodePolicyChangeMarker({ newPolicyHash: filled(1), expectedPolicyHash: new Uint8Array(33) }));
  assert.throws(() => encodePolicyChangeMarker({ newPolicyHash: filled(1), expectedPolicyHash: filled(1) }));
});

test("policyChangePda matches ['policy_change', multisig, u64 LE]", () => {
  assert.equal(SEEDS.policyChange, "policy_change");
  const program = Keypair.generate().publicKey;
  const multisig = Keypair.generate().publicKey;
  const [expected] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("policy_change"), multisig.toBytes(), txIndexSeed(258n)], program);
  assert.equal(policyChangePda(program, multisig, 258n).toBase58(), expected.toBase58());
  assert.notEqual(policyChangePda(program, multisig, 259n).toBase58(), expected.toBase58());
});

test("fixture bytes equal the encoder output", () => {
  const fx = JSON.parse(readFileSync(new URL("../fixtures/policy-change-marker.json", import.meta.url), "utf8"));
  assert.equal(fx.discriminatorHex, hex(POLICY_CHANGE_MARKER_DISCRIMINATOR));
  const newPolicyHash = Uint8Array.from(Buffer.from(fx.newPolicyHashHex, "hex"));
  const expectedPolicyHash = Uint8Array.from(Buffer.from(fx.expectedPolicyHashHex, "hex"));
  assert.equal(hex(encodePolicyChangeMarker({ newPolicyHash, expectedPolicyHash })), fx.markerHex);
  assert.equal(fx.markerHex.length, 144);
  assert.deepEqual(decodePolicyChangeMarker(Uint8Array.from(Buffer.from(fx.markerHex, "hex"))), { newPolicyHash, expectedPolicyHash });
});
