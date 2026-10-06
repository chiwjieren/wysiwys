import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CreRunner } from "../src/cre";

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, "fixtures/fake-cre.mjs");

const runner = (o: Partial<ConstructorParameters<typeof CreRunner>[0]> = {}) =>
  new CreRunner({
    command: [process.execPath, fake],
    projectDir: here,
    workflow: "review",
    target: "staging-settings",
    broadcast: true,
    timeoutMs: 5_000,
    ...o,
  });

const req = { multisig: "Boz5Dukxrwi5MGRam8bGimokhZwFRLHFdVeEsjaTLgPH", txIndex: "7" };

test("runs cre workflow simulate non-interactively with the identifiers as the HTTP payload", async () => {
  const r = await runner().run(req);
  assert.equal(r.ok, true);
  const args = JSON.parse(r.log.find((l) => l.startsWith("ARGS "))!.slice(5));
  assert.deepEqual(args, [
    "workflow", "simulate", "review", "--target", "staging-settings", "--non-interactive", "--trigger-index", "0",
    "--http-payload", JSON.stringify(req), "--broadcast",
  ]);
  assert.ok(r.log.some((l) => l === `CWD ${here}`));
});

test("omits --broadcast when disabled", async () => {
  const r = await runner({ broadcast: false }).run(req);
  assert.ok(!r.log.find((l) => l.startsWith("ARGS "))!.includes("--broadcast"));
});

test("redacts URLs from the returned log", async () => {
  const r = await runner().run(req);
  assert.ok(r.log.every((l) => !l.includes("SHOULD_NOT_LEAK")));
  assert.ok(r.log.some((l) => l.includes("<url>")));
});

test("a failing simulation is not ok and keeps its exit code", async () => {
  const r = await runner().run({ ...req, txIndex: "13" });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
  assert.ok(r.log.some((l) => l.includes("boom")));
});

test("a hanging simulation is killed at the timeout", async () => {
  const t0 = Date.now();
  const r = await runner({ timeoutMs: 500 }).run({ ...req, txIndex: "99" });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 4_000);
});

test("identical concurrent requests share one run; different ones run one at a time", async () => {
  const c = runner();
  const [a, b] = await Promise.all([c.run(req), c.run(req)]);
  assert.equal(a, b);
  const order: string[] = [];
  await Promise.all([
    c.run({ ...req, txIndex: "1" }).then(() => order.push("1")),
    c.run({ ...req, txIndex: "2" }).then(() => order.push("2")),
  ]);
  assert.deepEqual(order, ["1", "2"]);
});

test("rejects identifiers that are not a base58 key and a u64", async () => {
  await assert.rejects(runner().run({ multisig: "not a key; rm -rf /", txIndex: "1" }), /invalid/);
  await assert.rejects(runner().run({ ...req, txIndex: "1 --broadcast" }), /invalid/);
});

test("trigger adapter throws on a failed run so the listener retries", async () => {
  const t = runner().asTrigger();
  await t.send({ review: "R", ...req });
  await assert.rejects(t.send({ review: "R", ...req, txIndex: "13" }), /simulation failed/);
});
