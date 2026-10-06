import {
  assertSameOrigin,
  rateLimit,
  rpcUrl,
} from "@/lib/squads/server-config";
import { validateRpcRequest } from "@/lib/squads/rpc-policy";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    rateLimit();
    const body = await request.text();
    if (body.length > 65536)
      return Response.json({ error: "Request is too large." }, { status: 413 });
    const rpc = validateRpcRequest(JSON.parse(body));
    const upstream = await fetch(rpcUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rpc),
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!upstream.ok) throw new Error("RPC unavailable");
    const response = await upstream.json();
    if (response.error)
      response.error = {
        code: response.error.code || -32000,
        message: "Solana RPC rejected the request.",
      };
    return Response.json(response, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "RPC request could not be completed." },
      { status: 502 },
    );
  }
}
