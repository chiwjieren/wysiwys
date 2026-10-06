import { rateLimit } from "@/lib/squads/server-config";
import {
  fetchRunner,
  reviewsMultisig,
  sanitizeRunnerReviews,
} from "@/lib/runner/server";
import type { RunnerReviews } from "@/lib/runner/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
// Review history for the open treasury, passed as `?multisig=<base58>`.
export async function GET(request: Request) {
  try {
    rateLimit();
  } catch {
    return Response.json(
      { error: "Request limit reached. Try again shortly." },
      { status: 429, headers },
    );
  }
  const multisig = reviewsMultisig(new URL(request.url));
  if (!multisig)
    return Response.json(
      { error: "Choose a treasury address." },
      { status: 400, headers },
    );
  const result = await fetchRunner("/reviews?limit=200");
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
      reviews: sanitizeRunnerReviews(result.body, multisig),
    } satisfies RunnerReviews,
    { headers },
  );
}
