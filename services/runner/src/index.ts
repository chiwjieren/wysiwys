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
import { createSettlement } from "./settlement";
import { CreRunner } from "./cre";
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
// In-process CRE simulation when configured; else a remote HTTP trigger; else log only.
const creRunner = cfg.cre ? new CreRunner(cfg.cre) : null;
const trigger = creRunner
  ? creRunner.asTrigger()
  : cfg.triggerUrl
    ? new HttpTrigger(cfg.triggerUrl, cfg.triggerToken ?? undefined)
    : new LogTrigger();
const connection = new Connection(cfg.rpcUrl, { commitment: "finalized", wsEndpoint: cfg.wsUrl ?? undefined });
const listener = new Listener({
  connection,
  programId,
  store,
  parse: createEventParser({ ...(idl as Idl), address: cfg.programId }, programId),
  trigger,
  backfillIntervalMs: cfg.backfillIntervalMs,
});
const server = createStatusServer({
  programId: cfg.programId,
  store,
  health: () => listener.health(),
  settlement: createSettlement({ connection, programId }),
  settlementToken: cfg.settlementToken,
  review: creRunner ?? undefined,
  reviewToken: cfg.reviewToken,
});

const ws = cfg.wsUrl ? new URL(cfg.wsUrl).host : `${new URL(cfg.rpcUrl).host} (derived)`;
console.log(`[runner] guard ${cfg.programId}, rpc ${new URL(cfg.rpcUrl).host}, ws ${ws}, db ${cfg.dbPath}`);
console.log(
  `[runner] trigger: ${cfg.cre ? `cre simulate ${cfg.cre.workflow} in ${cfg.cre.projectDir}${cfg.cre.broadcast ? " --broadcast" : ""}` : cfg.triggerUrl ? "http" : "none (log only)"}`,
);
console.log(`[runner] settlement routes: ${cfg.settlementToken ? "enabled" : "disabled (SETTLEMENT_TOKEN unset, 503)"}`);
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
