import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Listener } from "./listener";
import type { CreRunner } from "./cre";
import { SettlementError, toWire, type Settlement } from "./settlement";
import type { Store } from "./store";
import type { ModeSwitch, ReviewMode } from "./mode";

type Deps = {
  programId: string;
  store: Store;
  health: Listener["health"];
  /** Settlement routes for the app; absent means they are not served (404). */
  settlement?: Settlement;
  /** Bearer token the app's server must send. Null with settlement present means fail closed (503). */
  settlementToken?: string | null;
  /** Runs one review (CRE simulation, or a live re-trigger in gateway mode); absent means POST /review is not served (404). */
  review?: Pick<CreRunner, "run">;
  /** Bearer token for POST /review. Null with review present means fail closed (503). */
  reviewToken?: string | null;
  /** Review path switch (live DON or simulator); shown on /status, switched by POST /admin/mode. */
  reviewMode?: Pick<ModeSwitch, "mode" | "available" | "forwarder" | "set">;
  /** Operator token for POST /admin/mode. Null with reviewMode present means fail closed (503). */
  adminToken?: string | null;
  rateLimitPerMinute?: number;
  log?: (line: string) => void;
};

const MAX_REVIEWS = 200;
const MAX_BODY = 2048;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "request too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

/** Fixed one-minute window per client address. */
function rateLimiter(limit: number) {
  const hits = new Map<string, { windowStart: number; count: number }>();
  return (client: string): boolean => {
    const now = Date.now();
    const h = hits.get(client);
    if (!h || now - h.windowStart >= 60_000) {
      hits.set(client, { windowStart: now, count: 1 });
      if (hits.size > 10_000) hits.clear();
      return true;
    }
    return ++h.count <= limit;
  };
}

/**
 * GET /status (503 when the listener is unhealthy), GET /reviews (history only) and, when configured,
 * the app's settlement routes under /frontend (bearer token, rate limited, identifiers only).
 */
export function createStatusServer(d: Deps): Server {
  const log = d.log ?? console.log;
  const allow = rateLimiter(d.rateLimitPerMinute ?? 60);

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  async function settlementRoute(req: IncomingMessage, url: URL): Promise<[number, unknown]> {
    const s = d.settlement!;
    if (!d.settlementToken) throw new HttpError(503, "settlement is not configured");
    if (!tokenMatches(req.headers.authorization, d.settlementToken)) throw new HttpError(401, "unauthorized");
    if (!allow(req.socket.remoteAddress ?? "unknown")) throw new HttpError(429, "too many requests");

    const groups = url.pathname.match(/^\/frontend\/groups\/([^/]+)$/);
    if (req.method === "GET" && groups && groups[1] !== "prepare") {
      const group = await s.guardedGroup(decodeURIComponent(groups[1]));
      return group ? [200, group] : [404, { error: "not a guarded group" }];
    }
    if (req.method !== "POST") throw new HttpError(405, "method not allowed");
    if (url.pathname === "/frontend/groups/prepare") {
      const { instruction, ...group } = await s.prepareGuardedGroup(await readJson(req));
      return [200, { ...group, guardInstruction: toWire(instruction) }];
    }
    if (url.pathname === "/frontend/propose") return [200, { guardInstruction: toWire(await s.requestReview(await readJson(req))) }];
    if (url.pathname === "/frontend/execute") return [200, { guardInstruction: toWire(await s.guardedExecute(await readJson(req))) }];
    if (url.pathname === "/frontend/config-execute") {
      return [200, { guardInstruction: toWire(await s.guardedConfigExecute(await readJson(req))) }];
    }
    throw new HttpError(404, "not found");
  }

  async function reviewRoute(req: IncomingMessage): Promise<[number, unknown]> {
    if (!d.reviewToken) throw new HttpError(503, "review runner is not configured");
    if (!tokenMatches(req.headers.authorization, d.reviewToken)) throw new HttpError(401, "unauthorized");
    if (!allow(req.socket.remoteAddress ?? "unknown")) throw new HttpError(429, "too many requests");
    const body = (await readJson(req)) as Record<string, unknown>;
    let result;
    try {
      result = await d.review!.run({ multisig: String(body?.multisig ?? ""), txIndex: String(body?.txIndex ?? "") });
    } catch (e) {
      if (e instanceof Error && /invalid/.test(e.message)) throw new HttpError(400, e.message);
      throw e;
    }
    // The outcome on chain is the truth; this is the run log for operators.
    return [result.ok ? 200 : 502, result];
  }

  const pathInfo = () => d.reviewMode && { mode: d.reviewMode.mode, available: d.reviewMode.available, forwarder: d.reviewMode.forwarder };

  async function adminModeRoute(req: IncomingMessage): Promise<[number, unknown]> {
    if (!d.adminToken) throw new HttpError(503, "review path switching is not configured");
    if (!tokenMatches(req.headers.authorization, d.adminToken)) throw new HttpError(401, "unauthorized");
    if (!allow(req.socket.remoteAddress ?? "unknown")) throw new HttpError(429, "too many requests");
    const mode = String(((await readJson(req)) as Record<string, unknown>)?.mode ?? "") as ReviewMode;
    try {
      d.reviewMode!.set(mode);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : "invalid mode");
    }
    log(`[server] review path set to ${mode} by operator`);
    return [200, pathInfo()];
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/admin/mode" && req.method === "POST" && d.reviewMode) {
        const [status, body] = await adminModeRoute(req);
        return send(res, status, body);
      }
      if (url.pathname === "/review" && req.method === "POST" && d.review) {
        const [status, body] = await reviewRoute(req);
        return send(res, status, body);
      }
      if (url.pathname.startsWith("/frontend/") && d.settlement) {
        const [status, body] = await settlementRoute(req, url);
        return send(res, status, body);
      }
      if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
      if (url.pathname === "/status") {
        const h = d.health();
        return send(res, h.ok ? 200 : 503, {
          ok: h.ok, programId: d.programId, listener: h, reviews: d.store.counts(),
          ...(d.reviewMode ? { reviewPath: pathInfo() } : {}),
        });
      }
      if (url.pathname === "/reviews") {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), MAX_REVIEWS);
        return send(res, 200, { reviews: d.store.listReviews(limit) });
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof HttpError || e instanceof SettlementError) return send(res, e.status, { error: e.message });
      // Never echo internal errors: they can carry RPC URLs with API keys.
      log(`[server] ${req.method} ${url.pathname} failed: ${e instanceof Error ? e.name : "error"}`);
      send(res, 502, { error: "settlement preparation failed" });
    }
  });
}
