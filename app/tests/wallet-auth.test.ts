import test from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, sign } from "node:crypto";
import {
  Keypair,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
} from "@solana/web3.js";
import { verifySignedSubmission, authenticate } from "../src/lib/auth/server";
import { requestMessage } from "../src/lib/auth/request-proof";
import { walletRpcFetch } from "../src/lib/auth/rpc-fetch";

// Ephemeral test keys only. No user wallet or network is accessed.
const signer = Keypair.generate();
const privateKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(signer.secretKey.slice(0, 32)),
  ]),
  format: "der",
  type: "pkcs8",
});
function transaction() {
  return new VersionedTransaction(
    new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [],
    }).compileToV0Message(),
  );
}
test("RPC submissions require every transaction signature to be valid", () => {
  const tx = transaction();
  assert.throws(() =>
    verifySignedSubmission(Buffer.from(tx.serialize()).toString("base64")),
  );
  tx.sign([signer]);
  assert.equal(
    verifySignedSubmission(Buffer.from(tx.serialize()).toString("base64")),
    signer.publicKey.toBase58(),
  );
  tx.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
  assert.throws(() =>
    verifySignedSubmission(Buffer.from(tx.serialize()).toString("base64")),
  );
  assert.throws(() => verifySignedSubmission("AA=="));
});
async function proof(
  body = '{"member":"test"}',
  nonce = crypto.randomUUID(),
  issuedAt = Date.now(),
) {
  const origin = "http://localhost:3001",
    path = "/api/squads/prepare",
    address = signer.publicKey.toBase58();
  const message = await requestMessage({
    origin,
    path,
    address,
    nonce,
    issuedAt,
    body,
  });
  return new Request(origin + path, {
    method: "POST",
    body,
    headers: {
      origin,
      "x-wallet-address": address,
      "x-wallet-nonce": nonce,
      "x-wallet-issued-at": String(issuedAt),
      "x-wallet-signature": sign(
        null,
        Buffer.from(message),
        privateKey,
      ).toString("base64"),
    },
  });
}
test("Guard request proofs bind the wallet, body, origin and path and cannot be replayed", async () => {
  const request = await proof();
  assert.equal(await authenticate(request), signer.publicKey.toBase58());
  await assert.rejects(authenticate(request), /already used/);
  const changedBody = await proof();
  await assert.rejects(
    authenticate(
      new Request(changedBody.url, {
        method: "POST",
        headers: changedBody.headers,
        body: "tampered",
      }),
    ),
  );
  const changedPath = await proof();
  await assert.rejects(
    authenticate(
      new Request("http://localhost:3001/api/squads/groups", {
        method: "POST",
        headers: changedPath.headers,
        body: await changedPath.text(),
      }),
    ),
  );
  const changedOrigin = await proof();
  changedOrigin.headers.set("origin", "http://attacker.invalid");
  await assert.rejects(authenticate(changedOrigin));
  await assert.rejects(
    authenticate(await proof("{}", crypto.randomUUID(), Date.now() - 120000)),
    /expired/,
  );
  await assert.rejects(authenticate(new Request("http://localhost")));
});
test("direct-wallet submissions require the current connected fee payer", async () => {
  const tx = transaction();
  tx.sign([signer]);
  let connected = true,
    sent = false;
  const rpc = walletRpcFetch(
    () => ({
      connected,
      address: signer.publicKey.toBase58(),
      assertConnected: () => {
        if (!connected) throw new Error("Wallet disconnected");
      },
    }),
    async () => {
      sent = true;
      return new Response();
    },
  );
  const input = {
    body: JSON.stringify({
      method: "sendTransaction",
      params: [Buffer.from(tx.serialize()).toString("base64")],
    }),
  };
  connected = false;
  await assert.rejects(rpc("http://localhost", input));
  assert.equal(sent, false);
  connected = true;
  await rpc("http://localhost", input);
  assert.equal(sent, true);
});

test("a live account switch blocks sending even when rendered state still names the old signer", async () => {
  const tx = transaction();
  tx.sign([signer]);
  const liveAddress = Keypair.generate().publicKey.toBase58();
  let sent = false;
  const rpc = walletRpcFetch(
    () => ({
      connected: true,
      address: signer.publicKey.toBase58(),
      assertConnected: (expected = liveAddress) => {
        if (expected !== liveAddress) throw new Error("Wallet session changed");
      },
    }),
    async () => {
      sent = true;
      return new Response();
    },
  );
  await assert.rejects(
    rpc("http://localhost", {
      body: JSON.stringify({
        method: "sendTransaction",
        params: [Buffer.from(tx.serialize()).toString("base64")],
      }),
    }),
    /session changed/,
  );
  assert.equal(sent, false);
});
test("missing or corrupted additional signatures cannot pass the RPC boundary", () => {
  const second = Keypair.generate();
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [
        SystemProgram.transfer({
          fromPubkey: second.publicKey,
          toPubkey: signer.publicKey,
          lamports: 1,
        }),
      ],
    }).compileToV0Message(),
  );
  tx.sign([signer]);
  assert.throws(() =>
    verifySignedSubmission(Buffer.from(tx.serialize()).toString("base64")),
  );
  tx.sign([second]);
  assert.equal(
    verifySignedSubmission(Buffer.from(tx.serialize()).toString("base64")),
    signer.publicKey.toBase58(),
  );
  tx.signatures[1][0] ^= 1;
  assert.throws(() =>
    verifySignedSubmission(Buffer.from(tx.serialize()).toString("base64")),
  );
});
test("only one concurrent Guard request proof is accepted, including Next bound-host URLs", async () => {
  const source = await proof();
  const request = new Request("http://0.0.0.0:3001/api/squads/prepare", {
    method: "POST",
    headers: source.headers,
    body: await source.text(),
  });
  request.headers.set("host", "localhost:3001");
  const results = await Promise.allSettled([
    authenticate(request),
    authenticate(request),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1,
  );
});
