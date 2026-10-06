import { Connection, PublicKey } from "@solana/web3.js";
import { standardGroupConfig } from "@/lib/squads/groups";
import { assertDevnet } from "@/lib/squads/network";
import { readMultisig, type SquadConfig } from "@/lib/squads/sdk";
import {
  assertSameOrigin,
  loadDeployment,
  rateLimit,
  rpcUrl,
} from "@/lib/squads/server-config";
import {
  callRunner,
  fetchGuardedGroup,
  parseCreateGroupRequest,
  parsePreparedGroup,
  RunnerRequestError,
} from "@/lib/squads/guard-groups";
import { authenticate, AuthenticationError } from "@/lib/auth/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function standardGroup(
  multisig: string,
  guardProgram?: string,
): Promise<SquadConfig> {
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
  return standard || (await fetchGuardedGroup(multisig, guardProgram));
}
export async function GET(request: Request) {
  try {
    rateLimit();
    const multisig = new PublicKey(
      new URL(request.url).searchParams.get("multisig") || "",
    ).toBase58();
    const deployment = (await loadDeployment())?.config;
    return Response.json(
      {
        config:
          deployment?.multisig === multisig
            ? deployment
            : await standardGroup(multisig, deployment?.guardProgram),
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
// Prepares a guarded treasury: the runner builds initialize_guard for the new
// multisig, this route validates it, and the creator's wallet signs it in the
// same transaction as multisigCreateV2.
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    rateLimit();
    const wallet = await authenticate(request);
    const body = await request.text();
    if (body.length > 1024)
      return Response.json({ error: "Request is too large." }, { status: 413 });
    let input: ReturnType<typeof parseCreateGroupRequest>;
    try {
      input = parseCreateGroupRequest(JSON.parse(body));
    } catch {
      return Response.json(
        { error: "Invalid treasury request." },
        { status: 400 },
      );
    }
    if (input.creator !== wallet)
      throw new AuthenticationError(
        "Connect the request’s wallet to continue.",
      );
    const deployment = await loadDeployment();
    const prepared = parsePreparedGroup(
      await callRunner("frontend/groups/prepare", {
        method: "POST",
        body: JSON.stringify(input),
      }),
      input,
      {
        guardProgram: deployment?.config.guardProgram,
        guardArgs: deployment?.guardArgs,
      },
    );
    return Response.json(prepared, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof AuthenticationError)
      return Response.json({ error: error.message }, { status: 401 });
    if (error instanceof RunnerRequestError && error.status === 409)
      return Response.json(
        { error: "This treasury already has a guard configuration." },
        { status: 409 },
      );
    if (error instanceof RunnerRequestError && error.status === 400)
      return Response.json(
        { error: "Invalid treasury request." },
        { status: 400 },
      );
    return Response.json(
      { error: "Group protection could not be prepared. Try again later." },
      { status: 503 },
    );
  }
}
