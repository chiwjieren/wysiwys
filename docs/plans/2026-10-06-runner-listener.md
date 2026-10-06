# Runner Listener Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A service that watches the Wysiwys guard on devnet, keeps a SQLite history of every review, fires the CRE trigger once per new review, and reports its own health.

**Architecture:** `services/runner` (Node, TypeScript, run with `tsx`). WebSocket `logsSubscribe` on the guard program at `finalized` for low latency, plus a `getSignaturesForAddress` backfill on startup and every minute so nothing is missed. Anchor events are parsed with the IDL from `packages/shared`. The SQLite DB is history, not truth.

**Tech Stack:** Node >= 22.13 (built-in `node:sqlite`), `@solana/web3.js` 1.99, `@anchor-lang/core` 1.2 (`EventParser`, `BorshCoder`), `node:http`, `node:test`.

**Spec:** `AGENTS.md` (Listener and runner), `docs/specs/guard-cre-interface.md` (events).

## Global Constraints

- Program ID comes from `deployments/devnet.json` (`programId`) when present, else the address in `packages/shared/idl/wysiwys_guard.json`. Never hardcode it.
- Only `finalized` data is stored or acted on.
- Trigger payload is identifiers only: `{ multisig, txIndex }`.
- Fail closed and visible: listener down means no trigger; `GET /status` returns 503 when the WebSocket is down or the last backfill is older than 2 minutes.
- Secrets (RPC keys, trigger token) only from env.

## Review Focus

1. The same event arrives from both the WebSocket and the backfill: stored once, trigger fired once.
2. `DecisionRecorded` or `Executed` processed before `ReviewRequested` (out of order): the row ends with the latest status and the identifiers filled in, never regressing (pending < approved/rejected < executed).
3. The trigger endpoint is down: the review stays `trigger_status = failed` and is retried on the next tick, not dropped.
4. A transaction with logs from other programs or failed transactions: ignored.
5. More than 1,000 signatures since the last run: backfill pages until it reaches the last processed signature.

## Files

| File | Responsibility |
|---|---|
| `services/runner/src/config.ts` | Env + program ID resolution |
| `services/runner/src/events.ts` | `parseGuardEvents(logs) -> GuardEvent[]` (pure) |
| `services/runner/src/store.ts` | SQLite schema, idempotent `applyEvent`, trigger bookkeeping |
| `services/runner/src/trigger.ts` | `HttpTrigger` (POST with bearer) and `LogTrigger` (no URL set) |
| `services/runner/src/listener.ts` | WebSocket subscription, backfill, trigger loop, health state |
| `services/runner/src/server.ts` | `GET /status`, `GET /reviews` |
| `services/runner/src/index.ts` | Wire up and start |
| `services/runner/test/*.test.ts` | Unit tests per module |

## DB schema

```sql
reviews(review TEXT PRIMARY KEY, multisig TEXT, tx_index TEXT, status TEXT NOT NULL, reason INTEGER,
        tx_hash TEXT, tx_signature TEXT, updated_at INTEGER NOT NULL,
        trigger_status TEXT NOT NULL DEFAULT 'none', trigger_attempts INTEGER NOT NULL DEFAULT 0, trigger_error TEXT)
events(signature TEXT NOT NULL, idx INTEGER NOT NULL, slot INTEGER, name TEXT NOT NULL, review TEXT NOT NULL,
       data TEXT NOT NULL, block_time INTEGER, PRIMARY KEY (signature, idx))
cursor(id INTEGER PRIMARY KEY CHECK (id = 1), last_signature TEXT)
```

`reviews` matches the AGENTS.md table plus trigger bookkeeping. `events` is the activity feed and the dedupe key.

## Tasks

- [x] **Task 1: events.** Tests build real Anchor log lines (`Program <id> invoke [1]`, `Program data: <base64>`, `Program <id> success`) with `BorshCoder` from the IDL and assert the parsed `ReviewRequested`, `DecisionRecorded`, `Executed` fields (pubkeys base58, u64 as decimal string, hashes hex). Events from another program id are ignored.
- [x] **Task 2: store.** In-memory SQLite. `applyEvent` is idempotent per `(signature, idx)`; status precedence pending < approved|rejected < executed; out-of-order events fill identifiers without regressing; `pendingTriggers()` returns reviews with `status = pending` and `trigger_status in (none, failed)`; `markTrigger(review, ok, error?)`.
- [x] **Task 3: trigger.** `HttpTrigger` POSTs `{ multisig, txIndex }` with `Authorization: Bearer`, throws on non-2xx (tested with a local `node:http` server).
- [x] **Task 4: listener.** Fake connection: backfill pages `getSignaturesForAddress` (`before`) until the cursor, processes oldest first, skips failed transactions, stores the newest signature as cursor; WebSocket callback path and backfill path dedupe; `runTriggers()` fires once per review and retries failures; health reflects WS state and last backfill time.
- [x] **Task 5: server + entry.** `GET /status` returns 200 with JSON when healthy, 503 when not. `GET /reviews?limit=` (max 200) serves history for the app's activity feed. `npm run dev --workspace=services/runner` starts against devnet.
