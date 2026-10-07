import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import idl from "@wysiwys/shared/idl/wysiwys_guard.json" with { type: "json" };
import type { GuardSetup, TokenInfo } from "./settlement";

const here = dirname(fileURLToPath(import.meta.url));
const DEPLOYMENTS = resolve(here, "../../../deployments/devnet.json");

export type RunnerConfig = {
  programId: string;
  rpcUrl: string;
  /** WebSocket for logsSubscribe; null lets web3.js derive it from rpcUrl (https -> wss, same host). */
  wsUrl: string | null;
  port: number;
  dbPath: string;
  triggerUrl: string | null;
  triggerToken: string | null;
  /** Bearer token the app's server sends to /frontend/*. Unset: those routes answer 503. */
  settlementToken: string | null;
  backfillIntervalMs: number;
  /** CRE review simulation; null unless CRE_PROJECT_DIR is set. */
  cre: { command: string[]; projectDir: string; workflow: string; target: string; broadcast: boolean; timeoutMs: number } | null;
  /** Deployed workflow on a live DON, triggered through the CRE gateway; null unless CRE_WORKFLOW_ID and its key are set. */
  gateway: { url: string; workflowId: string; privateKey: string } | null;
  /** Bearer token for POST /review. */
  reviewToken: string | null;
  /** GuardConfig values for treasuries created in the app (deployments/devnet.json `guard`). */
  guardSetup: GuardSetup | null;
  /** Treasury token (mUSD) for group descriptions. */
  token: TokenInfo | null;
};

const readOrNull = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/**
 * Program id: deployments/devnet.json owns addresses; before bootstrap writes it, the address in the
 * shared IDL (synced on every deploy) is used. Never from env, never hardcoded.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, read: (path: string) => string | null = readOrNull): RunnerConfig {
  const deployments = read(DEPLOYMENTS);
  const dep = deployments ? JSON.parse(deployments) : {};
  const programId = dep.programId ?? idl.address;
  return {
    programId,
    rpcUrl: env.HELIUS_DEVNET_RPC_URL || "https://api.devnet.solana.com",
    wsUrl: env.HELIUS_DEVNET_WS_URL || null,
    port: Number(env.PORT ?? 8787),
    dbPath: env.RUNNER_DB_PATH ?? resolve(here, "../data/runner.db"),
    triggerUrl: env.CRE_TRIGGER_URL || null,
    triggerToken: env.CRE_TRIGGER_TOKEN || null,
    settlementToken: env.SETTLEMENT_TOKEN || null,
    backfillIntervalMs: Number(env.BACKFILL_INTERVAL_MS ?? 60_000),
    cre: env.CRE_PROJECT_DIR
      ? {
          command: [env.CRE_BIN || "cre"],
          projectDir: env.CRE_PROJECT_DIR,
          workflow: env.CRE_WORKFLOW || "review",
          target: env.CRE_TARGET || "staging-settings",
          broadcast: env.CRE_BROADCAST !== "false",
          timeoutMs: Number(env.CRE_TIMEOUT_MS || 300_000),
        }
      : null,
    gateway:
      env.CRE_WORKFLOW_ID && env.CRE_GATEWAY_PRIVATE_KEY
        ? {
            url: env.CRE_GATEWAY_URL || "https://01.gateway.zone-a.cre.chain.link",
            workflowId: env.CRE_WORKFLOW_ID,
            privateKey: env.CRE_GATEWAY_PRIVATE_KEY,
          }
        : null,
    reviewToken: env.REVIEW_TOKEN || null,
    guardSetup: dep.guard ?? null,
    token: dep.mint && dep.token ? { mint: dep.mint, symbol: dep.token.symbol, decimals: dep.token.decimals } : null,
  };
}
