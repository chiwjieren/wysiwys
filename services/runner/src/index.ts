import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";
import type { Idl } from "@anchor-lang/core";
import idl from "@wysiwys/shared/idl/wysiwys_guard.json" with { type: "json" };
import { loadConfig } from "./config";
import { createEventParser } from "./events";
import { Listener } from "./listener";
import { createStatusServer } from "./server";
import { openStore } from "./store";
import { HttpTrigger, LogTrigger } from "./trigger";

// Secrets (RPC key, trigger token) come from the root .env locally and from SSM on EC2.
try {
  process.loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env"));
} catch {
  // No .env: use the process environment.
}

const cfg = loadConfig();
const programId = new PublicKey(cfg.programId);
mkdirSync(dirname(cfg.dbPath), { recursive: true });
const store = openStore(cfg.dbPath);
const trigger = cfg.triggerUrl ? new HttpTrigger(cfg.triggerUrl, cfg.triggerToken ?? undefined) : new LogTrigger();
const listener = new Listener({
  connection: new Connection(cfg.rpcUrl, "finalized"),
  programId,
  store,
  parse: createEventParser({ ...(idl as Idl), address: cfg.programId }, programId),
  trigger,
  backfillIntervalMs: cfg.backfillIntervalMs,
});
const server = createStatusServer({ programId: cfg.programId, store, health: () => listener.health() });

console.log(`[runner] guard ${cfg.programId}, rpc ${new URL(cfg.rpcUrl).host}, db ${cfg.dbPath}`);
console.log(`[runner] trigger: ${cfg.triggerUrl ?? "none (log only)"}`);
await listener.start();
server.listen(cfg.port, () => console.log(`[runner] status on http://localhost:${cfg.port}/status`));

const shutdown = async () => {
  server.close();
  await listener.stop();
  store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
