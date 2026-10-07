import { PublicKey } from "@solana/web3.js";
import type {
  RunnerReview,
  RunnerReviewMode,
  RunnerReviewPath,
  RunnerStatus,
} from "./types";

// Server-only access to the runner's public read endpoints. The runner URL
// never leaves the server and upstream text is never echoed to the client.
export async function fetchRunner(
  path: "/status" | "/reviews?limit=200",
): Promise<
  | { kind: "unconfigured" }
  | { kind: "unreachable" }
  | { kind: "ok"; status: number; body: unknown }
> {
  const base = process.env.WYSIWYS_SETTLEMENT_URL;
  if (!base) return { kind: "unconfigured" };
  try {
    const response = await fetch(
      new URL(path.slice(1), base.endsWith("/") ? base : base + "/"),
      { cache: "no-store", signal: AbortSignal.timeout(5000) },
    );
    const text = await response.text();
    if (text.length > 262144) return { kind: "unreachable" };
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      return { kind: "unreachable" };
    }
    return { kind: "ok", status: response.status, body };
  } catch {
    return { kind: "unreachable" };
  }
}

const record = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;

export function sanitizeRunnerStatus(
  input: unknown,
): Extract<RunnerStatus, { reachable: true }> {
  const body = record(input);
  const listener = record(body.listener);
  const reviews = record(body.reviews);
  const backfillFailed =
    typeof listener.lastBackfillError === "string" &&
    listener.lastBackfillError.length > 0;
  return {
    configured: true,
    reachable: true,
    ok: body.ok === true,
    listener: {
      subscribed: listener.subscribed === true,
      lastBackfillAt:
        typeof listener.lastBackfillAt === "number" &&
        Number.isSafeInteger(listener.lastBackfillAt) &&
        listener.lastBackfillAt > 0
          ? listener.lastBackfillAt
          : null,
      backfillFailed,
      backfillMessage: backfillFailed ? "The last backfill failed." : null,
    },
    reviews: {
      pending: count(reviews.pending),
      approved: count(reviews.approved),
      rejected: count(reviews.rejected),
      executed: count(reviews.executed),
    },
    ...(reviewPathOf(body.reviewPath)
      ? { reviewPath: reviewPathOf(body.reviewPath)! }
      : {}),
  };
}

const MODES: RunnerReviewMode[] = ["live", "simulator"];
const isMode = (value: unknown): value is RunnerReviewMode =>
  MODES.includes(value as RunnerReviewMode);
// Mode and available paths only; the runner's forwarder and any extra fields stay server-side.
function reviewPathOf(input: unknown): RunnerReviewPath | null {
  const path = record(input);
  if (!isMode(path.mode)) return null;
  const available = Array.isArray(path.available)
    ? MODES.filter((m) => (path.available as unknown[]).includes(m))
    : [];
  return { mode: path.mode, available };
}

/** A review path switch request from the status page: a known mode and the operator token. */
export function parseModeSwitch(
  input: unknown,
): { mode: RunnerReviewMode; token: string } | null {
  const body = record(input);
  if (!isMode(body.mode)) return null;
  if (
    typeof body.token !== "string" ||
    body.token.length === 0 ||
    body.token.length > 512
  )
    return null;
  return { mode: body.mode, token: body.token };
}

const SWITCH_ERRORS: Record<number, string> = {
  400: "This runner cannot serve that review path.",
  401: "Operator token rejected.",
  429: "Too many attempts. Try again shortly.",
  503: "Review path switching is not enabled on the runner.",
};

/**
 * Forwards the operator's switch to the runner (POST /admin/mode). The token is the operator's, typed
 * on the status page; the app holds no admin credential. Runner text is never echoed.
 */
export async function switchRunnerMode(request: {
  mode: RunnerReviewMode;
  token: string;
}): Promise<{
  status: number;
  body: { reviewPath: RunnerReviewPath } | { error: string };
}> {
  const base = process.env.WYSIWYS_SETTLEMENT_URL;
  if (!base)
    return { status: 503, body: { error: "Runner is not configured." } };
  try {
    const response = await fetch(
      new URL("admin/mode", base.endsWith("/") ? base : base + "/"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${request.token}`,
        },
        body: JSON.stringify({ mode: request.mode }),
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      },
    );
    const text = await response.text();
    if (response.ok) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Falls through to the generic error.
      }
      const reviewPath = reviewPathOf(parsed);
      if (reviewPath) return { status: 200, body: { reviewPath } };
    }
    const message = SWITCH_ERRORS[response.status];
    return message
      ? { status: response.status, body: { error: message } }
      : { status: 502, body: { error: "Runner could not switch the review path." } };
  } catch {
    return { status: 502, body: { error: "Runner is unreachable." } };
  }
}

const STATUSES = new Set(["pending", "approved", "rejected", "executed"]);
const TRIGGERS = new Set(["none", "sent", "failed"]);
function base58(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    return new PublicKey(value).toBase58() === value ? value : null;
  } catch {
    return null;
  }
}
// The treasury whose review history is requested (`?multisig=`), or null.
export function reviewsMultisig(url: URL) {
  return base58(url.searchParams.get("multisig"));
}

export function sanitizeRunnerReviews(
  input: unknown,
  multisig: string,
): RunnerReview[] {
  const rows = record(input).reviews;
  if (!Array.isArray(rows)) return [];
  const result: RunnerReview[] = [];
  for (const raw of rows.slice(0, 200)) {
    const row = record(raw);
    const review = base58(row.review);
    if (
      !review ||
      row.multisig !== multisig ||
      typeof row.tx_index !== "string" ||
      !/^\d{1,20}$/.test(row.tx_index) ||
      typeof row.status !== "string" ||
      !STATUSES.has(row.status) ||
      typeof row.updated_at !== "number" ||
      !Number.isSafeInteger(row.updated_at)
    )
      continue;
    const reason =
      typeof row.reason === "number" &&
      Number.isInteger(row.reason) &&
      row.reason >= 0 &&
      row.reason <= 65535
        ? row.reason
        : null;
    result.push({
      review,
      txIndex: row.tx_index,
      status: row.status as RunnerReview["status"],
      reason,
      updatedAt: row.updated_at,
      triggerStatus:
        typeof row.trigger_status === "string" &&
        TRIGGERS.has(row.trigger_status)
          ? (row.trigger_status as RunnerReview["triggerStatus"])
          : "none",
    });
  }
  return result;
}
