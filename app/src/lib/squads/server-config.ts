import { readFile } from "node:fs/promises";
import path from "node:path";
import { PublicKey, clusterApiUrl } from "@solana/web3.js";
import type { SquadConfig } from "./sdk";
import type { GuardInitArgs } from "./groups";

export function parseDeployment(
  input: unknown,
  settlementEnabled: boolean,
): SquadConfig {
  if (!input || typeof input !== "object")
    throw new Error("Invalid deployment configuration.");
  const record = input as Record<string, unknown>;
  // devnet.json and the runner's group response name the guard program
  // `programId` and the executor `executorPda`; SquadConfig keeps its own names.
  const keys = {
    multisig: "multisig",
    guardProgram: "programId",
    executor: "executorPda",
  } as const;
  const addresses = {} as Record<keyof typeof keys, string>;
  try {
    for (const field of Object.keys(keys) as (keyof typeof keys)[]) {
      const value = record[keys[field]];
      if (typeof value !== "string") throw new Error();
      addresses[field] = new PublicKey(value).toBase58();
    }
  } catch {
    throw new Error(
      "Invalid deployment addresses. Expected multisig, programId and executorPda.",
    );
  }
  if (PublicKey.isOnCurve(new PublicKey(addresses.executor).toBytes()))
    throw new Error(
      "Guard executor must be a program-derived address, not a wallet.",
    );
  const vaultIndex = record.vaultIndex ?? 0;
  if (
    typeof vaultIndex !== "number" ||
    !Number.isInteger(vaultIndex) ||
    vaultIndex < 0 ||
    vaultIndex > 255
  )
    throw new Error("Invalid vault index.");
  return {
    ...addresses,
    vaultIndex,
    settlementEnabled,
    executionMode: "guarded",
    ...(record.mint === undefined &&
    (record.token as Record<string, unknown> | undefined)?.mint === undefined
      ? {}
      : { token: parseToken(record) }),
  };
}
function parseToken(record: Record<string, unknown>) {
  const token = record.token as Record<string, unknown> | undefined;
  try {
    // devnet.json keeps `mint` top level; the runner nests it in `token`.
    const mint = new PublicKey(
      (record.mint ?? token?.mint) as string,
    ).toBase58();
    const { symbol, decimals } = token ?? {};
    if (
      typeof symbol !== "string" ||
      !/^[A-Za-z0-9]{1,10}$/.test(symbol) ||
      typeof decimals !== "number" ||
      !Number.isInteger(decimals) ||
      decimals < 0 ||
      decimals > 9
    )
      throw new Error();
    return { mint, symbol, decimals };
  } catch {
    throw new Error("Invalid deployment token metadata.");
  }
}
// The deployment's GuardConfig values, applied to every guarded treasury.
export function parseGuardArgs(input: unknown): GuardInitArgs | undefined {
  const guard = (input as Record<string, unknown> | null)?.guard;
  if (guard === undefined) return undefined;
  try {
    const g = guard as Record<string, unknown>;
    const integer = (value: unknown) => {
      if (typeof value !== "string" || !/^\d{1,18}$/.test(value))
        throw new Error();
      return value;
    };
    const hex = (value: unknown, bytes: number) => {
      if (
        typeof value !== "string" ||
        value.length !== bytes * 2 ||
        !/^[0-9a-f]+$/.test(value)
      )
        throw new Error();
      return value;
    };
    return {
      forwarderProgram: new PublicKey(g.forwarderProgram as string).toBase58(),
      forwarderState: new PublicKey(g.forwarderState as string).toBase58(),
      policyHash: hex(g.policyHash, 32),
      workflowOwner: hex(g.workflowOwner, 20),
      maxReviewLifetime: integer(g.maxReviewLifetime),
      reviewDeadlineSecs: integer(g.reviewDeadlineSecs),
    };
  } catch {
    throw new Error("Invalid deployment guard configuration.");
  }
}
async function readDeployment(): Promise<unknown | null> {
  const configuredPath = process.env.WYSIWYS_DEPLOYMENT_PATH;
  let contents: string;
  try {
    contents = await readFile(
      /* turbopackIgnore: true */ configuredPath ||
        path.resolve(process.cwd(), "../deployments/devnet.json"),
      "utf8",
    );
  } catch (error) {
    if (!configuredPath && (error as NodeJS.ErrnoException).code === "ENOENT")
      return null;
    throw new Error("Deployment configuration could not be loaded.");
  }
  return JSON.parse(contents);
}
export async function loadConfig(): Promise<SquadConfig | null> {
  const raw = await readDeployment();
  return raw === null
    ? null
    : parseDeployment(raw, !!process.env.WYSIWYS_SETTLEMENT_URL);
}
export async function loadDeployment(): Promise<{
  config: SquadConfig;
  guardArgs?: GuardInitArgs;
} | null> {
  const raw = await readDeployment();
  return raw === null
    ? null
    : {
        config: parseDeployment(raw, !!process.env.WYSIWYS_SETTLEMENT_URL),
        guardArgs: parseGuardArgs(raw),
      };
}
// Prepare actions and the runner settlement route each one calls.
const RUNNER_PATHS = {
  propose: "frontend/propose",
  execute: "frontend/execute",
  // guarded_config_execute for a voted Squads config transaction.
  configExecute: "frontend/config-execute",
  // apply_policy_change for a voted policy change proposal.
  policyApply: "frontend/policy-apply",
} as const;
export type PrepareAction = keyof typeof RUNNER_PATHS;
export function runnerPath(action: PrepareAction) {
  return RUNNER_PATHS[action];
}
export function isPrepareRequest(input: unknown): input is {
  multisig: string;
  action: PrepareAction;
  index: string;
  member: unknown;
} {
  if (!input || typeof input !== "object") return false;
  const { action, index, multisig } = input as Record<string, unknown>;
  try {
    // The open treasury, bound into the wallet-signed request body.
    if (
      typeof multisig !== "string" ||
      new PublicKey(multisig).toBase58() !== multisig
    )
      return false;
  } catch {
    return false;
  }
  return (
    typeof action === "string" &&
    Object.hasOwn(RUNNER_PATHS, action) &&
    typeof index === "string" &&
    /^\d{1,20}$/.test(index) &&
    BigInt(index) >= 1n &&
    BigInt(index) <= 18446744073709551615n
  );
}
export function rpcUrl() {
  return process.env.SOLANA_RPC_URL || clusterApiUrl("devnet");
}
export function assertSameOrigin(request: Request) {
  const url = new URL(request.url);
  // Next dev binds to 0.0.0.0 and production sits behind Caddy (TLS ends there),
  // so browsers use the original Host header and the forwarded scheme.
  const host = request.headers.get("host") || url.host;
  const proto =
    request.headers.get("x-forwarded-proto")?.split(",")[0].trim() ||
    url.protocol.slice(0, -1);
  if (request.headers.get("origin") !== `${proto}://${host}`)
    throw new Error("Invalid request origin.");
}
// Instance-wide ceiling also bounds requests from callers that forge forwarded IPs.
let windowStart = 0;
let requests = 0;
export function rateLimit() {
  const now = Date.now();
  if (now - windowStart > 60000) {
    windowStart = now;
    requests = 0;
  }
  if (++requests > 300)
    throw new Error("Request limit reached. Try again shortly.");
}
