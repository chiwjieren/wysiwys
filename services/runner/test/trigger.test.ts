import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpTrigger, LogTrigger } from "../src/trigger";

async function withServer(status: number, fn: (url: string, seen: { req?: IncomingMessage; body?: string }) => Promise<void>) {
  const seen: { req?: IncomingMessage; body?: string } = {};
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.req = req;
      seen.body = body;
      res.writeHead(status).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/trigger`, seen);
  } finally {
    server.close();
  }
}

const request = { review: "Rev1", multisig: "Ms1", txIndex: "7" };

test("HttpTrigger POSTs identifiers only, with the bearer token", async () => {
  await withServer(200, async (url, seen) => {
    await new HttpTrigger(url, "tok").send(request);
    assert.equal(seen.req!.method, "POST");
    assert.equal(seen.req!.headers.authorization, "Bearer tok");
    assert.equal(seen.req!.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(seen.body!), { multisig: "Ms1", txIndex: "7" });
  });
});

test("HttpTrigger omits the Authorization header without a token", async () => {
  await withServer(200, async (url, seen) => {
    await new HttpTrigger(url).send(request);
    assert.equal(seen.req!.headers.authorization, undefined);
  });
});

test("HttpTrigger throws on a non-2xx response", async () => {
  await withServer(500, async (url) => {
    await assert.rejects(new HttpTrigger(url).send(request), /500/);
  });
});

test("HttpTrigger throws when the endpoint is unreachable", async () => {
  await assert.rejects(new HttpTrigger("http://127.0.0.1:1/trigger", undefined, 500).send(request));
});

test("LogTrigger records what would be sent", async () => {
  const lines: string[] = [];
  await new LogTrigger((l) => lines.push(l)).send(request);
  assert.match(lines[0], /Ms1/);
  assert.match(lines[0], /7/);
});
