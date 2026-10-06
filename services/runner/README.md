# @wysiwys/runner

EC2 service: listener for the Wysiwys guard, CRE trigger and SQLite history. Plan: `docs/plans/2026-10-06-runner-listener.md`.

- Listens to the guard program at `finalized`: WebSocket `logsSubscribe` plus a `getSignaturesForAddress` backfill on startup and every minute from a stored cursor.
- Stores `ReviewRequested`, `DecisionRecorded` and `Executed` in SQLite (`reviews`, `events`). History only; the chain is the truth.
- Sends one CRE trigger per new Pending review (`POST { multisig, txIndex }`, bearer token); failures are retried every tick.
- `GET /status`: 200 when subscribed and the last backfill is under 2 minutes old, else 503. `GET /reviews?limit=`: review history.

```bash
npm run dev --workspace=services/runner     # needs Node >= 22.13 (node:sqlite)
npm test --workspace=services/runner
```

Env (root `.env` locally, SSM on EC2):

| Var | Default |
|---|---|
| `HELIUS_DEVNET_RPC_URL` | `https://api.devnet.solana.com` |
| `PORT` | `8787` |
| `RUNNER_DB_PATH` | `services/runner/data/runner.db` |
| `CRE_TRIGGER_URL` | unset: triggers are logged, not sent |
| `CRE_TRIGGER_TOKEN` | unset |
| `BACKFILL_INTERVAL_MS` | `60000` |

The guard program id comes from `deployments/devnet.json`, else the shared IDL address.

See the root AGENTS.md for guidelines.
