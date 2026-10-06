import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import idl from "@wysiwys/shared/idl/wysiwys_guard.json" with { type: "json" };

const here = dirname(fileURLToPath(import.meta.url));
const DEPLOYMENTS = resolve(here, "../../../deployments/devnet.json");

export type RunnerConfig = {
  programId: string;
  rpcUrl: string;
  port: number;
  dbPath: string;
  triggerUrl: string | null;
  triggerToken: string | null;
  backfillIntervalMs: number;
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
  const programId = (deployments ? JSON.parse(deployments).programId : undefined) ?? idl.address;
  return {
    programId,
    rpcUrl: env.HELIUS_DEVNET_RPC_URL || "https://api.devnet.solana.com",
    port: Number(env.PORT ?? 8787),
    dbPath: env.RUNNER_DB_PATH ?? resolve(here, "../data/runner.db"),
    triggerUrl: env.CRE_TRIGGER_URL || null,
    triggerToken: env.CRE_TRIGGER_TOKEN || null,
    backfillIntervalMs: Number(env.BACKFILL_INTERVAL_MS ?? 60_000),
  };
}
