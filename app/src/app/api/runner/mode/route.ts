import { assertSameOrigin, rateLimit } from "@/lib/squads/server-config";
import { parseModeSwitch, switchRunnerMode } from "@/lib/runner/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
// Operator switch between the live Chainlink DON and the simulator. The operator token comes from the
// status page form and is only forwarded to the runner; the app holds no admin credential.
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    rateLimit();
  } catch {
    return Response.json({ error: "Request refused." }, { status: 403, headers });
  }
  const text = await request.text();
  if (text.length > 2048)
    return Response.json({ error: "Request is too large." }, { status: 413, headers });
  let input: unknown = null;
  try {
    input = JSON.parse(text);
  } catch {
    // Rejected below.
  }
  const parsed = parseModeSwitch(input);
  if (!parsed)
    return Response.json(
      { error: "Choose a review path and enter the operator token." },
      { status: 400, headers },
    );
  const result = await switchRunnerMode(parsed);
  return Response.json(result.body, { status: result.status, headers });
}
