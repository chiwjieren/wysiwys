import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { validateMemberInputs } from "../src/lib/squads/groups";

const me = Keypair.generate().publicKey.toBase58();
const w = () => Keypair.generate().publicKey.toBase58();

test("collects valid wallets and ignores empty fields", () => {
  const [a, b] = [w(), w()];
  const r = validateMemberInputs([a, "", `  ${b} `], me);
  assert.deepEqual(r.invitees, [a, b]);
  assert.deepEqual(r.errors, [null, null, null]);
  assert.equal(r.valid, true);
});

test("flags each bad field on its own line", () => {
  const a = w();
  const pda = PublicKey.findProgramAddressSync(
    [Buffer.from("x")],
    PublicKey.default,
  )[0].toBase58();
  const r = validateMemberInputs([a, "not-an-address", a, me, pda], me);
  assert.equal(r.errors[0], null);
  assert.match(r.errors[1]!, /valid Solana wallet/);
  assert.match(r.errors[2]!, /already added/);
  assert.match(r.errors[3]!, /your wallet/i);
  assert.match(r.errors[4]!, /wallet address/);
  assert.equal(r.valid, false);
  assert.deepEqual(r.invitees, [a]);
});

test("all fields empty is valid with no invitees (a treasury of one)", () => {
  const r = validateMemberInputs(["", " "], me);
  assert.deepEqual(r.invitees, []);
  assert.equal(r.valid, true);
});
