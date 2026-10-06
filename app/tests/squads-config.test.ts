import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  parseDeployment,
  assertSameOrigin,
} from "../src/lib/squads/server-config";
const addresses = {
  multisig: Keypair.generate().publicKey.toBase58(),
  guardProgram: Keypair.generate().publicKey.toBase58(),
  executor: PublicKey.findProgramAddressSync(
    [Buffer.from("test")],
    Keypair.generate().publicKey,
  )[0].toBase58(),
};
test("deployment config exposes validated public addresses only", () => {
  assert.deepEqual(
    parseDeployment(
      { ...addresses, vaultIndex: 0, runnerToken: "secret", rpcUrl: "secret" },
      true,
    ),
    { ...addresses, vaultIndex: 0, settlementEnabled: true },
  );
  assert.throws(
    () => parseDeployment({ ...addresses, multisig: "sample" }, false),
    /deployment/i,
  );
  assert.throws(
    () => parseDeployment({ ...addresses, vaultIndex: 256 }, false),
    /vault/i,
  );
});
test("guard configuration rejects an on-curve wallet as the sole executor", () => {
  assert.throws(
    () =>
      parseDeployment(
        { ...addresses, executor: Keypair.generate().publicKey.toBase58() },
        false,
      ),
    /executor/i,
  );
});
test("same-origin checks support Next.js bound-host URLs while rejecting foreign browser origins", () => {
  assert.doesNotThrow(() =>
    assertSameOrigin(
      new Request("http://0.0.0.0:3105/api/squads/rpc", {
        headers: { host: "127.0.0.1:3105", origin: "http://127.0.0.1:3105" },
      }),
    ),
  );
  assert.throws(() =>
    assertSameOrigin(
      new Request("http://0.0.0.0:3105/api/squads/rpc", {
        headers: { host: "127.0.0.1:3105", origin: "http://evil.example" },
      }),
    ),
  );
});
test("transaction preparation rejects foreign origins", () => {
  assert.doesNotThrow(() =>
    assertSameOrigin(
      new Request("https://desk.example/api/squads/prepare", {
        headers: { origin: "https://desk.example" },
      }),
    ),
  );
  assert.throws(
    () =>
      assertSameOrigin(
        new Request("https://desk.example/api/squads/prepare", {
          headers: { origin: "https://other.example" },
        }),
      ),
    /origin/i,
  );
  assert.throws(
    () =>
      assertSameOrigin(new Request("https://desk.example/api/squads/prepare")),
    /origin/i,
  );
});
