import { PublicKey } from "@solana/web3.js";
import {
  assertSameOrigin,
  isPrepareRequest,
  loadConfig,
  rateLimit,
} from "@/lib/squads/server-config";
import { fromWire, validateGuardInstruction } from "@/lib/squads/sdk";
import { authenticate, AuthenticationError } from "@/lib/auth/server";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    rateLimit();
    const wallet = await authenticate(request);
    const config = await loadConfig();
    const base = process.env.OMNICOUNTER_SETTLEMENT_URL;
    if (!config || !config.guardProgram || !config.executor || !base)
      return Response.json(
        { error: "Guard settlement adapter is not configured." },
        { status: 503 },
      );
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
    const response = await fetch(
      new URL(
        `frontend/${input.action}`,
        base.endsWith("/") ? base : base + "/",
      ),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.OMNICOUNTER_SETTLEMENT_TOKEN
            ? {
                Authorization: `Bearer ${process.env.OMNICOUNTER_SETTLEMENT_TOKEN}`,
              }
            : {}),
        },
        body: JSON.stringify({
          multisig: config.multisig,
          txIndex: input.index,
          member: member.toBase58(),
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok)
      return Response.json(
        { error: "The settlement service could not prepare this action." },
        { status: 409 },
      );
    const prepared = await response.json();
    validateGuardInstruction(
      fromWire(prepared.guardInstruction),
      new PublicKey(config.guardProgram),
      new PublicKey(config.multisig),
      BigInt(input.index),
      member,
    );
    // Return only public instruction data. Never return arbitrary upstream fields.
    return Response.json(
      { guardInstruction: prepared.guardInstruction },
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
