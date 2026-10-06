import { loadConfig, rateLimit } from "@/lib/squads/server-config";
import { fetchRunner, sanitizeRunnerReviews } from "@/lib/runner/server";
import type { RunnerReviews } from "@/lib/runner/types";
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
  let multisig: string | null = null;
  try {
    multisig = (await loadConfig())?.multisig ?? null;
  } catch {
    multisig = null;
  }
  const result = await fetchRunner("/reviews?limit=50");
  if (result.kind === "unconfigured")
    return Response.json(
      { configured: false, reviews: [] } satisfies RunnerReviews,
      { headers },
    );
  if (result.kind === "unreachable" || result.status !== 200)
    return Response.json(
      {
        configured: true,
        reachable: false,
        error: "Runner is unreachable.",
        reviews: [],
      } satisfies RunnerReviews,
      { status: 502, headers },
    );
  return Response.json(
    {
      configured: true,
      reachable: true,
      multisig,
      reviews: multisig ? sanitizeRunnerReviews(result.body, multisig) : [],
    } satisfies RunnerReviews,
    { headers },
  );
}
