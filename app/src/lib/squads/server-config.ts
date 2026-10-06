import { readFile } from "node:fs/promises";
import path from "node:path";
import { PublicKey, clusterApiUrl } from "@solana/web3.js";
import type { SquadConfig } from "./sdk";

export function parseDeployment(
  input: unknown,
  settlementEnabled: boolean,
): SquadConfig {
  if (!input || typeof input !== "object")
    throw new Error("Invalid deployment configuration.");
  const record = input as Record<string, unknown>;
  const keys = ["multisig", "guardProgram", "executor"] as const;
  const addresses = {} as Record<(typeof keys)[number], string>;
  try {
    for (const key of keys) {
      if (typeof record[key] !== "string") throw new Error();
      addresses[key] = new PublicKey(record[key]).toBase58();
    }
  } catch {
    throw new Error(
      "Invalid deployment addresses. Expected multisig, guardProgram and executor.",
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
  return { ...addresses, vaultIndex, settlementEnabled };
}
export async function loadConfig(): Promise<SquadConfig | null> {
  const configuredPath = process.env.OMNICOUNTER_DEPLOYMENT_PATH;
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
  return parseDeployment(
    JSON.parse(contents),
    !!process.env.OMNICOUNTER_SETTLEMENT_URL,
  );
}
export function rpcUrl() {
  return process.env.SOLANA_RPC_URL || clusterApiUrl("devnet");
}
export function assertSameOrigin(request: Request) {
  const expected = new URL(request.url);
  // Next dev binds to 0.0.0.0; browsers use the original Host header.
  const host = request.headers.get("host");
  if (host) expected.host = host;
  if (request.headers.get("origin") !== expected.origin)
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
