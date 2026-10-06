# @wysiwys/runner

EC2 service: listener for the Wysiwys guard, CRE trigger and SQLite history. Plan: `docs/plans/2026-10-06-runner-listener.md`.

- Listens to the guard program at `finalized`: WebSocket `logsSubscribe` plus a `getSignaturesForAddress` backfill on startup and every minute from a stored cursor.
- Stores `ReviewRequested`, `DecisionRecorded` and `Executed` in SQLite (`reviews`, `events`). History only; the chain is the truth.
- With `CRE_PROJECT_DIR` set, runs `cre workflow simulate <CRE_WORKFLOW> --target <CRE_TARGET> --non-interactive --trigger-index 0 --http-payload {multisig,txIndex} [--broadcast]` for each new Pending review: one at a time, identical requests share a run, hard timeout, URLs redacted from the kept log, up to 5 attempts. `POST /review { multisig, txIndex }` (bearer `REVIEW_TOKEN`) reruns one and returns the sanitized log.
- Otherwise sends one HTTP trigger per new Pending review (`POST { multisig, txIndex }`, bearer token); failures are retried every tick.
- Settlement routes for the app (bearer `SETTLEMENT_TOKEN`, rate limited, identifiers only): `POST /frontend/propose` returns `request_review`, `POST /frontend/execute` returns `guarded_execute` (Approved reviews only), `GET /frontend/groups/:multisig` describes a guarded group, `POST /frontend/groups/prepare { multisig, creator, createKey }` returns `initialize_guard` (with this deployment's guard values) for a treasury the app creates in the same transaction as `multisigCreateV2`.
- `GET /status`: 200 when subscribed and the last backfill is under 2 minutes old, else 503. `GET /reviews?limit=`: review history.

```bash
npm run dev --workspace=services/runner     # needs Node >= 22.13 (node:sqlite)
npm test --workspace=services/runner
```

Env (root `.env` locally, SSM on EC2):

| Var | Default |
|---|---|
| `HELIUS_DEVNET_RPC_URL` | `https://api.devnet.solana.com` |
| `HELIUS_DEVNET_WS_URL` | derived from the RPC URL (`https` to `wss`, same host) |
| `PORT` | `8787` |
| `RUNNER_DB_PATH` | `services/runner/data/runner.db` |
| `CRE_TRIGGER_URL` | unset: triggers are logged, not sent |
| `CRE_TRIGGER_TOKEN` | unset |
| `BACKFILL_INTERVAL_MS` | `60000` |
| `SETTLEMENT_TOKEN` | unset: `/frontend/*` routes answer 503 |
| `CRE_PROJECT_DIR` | unset: no CRE runner (HTTP or log trigger instead) |
| `CRE_WORKFLOW`, `CRE_TARGET` | `review`, `staging-settings` |
| `CRE_BROADCAST` | `true` (`false` for dry runs) |
| `CRE_BIN`, `CRE_TIMEOUT_MS` | `cre`, `300000` |
| `REVIEW_TOKEN` | unset: `POST /review` answers 503 |

The guard program id comes from `deployments/devnet.json`, else the shared IDL address.

See the root AGENTS.md for guidelines.
