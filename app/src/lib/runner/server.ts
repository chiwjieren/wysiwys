import { PublicKey } from "@solana/web3.js";
import type { RunnerReview, RunnerStatus } from "./types";

// Server-only access to the runner's public read endpoints. The runner URL
// never leaves the server and upstream text is never echoed to the client.
export async function fetchRunner(
  path: "/status" | "/reviews?limit=50",
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
  };
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
