import { loadConfig } from "@/lib/squads/server-config";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return Response.json(
      { config: await loadConfig() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "Deployment configuration is invalid or unavailable." },
      { status: 503 },
    );
  }
}
