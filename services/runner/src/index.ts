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
import { createReviewVerifier } from "./delivery";
import { openStore } from "./store";
import { HttpTrigger, LogTrigger } from "./trigger";
import { GatewayTrigger } from "./gateway";
import { guardForwarderReader, PathFilteredTrigger } from "./path-filter";
import { LiveReviewRunner } from "./live-review";
import { ModeSwitch, type ReviewMode, type ReviewPath } from "./mode";

// Secrets (RPC key, trigger token) come from the root .env locally and from SSM on EC2.
try {
  process.loadEnvFile(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env"),
  );
} catch {
  // No .env: use the process environment.
}

const cfg = loadConfig();
const programId = new PublicKey(cfg.programId);
mkdirSync(dirname(cfg.dbPath), { recursive: true });
const store = openStore(cfg.dbPath);
// Live DON via the CRE gateway when configured; else in-process CRE simulation; else a remote HTTP trigger; else log only.
const connection = new Connection(cfg.rpcUrl, {
  commitment: "finalized",
  wsEndpoint: cfg.wsUrl ?? undefined,
});
const creRunner = cfg.cre
  ? new CreRunner({
      ...cfg.cre,
      verifyReview: createReviewVerifier(connection, programId),
    })
  : null;
const gateway = cfg.gateway ? new GatewayTrigger(cfg.gateway) : null;
const forwarderOf = guardForwarderReader(connection, programId);
const isDecided = createReviewVerifier(connection, programId);
// Review paths this runner can serve. Each skips treasuries whose GuardConfig names the other forwarder;
// the operator picks the active one (POST /admin/mode, remembered across restarts). Live is the default.
const paths: Partial<Record<ReviewMode, ReviewPath>> = {};
if (gateway && cfg.forwarders) {
  const forwarder = cfg.forwarders.live.program;
  paths.live = {
    forwarder,
    trigger: new PathFilteredTrigger(gateway, forwarderOf, forwarder),
    review: new LiveReviewRunner({ trigger: gateway, forwarderOf, liveForwarder: forwarder, isDecided }),
  };
}
if (creRunner && cfg.forwarders) {
  const forwarder = cfg.forwarders.simulator.program;
  paths.simulator = { forwarder, trigger: new PathFilteredTrigger(creRunner.asTrigger(), forwarderOf, forwarder), review: creRunner };
}
const reviewMode = Object.keys(paths).length
  ? new ModeSwitch({ paths, store, requeueWindowSecs: Number(cfg.guardSetup?.reviewDeadlineSecs ?? 900) })
  : null;
// Without forwarders in deployments/devnet.json: one unfiltered trigger, as before.
const trigger = reviewMode ?? gateway ?? creRunner?.asTrigger() ??
  (cfg.triggerUrl ? new HttpTrigger(cfg.triggerUrl, cfg.triggerToken ?? undefined) : new LogTrigger());
const reviewRunner = reviewMode ?? creRunner;
const listener = new Listener({
  connection,
  programId,
  store,
  parse: createEventParser(
    { ...(idl as Idl), address: cfg.programId },
    programId,
  ),
  trigger,
  backfillIntervalMs: cfg.backfillIntervalMs,
});
const server = createStatusServer({
  programId: cfg.programId,
  store,
  health: () => listener.health(),
  settlement: createSettlement({
    connection,
    programId,
    guardSetup: cfg.guardSetup,
    token: cfg.token,
  }),
  settlementToken: cfg.settlementToken,
  review: reviewRunner ?? undefined,
  reviewToken: cfg.reviewToken,
  reviewMode: reviewMode ?? undefined,
  adminToken: cfg.adminToken,
});

const ws = cfg.wsUrl
  ? new URL(cfg.wsUrl).host
  : `${new URL(cfg.rpcUrl).host} (derived)`;
console.log(
  `[runner] guard ${cfg.programId}, rpc ${new URL(cfg.rpcUrl).host}, ws ${ws}, db ${cfg.dbPath}`,
);
console.log(
  `[runner] review path: ${reviewMode ? `${reviewMode.mode} (only treasuries using forwarder ${reviewMode.forwarder}); available: ${reviewMode.available.join(", ")}; switch ${cfg.adminToken ? "enabled" : "disabled (ADMIN_TOKEN unset)"}` : "all treasuries (no forwarders in deployments/devnet.json)"}`,
);
console.log(
  `[runner] live: ${gateway ? `CRE gateway, workflow ${cfg.gateway!.workflowId.replace(/^0x/, "").slice(0, 12)}..., signer ${gateway.address}` : "off"}; simulator: ${cfg.cre ? `cre simulate ${cfg.cre.workflow}${cfg.cre.broadcast ? " --broadcast" : ""}` : "off"}${!reviewMode && cfg.triggerUrl ? "; http trigger" : ""}`,
);
console.log(
  `[runner] settlement routes: ${cfg.settlementToken ? "enabled" : "disabled (SETTLEMENT_TOKEN unset, 503)"}`,
);
await listener.start();
server.listen(cfg.port, () =>
  console.log(`[runner] status on http://localhost:${cfg.port}/status`),
);

const shutdown = async () => {
  server.close();
  await listener.stop();
  store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
