import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  parseDeployment,
  assertSameOrigin,
  isPrepareRequest,
} from "../src/lib/squads/server-config";
import { assetLabel } from "../src/lib/squads/payments";
test("settlement preparation accepts propose and execute for the open treasury without a trade id", () => {
  const member = Keypair.generate().publicKey.toBase58();
  const multisig = Keypair.generate().publicKey.toBase58();
  assert.ok(
    isPrepareRequest({ multisig, action: "propose", index: "1", member }),
  );
  assert.ok(
    isPrepareRequest({ multisig, action: "execute", index: "42", member }),
  );
  assert.ok(
    isPrepareRequest({
      multisig,
      action: "propose",
      index: "18446744073709551615",
      member,
    }),
  );
  for (const bad of [
    { multisig, action: "vote", index: "1", member },
    { multisig, action: "propose", index: "0", member },
    { multisig, action: "propose", index: "-1", member },
    { multisig, action: "propose", index: "1.5", member },
    { multisig, action: "propose", index: 1, member },
    { multisig, action: "execute", index: "18446744073709551616", member },
    { action: "propose", index: "1", member },
    { multisig: "not-a-key", action: "propose", index: "1", member },
    { multisig: 42, action: "propose", index: "1", member },
    null,
  ])
    assert.equal(isPrepareRequest(bad), false);
});
const deployment = {
  multisig: Keypair.generate().publicKey.toBase58(),
  programId: Keypair.generate().publicKey.toBase58(),
  executorPda: PublicKey.findProgramAddressSync(
    [Buffer.from("test")],
    Keypair.generate().publicKey,
  )[0].toBase58(),
};
const addresses = deployment;
test("deployment config maps devnet.json keys to validated public addresses only", () => {
  assert.deepEqual(
    parseDeployment(
      { ...addresses, vaultIndex: 0, runnerToken: "secret", rpcUrl: "secret" },
      true,
    ),
    {
      multisig: deployment.multisig,
      guardProgram: deployment.programId,
      executor: deployment.executorPda,
      vaultIndex: 0,
      settlementEnabled: true,
      executionMode: "guarded",
    },
  );
  assert.throws(
    () =>
      parseDeployment(
        {
          multisig: deployment.multisig,
          guardProgram: deployment.programId,
          executor: deployment.executorPda,
        },
        false,
      ),
    /deployment/i,
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
        {
          ...addresses,
          executorPda: Keypair.generate().publicKey.toBase58(),
        },
        false,
      ),
    /executor/i,
  );
});
test("runner group responses parse as guarded group configs", () => {
  const config = parseDeployment(
    { ...deployment, vaultIndex: 0, guardReady: true },
    true,
  );
  assert.equal(config.guardProgram, deployment.programId);
  assert.equal(config.executor, deployment.executorPda);
  assert.equal(config.executionMode, "guarded");
  assert.equal(config.settlementEnabled, true);
});
test("the checked-in devnet deployment parses", async () => {
  const { readFile } = await import("node:fs/promises");
  const raw = JSON.parse(
    await readFile(
      new URL("../../deployments/devnet.json", import.meta.url),
      "utf8",
    ),
  );
  const config = parseDeployment(raw, false);
  assert.equal(config.multisig, raw.multisig);
  assert.equal(config.executor, raw.executorPda);
  assert.equal(config.guardProgram, raw.programId);
  assert.deepEqual(config.token, {
    mint: raw.mint,
    symbol: raw.token.symbol,
    decimals: raw.token.decimals,
  });
});
test("deployment token metadata is optional and validated", () => {
  const mint = Keypair.generate().publicKey.toBase58();
  const token = { name: "Mock USD", symbol: "mUSD", uri: "", decimals: 6 };
  assert.deepEqual(
    parseDeployment({ ...deployment, mint, token }, false).token,
    {
      mint,
      symbol: "mUSD",
      decimals: 6,
    },
  );
  assert.equal(parseDeployment(deployment, false).token, undefined);
  for (const bad of [
    { mint: "nope", token },
    { mint, token: { ...token, symbol: "<script>" } },
    { mint, token: { ...token, symbol: "" } },
    { mint, token: { ...token, decimals: 20 } },
  ])
    assert.throws(
      () => parseDeployment({ ...deployment, ...bad }, false),
      /token/i,
    );
});
test("amount labels use the deployment symbol only for the deployment mint", () => {
  const mint = Keypair.generate().publicKey.toBase58();
  const config = { token: { mint, symbol: "mUSD", decimals: 6 } };
  assert.equal(assetLabel(config, mint), "mUSD");
  assert.equal(
    assetLabel(config, Keypair.generate().publicKey.toBase58()),
    "tokens",
  );
  assert.equal(assetLabel(undefined, mint), "tokens");
  assert.equal(assetLabel(config, undefined), "SOL");
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
