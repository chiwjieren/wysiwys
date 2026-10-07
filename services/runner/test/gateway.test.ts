import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { evmAddress, GatewayTrigger, personalSign, stableStringify } from "../src/gateway";

// web3.js accounts docs vector: this key, address, and the signature of "Some data" (v = 0x1c).
const KEY = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const ADDRESS = "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23";
const SOME_DATA_SIG =
  "b91467e570a6466aa9e9876cbcd013baba02900b8979d43fe208a4a4f339f5fd6007e74cd82e037b800186422fc2da167c747ef045e5d18a5f5d4300f8e1a0291c";
const WORKFLOW_ID = "ab".repeat(32);
const b64url = (s: string) => Buffer.from(s, "base64url");

test("derives the EIP-55 checksummed address", () => {
  assert.equal(evmAddress(KEY), ADDRESS);
});

test("personal_sign matches the known vector, with recovery id 0/1 as the CRE gateway expects", () => {
  const sig = personalSign("Some data", KEY);
  assert.equal(sig.length, 65);
  assert.equal(Buffer.from(sig.subarray(0, 64)).toString("hex"), SOME_DATA_SIG.slice(0, 128));
  assert.equal(sig[64], 0x1c - 27);
});

test("stable JSON sorts keys at every level", () => {
  assert.equal(stableStringify({ b: 1, a: { d: [{ z: 1, y: 2 }], c: "x" } }), '{"a":{"c":"x","d":[{"y":2,"z":1}]},"b":1}');
});

async function withGateway(
  reply: { status: number; body: unknown },
  fn: (url: string, seen: { req?: IncomingMessage; body?: string }) => Promise<void>,
) {
  const seen: { req?: IncomingMessage; body?: string } = {};
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.req = req;
      seen.body = body;
      res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, seen);
  } finally {
    server.close();
  }
}

const request = { review: "Rev1", multisig: "Ms1111111111111111111111111111111", txIndex: "7" };
const accepted = { status: 200, body: { jsonrpc: "2.0", id: "x", result: { workflow_id: `0x${WORKFLOW_ID}`, status: "ACCEPTED" } } };
const trigger = (url: string) =>
  new GatewayTrigger({ url, workflowId: WORKFLOW_ID, privateKey: KEY, now: () => 1_800_000_000, uuid: () => "11111111-2222-4333-8444-555555555555" });

test("sends workflows.execute with identifiers only, signed by the trigger key", async () => {
  await withGateway(accepted, async (url, seen) => {
    await trigger(url).send(request);
    const body = JSON.parse(seen.body!);
    assert.equal(seen.body, stableStringify(body));
    assert.deepEqual(body, {
      id: "11111111-2222-4333-8444-555555555555",
      jsonrpc: "2.0",
      method: "workflows.execute",
      params: { input: { multisig: request.multisig, txIndex: "7" }, workflow: { workflowID: WORKFLOW_ID } },
    });

    const auth = seen.req!.headers.authorization!;
    assert.match(auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const [h, p, s] = auth.slice("Bearer ".length).split(".");
    assert.deepEqual(JSON.parse(b64url(h!).toString()), { alg: "ETH", typ: "JWT" });
    const payload = JSON.parse(b64url(p!).toString());
    assert.equal(payload.digest, `0x${createHash("sha256").update(seen.body!).digest("hex")}`);
    assert.equal(payload.iss, ADDRESS);
    assert.equal(payload.iat, 1_800_000_000);
    assert.equal(payload.exp, 1_800_000_300);
    assert.equal(payload.jti, "11111111-2222-4333-8444-555555555555");

    // The signature recovers to the trigger address over the EIP-191 hash of "header.payload".
    const sig = b64url(s!);
    assert.equal(sig.length, 65);
    const message = `${h}.${p}`;
    const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${message.length}`), Buffer.from(message)]));
    const pub = secp256k1.Signature.fromCompact(sig.subarray(0, 64)).addRecoveryBit(sig[64]!).recoverPublicKey(digest).toRawBytes(false);
    assert.equal(`0x${Buffer.from(keccak_256(pub.subarray(1)).subarray(-20)).toString("hex")}`, ADDRESS.toLowerCase());
  });
});

test("throws when the gateway does not accept the execution, so the listener retries", async () => {
  for (const reply of [
    { status: 400, body: { jsonrpc: "2.0", id: "x", error: { code: -32600, message: "unauthorized key" } } },
    { status: 200, body: { jsonrpc: "2.0", id: "x", error: { code: -32000, message: "workflow paused" } } },
    { status: 200, body: { jsonrpc: "2.0", id: "x", result: { status: "REJECTED" } } },
  ]) {
    await withGateway(reply, async (url) => {
      await assert.rejects(trigger(url).send(request), /gateway/);
    });
  }
});

test("rejects a malformed workflow id or private key at construction", () => {
  assert.throws(() => new GatewayTrigger({ url: "https://x", workflowId: "0x1234", privateKey: KEY }), /workflow id/);
  assert.throws(() => new GatewayTrigger({ url: "https://x", workflowId: WORKFLOW_ID, privateKey: "0x12" }), /private key/);
  // A 0x prefix on the workflow id is tolerated and stripped (the gateway wants 64 hex characters).
  assert.doesNotThrow(() => new GatewayTrigger({ url: "https://x", workflowId: `0x${WORKFLOW_ID}`, privateKey: KEY }));
});
