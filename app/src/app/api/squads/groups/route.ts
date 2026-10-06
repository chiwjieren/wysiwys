import { Connection, PublicKey } from "@solana/web3.js";
import { standardGroupConfig } from "@/lib/squads/groups";
import { assertDevnet } from "@/lib/squads/network";
import { readMultisig, type SquadConfig } from "@/lib/squads/sdk";
import {
  assertSameOrigin,
  loadConfig,
  parseDeployment,
  rateLimit,
  rpcUrl,
} from "@/lib/squads/server-config";
import { authenticate, AuthenticationError } from "@/lib/auth/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function guardGroup(multisig: string, creator?: string) {
  const base = process.env.OMNICOUNTER_SETTLEMENT_URL;
  if (!base) throw new Error("Group protection is unavailable.");
  const url = new URL(
    creator ? "frontend/groups/prepare" : `frontend/groups/${multisig}`,
    base.endsWith("/") ? base : `${base}/`,
  );
  const response = await fetch(url, {
    method: creator ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.OMNICOUNTER_SETTLEMENT_TOKEN
        ? {
            Authorization: `Bearer ${process.env.OMNICOUNTER_SETTLEMENT_TOKEN}`,
          }
        : {}),
    },
    ...(creator ? { body: JSON.stringify({ multisig, creator }) } : {}),
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("Group protection is unavailable.");
  const result = await response.json();
  if (result.multisig !== multisig) throw new Error("Group binding mismatch.");
  // The owning service derives the executor with the shared guard contracts.
  return parseDeployment(result, result.guardReady === true);
}
async function standardGroup(multisig: string): Promise<SquadConfig> {
  const config: SquadConfig = {
    multisig,
    vaultIndex: 0,
    settlementEnabled: false,
    executionMode: "standard",
  };
  const rpc = new Connection(rpcUrl(), "finalized");
  await assertDevnet(rpc);
  const squad = await readMultisig(rpc, config);
  const standard = standardGroupConfig(multisig, squad.members);
  return standard || (await guardGroup(multisig));
}
export async function GET(request: Request) {
  try {
    rateLimit();
    const multisig = new PublicKey(
      new URL(request.url).searchParams.get("multisig") || "",
    ).toBase58();
    const deployment = await loadConfig();
    return Response.json(
      {
        config:
          deployment?.multisig === multisig
            ? deployment
            : await standardGroup(multisig),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      {
        error:
          "This group could not be opened. Check the invite link or try again later.",
      },
      { status: 503 },
    );
  }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    rateLimit();
    const wallet = await authenticate(request);
    const body = await request.text();
    if (body.length > 1024)
      return Response.json({ error: "Request is too large." }, { status: 413 });
    const input = JSON.parse(body);
    const multisig = new PublicKey(input.multisig).toBase58();
    const creator = new PublicKey(input.creator).toBase58();
    if (creator !== wallet)
      throw new AuthenticationError(
        "Connect the request’s wallet to continue.",
      );
    return Response.json(
      { config: await guardGroup(multisig, creator) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof AuthenticationError)
      return Response.json({ error: error.message }, { status: 401 });
    return Response.json(
      { error: "Group protection could not be prepared. Try again later." },
      { status: 503 },
    );
  }
}
