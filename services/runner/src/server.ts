import { createServer, type Server } from "node:http";
import type { Listener } from "./listener";
import type { Store } from "./store";

type Deps = { programId: string; store: Store; health: Listener["health"] };

const MAX_REVIEWS = 200;

/** GET /status (503 when the listener is unhealthy, so monitors see it) and GET /reviews (history only). */
export function createStatusServer({ programId, store, health }: Deps): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "GET") return send(405, { error: "method not allowed" });
    if (url.pathname === "/status") {
      const h = health();
      return send(h.ok ? 200 : 503, { ok: h.ok, programId, listener: h, reviews: store.counts() });
    }
    if (url.pathname === "/reviews") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), MAX_REVIEWS);
      return send(200, { reviews: store.listReviews(limit) });
    }
    send(404, { error: "not found" });
  });
}
