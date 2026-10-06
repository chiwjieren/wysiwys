import { DatabaseSync } from "node:sqlite";
import type { GuardEvent } from "./events";

// History of guard events for the activity feed. The chain is the source of truth; this DB never is.

export type ReviewStatus = "pending" | "approved" | "rejected" | "executed";
export type TriggerStatus = "none" | "sent" | "failed";

export type ReviewRow = {
  review: string;
  multisig: string | null;
  tx_index: string | null;
  status: ReviewStatus;
  reason: number | null;
  tx_hash: string | null;
  tx_signature: string;
  updated_at: number;
  trigger_status: TriggerStatus;
  trigger_attempts: number;
  trigger_error: string | null;
};

export type EventMeta = { signature: string; idx: number; slot: number | null; blockTime: number | null };
export type TriggerRequest = { review: string; multisig: string; txIndex: string };

// One-way status order; an event never moves a review backwards (events can arrive out of order).
const RANK: Record<ReviewStatus, number> = { pending: 0, approved: 1, rejected: 1, executed: 2 };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reviews (
  review TEXT PRIMARY KEY,
  multisig TEXT,
  tx_index TEXT,
  status TEXT NOT NULL,
  reason INTEGER,
  tx_hash TEXT,
  tx_signature TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  trigger_status TEXT NOT NULL DEFAULT 'none',
  trigger_attempts INTEGER NOT NULL DEFAULT 0,
  trigger_error TEXT
);
CREATE TABLE IF NOT EXISTS events (
  signature TEXT NOT NULL,
  idx INTEGER NOT NULL,
  slot INTEGER,
  name TEXT NOT NULL,
  review TEXT NOT NULL,
  data TEXT NOT NULL,
  block_time INTEGER,
  PRIMARY KEY (signature, idx)
);
CREATE TABLE IF NOT EXISTS cursor (id INTEGER PRIMARY KEY CHECK (id = 1), last_signature TEXT);
`;

// node:sqlite returns null-prototype rows; callers get plain objects.
const plain = <T>(row: unknown): T => ({ ...(row as object) }) as T;

function statusOf(ev: GuardEvent): ReviewStatus {
  if (ev.name === "ReviewRequested") return "pending";
  if (ev.name === "Executed") return "executed";
  return ev.verdict === 1 ? "approved" : "rejected";
}

export function openStore(path: string) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);

  const insertEvent = db.prepare(
    "INSERT OR IGNORE INTO events (signature, idx, slot, name, review, data, block_time) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const selectReview = db.prepare("SELECT * FROM reviews WHERE review = ?");
  const insertReview = db.prepare(
    `INSERT INTO reviews (review, multisig, tx_index, status, reason, tx_hash, tx_signature, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const fillIdentifiers = db.prepare(
    `UPDATE reviews SET multisig = COALESCE(multisig, ?), tx_index = COALESCE(tx_index, ?), tx_hash = COALESCE(tx_hash, ?)
     WHERE review = ?`,
  );
  const advanceStatus = db.prepare(
    "UPDATE reviews SET status = ?, reason = COALESCE(?, reason), tx_signature = ?, updated_at = ? WHERE review = ?",
  );

  const getReview = (review: string) => {
    const row = selectReview.get(review);
    return row ? plain<ReviewRow>(row) : null;
  };

  /** Stores the event and updates its review. Returns false when this (signature, idx) was already stored. */
  function applyEvent(ev: GuardEvent, meta: EventMeta): boolean {
    const now = meta.blockTime ?? Math.floor(Date.now() / 1000);
    db.exec("BEGIN");
    try {
      const res = insertEvent.run(meta.signature, meta.idx, meta.slot, ev.name, ev.review, JSON.stringify(ev), meta.blockTime);
      if (res.changes === 0) {
        db.exec("ROLLBACK");
        return false;
      }
      const status = statusOf(ev);
      const reason = ev.name === "DecisionRecorded" ? ev.reason : null;
      const multisig = "multisig" in ev ? ev.multisig : null;
      const txIndex = "txIndex" in ev ? ev.txIndex : null;
      const txHash = ev.name === "ReviewRequested" ? ev.txHash : null;
      const existing = getReview(ev.review);
      if (!existing) {
        insertReview.run(ev.review, multisig, txIndex, status, reason, txHash, meta.signature, now);
      } else {
        fillIdentifiers.run(multisig, txIndex, txHash, ev.review);
        if (RANK[status] > RANK[existing.status]) advanceStatus.run(status, reason, meta.signature, now, ev.review);
      }
      db.exec("COMMIT");
      return true;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  const selectPendingTriggers = db.prepare(
    `SELECT review, multisig, tx_index AS txIndex FROM reviews
     WHERE status = 'pending' AND trigger_status IN ('none', 'failed') AND multisig IS NOT NULL AND tx_index IS NOT NULL
       AND trigger_attempts < ?
     ORDER BY updated_at`,
  );
  const updateTrigger = db.prepare(
    "UPDATE reviews SET trigger_status = ?, trigger_attempts = trigger_attempts + 1, trigger_error = ? WHERE review = ?",
  );
  const selectCursor = db.prepare("SELECT last_signature FROM cursor WHERE id = 1");
  const upsertCursor = db.prepare(
    "INSERT INTO cursor (id, last_signature) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET last_signature = excluded.last_signature",
  );
  const selectReviews = db.prepare("SELECT * FROM reviews ORDER BY updated_at DESC, rowid DESC LIMIT ?");
  const selectEvents = db.prepare("SELECT * FROM events ORDER BY block_time DESC, signature, idx LIMIT ?");
  const selectCounts = db.prepare("SELECT status, COUNT(*) AS n FROM reviews GROUP BY status");

  return {
    applyEvent,
    getReview,
    /** Pending reviews not yet triggered, or failed fewer than maxAttempts times. */
    pendingTriggers: (maxAttempts = 5) => selectPendingTriggers.all(maxAttempts).map((r) => plain<TriggerRequest>(r)),
    markTrigger: (review: string, ok: boolean, error?: string) =>
      void updateTrigger.run(ok ? "sent" : "failed", ok ? null : (error ?? "unknown error"), review),
    getCursor: () => ((selectCursor.get() as { last_signature: string } | undefined)?.last_signature ?? null),
    setCursor: (signature: string) => void upsertCursor.run(signature),
    listReviews: (limit = 50) => selectReviews.all(limit).map((r) => plain<ReviewRow>(r)),
    listEvents: (limit = 100) => selectEvents.all(limit).map((r) => plain<Record<string, unknown>>(r)),
    counts: () =>
      Object.fromEntries((selectCounts.all() as { status: string; n: number }[]).map((r) => [r.status, r.n])) as Partial<
        Record<ReviewStatus, number>
      >,
    close: () => db.close(),
  };
}

export type Store = ReturnType<typeof openStore>;
