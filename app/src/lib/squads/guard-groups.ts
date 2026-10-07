import * as sqds from "@sqds/multisig";
import { PublicKey } from "@solana/web3.js";
import { validateInitializeGuard, type GuardInitArgs } from "./groups";
import {
  fromWire,
  toWire,
  type SquadConfig,
  type WireInstruction,
} from "./sdk";
import { parseDeployment } from "./server-config";

// Server-side helpers for guarded treasuries opened or created through the
// runner. Runner responses are validated here; upstream text is never echoed.

export class RunnerRequestError extends Error {
  constructor(
    readonly status: number,
    kind: "http" | "configuration" | "connection" | "response" = "http",
  ) {
    super(
      kind === "configuration"
        ? "Treasury protection is not configured. Contact the app operator."
        : kind === "connection"
          ? "The treasury protection service is unreachable. Try again shortly."
          : kind === "response"
            ? "The treasury protection service returned an invalid response. Contact the app operator."
            : status === 401 || status === 403
              ? "Treasury protection authentication failed. Contact the app operator."
              : "The treasury protection service is unavailable. Try again shortly.",
    );
  }
}

const base58 = (value: unknown) => new PublicKey(value as string).toBase58();

export function parseCreateGroupRequest(input: unknown) {
  if (!input || typeof input !== "object")
    throw new Error("Invalid group request.");
  const record = input as Record<string, unknown>;
  const multisig = base58(record.multisig);
  const creator = base58(record.creator);
  const createKey = base58(record.createKey);
  if (
    creator === createKey ||
    sqds
      .getMultisigPda({ createKey: new PublicKey(createKey) })[0]
      .toBase58() !== multisig
  )
    throw new Error("The group address does not match its create key.");
  return { multisig, creator, createKey };
}

// A runner group response for an existing guarded treasury.
export function parseRunnerGroup(
  result: unknown,
  multisig: string,
  guardProgram?: string,
): SquadConfig {
  const record = (result ?? {}) as Record<string, unknown>;
  if (record.multisig !== multisig) throw new Error("Group binding mismatch.");
  const config = parseDeployment(record, record.guardReady === true);
  const [executor] = PublicKey.findProgramAddressSync(
    [Buffer.from("executor"), new PublicKey(multisig).toBuffer()],
    new PublicKey(config.guardProgram!),
  );
  if (
    (guardProgram && config.guardProgram !== guardProgram) ||
    config.executor !== executor.toBase58()
  )
    throw new Error("The group is not protected by the deployed guard.");
  return config;
}

// The runner's prepared initialize_guard for a treasury about to be created.
export function parsePreparedGroup(
  result: unknown,
  request: { multisig: string; creator: string; createKey: string },
  deployment?: { guardProgram?: string; guardArgs?: GuardInitArgs },
): { config: SquadConfig; guardInstruction: WireInstruction } {
  const config = parseRunnerGroup(
    result,
    request.multisig,
    deployment?.guardProgram,
  );
  const { guardInstruction } = validateInitializeGuard(
    fromWire(
      (result as { guardInstruction: WireInstruction }).guardInstruction,
    ),
    {
      guardProgram: new PublicKey(config.guardProgram!),
      multisig: new PublicKey(request.multisig),
      createKey: new PublicKey(request.createKey),
      creator: new PublicKey(request.creator),
      executor: new PublicKey(config.executor!),
      args: deployment?.guardArgs,
    },
  );
  // The guard is not live until the creation transaction lands.
  return {
    config: { ...config, settlementEnabled: false },
    guardInstruction: toWire(guardInstruction),
  };
}

export async function callRunner(
  path: string,
  init: { method: "GET" } | { method: "POST"; body: string },
): Promise<unknown> {
  const base = process.env.WYSIWYS_SETTLEMENT_URL;
  if (!base || !process.env.WYSIWYS_SETTLEMENT_TOKEN)
    throw new RunnerRequestError(503, "configuration");
  let response: Response;
  try {
    response = await fetch(
      new URL(path, base.endsWith("/") ? base : `${base}/`),
      {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(process.env.WYSIWYS_SETTLEMENT_TOKEN
            ? {
                Authorization: `Bearer ${process.env.WYSIWYS_SETTLEMENT_TOKEN}`,
              }
            : {}),
        },
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      },
    );
  } catch {
    throw new RunnerRequestError(503, "connection");
  }
  if (!response.ok) throw new RunnerRequestError(response.status);
  try {
    return await response.json();
  } catch {
    throw new RunnerRequestError(502, "response");
  }
}

export async function fetchGuardedGroup(
  multisig: string,
  guardProgram?: string,
): Promise<SquadConfig> {
  return parseRunnerGroup(
    await callRunner(`frontend/groups/${multisig}`, { method: "GET" }),
    multisig,
    guardProgram,
  );
}
