import { PublicKey } from "@solana/web3.js";
import {
  assertSameOrigin,
  isPrepareRequest,
  loadConfig,
  rateLimit,
} from "@/lib/squads/server-config";
import { fromWire, toWire, validateGuardInstruction } from "@/lib/squads/sdk";
import { callRunner, fetchGuardedGroup } from "@/lib/squads/guard-groups";
import { authenticate, AuthenticationError } from "@/lib/auth/server";
export const runtime = "nodejs";
const unavailable = () =>
  Response.json(
    { error: "Guard settlement adapter is not configured." },
    { status: 503 },
  );
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    rateLimit();
    const wallet = await authenticate(request);
    if (!process.env.WYSIWYS_SETTLEMENT_URL) return unavailable();
    const body = await request.text();
    if (body.length > 2048)
      return Response.json({ error: "Request is too large." }, { status: 413 });
    const input: unknown = JSON.parse(body);
    if (!isPrepareRequest(input))
      return Response.json(
        { error: "Invalid settlement request." },
        { status: 400 },
      );
    const member = new PublicKey(input.member as string);
    if (member.toBase58() !== wallet)
      throw new AuthenticationError(
        "Connect the request’s wallet to continue.",
      );
    // The open guarded treasury: the deployment's, or one the runner reports
    // as guarded by the deployed guard program.
    const deployment = await loadConfig();
    const config =
      deployment?.multisig === input.multisig
        ? deployment
        : await fetchGuardedGroup(input.multisig, deployment?.guardProgram);
    if (!config.guardProgram || !config.executor || !config.settlementEnabled)
      return unavailable();
    let prepared: { guardInstruction?: unknown };
    try {
      prepared = (await callRunner(`frontend/${input.action}`, {
        method: "POST",
        body: JSON.stringify({
          multisig: config.multisig,
          txIndex: input.index,
          member: member.toBase58(),
        }),
      })) as { guardInstruction?: unknown };
    } catch {
      return Response.json(
        { error: "The settlement service could not prepare this action." },
        { status: 409 },
      );
    }
    const guardInstruction = validateGuardInstruction(
      fromWire(prepared.guardInstruction as never),
      new PublicKey(config.guardProgram),
      new PublicKey(config.multisig),
      BigInt(input.index),
      member,
    );
    // Return only public instruction data. Never return arbitrary upstream fields.
    return Response.json(
      { guardInstruction: toWire(guardInstruction) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof AuthenticationError)
      return Response.json({ error: error.message }, { status: 401 });
    return Response.json(
      { error: "Settlement preparation failed. No transaction was submitted." },
      { status: 502 },
    );
  }
}
