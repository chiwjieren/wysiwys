import { rateLimit } from "@/lib/squads/server-config";
import { fetchRunner, sanitizeRunnerStatus } from "@/lib/runner/server";
import type { RunnerStatus } from "@/lib/runner/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
export async function GET() {
  try {
    rateLimit();
  } catch {
    return Response.json(
      { error: "Request limit reached. Try again shortly." },
      { status: 429, headers },
    );
  }
  const result = await fetchRunner("/status");
  if (result.kind === "unconfigured")
    return Response.json({ configured: false } satisfies RunnerStatus, {
      headers,
    });
  if (result.kind === "unreachable")
    return Response.json(
      {
        configured: true,
        reachable: false,
        ok: false,
        error: "Runner is unreachable.",
      } satisfies RunnerStatus,
      { status: 502, headers },
    );
  const status = sanitizeRunnerStatus(result.body);
  return Response.json(status, { status: status.ok ? 200 : 503, headers });
}
