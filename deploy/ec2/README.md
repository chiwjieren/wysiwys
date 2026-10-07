# Deploy on one EC2 instance

Everything on one box: the runner (guard listener, settlement routes, CRE review runner), the `cre` CLI it starts per review, SQLite, the Next.js app, and Caddy for HTTPS.

```
Internet ──443──> Caddy ──> app.<host>    -> Next.js  127.0.0.1:3000 ──> runner (local)
                        └─> runner.<host> -> runner   127.0.0.1:8787 ──> cre workflow simulate --broadcast (child process)
                                                                    └─> /var/lib/wysiwys/runner.db (SQLite)
```

## 1. Launch (AWS console, region ap-southeast-1, `AWS_PROFILE=origins`)

| Setting | Value |
|---|---|
| AMI | Ubuntu Server 24.04 LTS, x86_64 |
| Instance type | `t3.small` (2 GB). `t3.micro` works only with the 2 GB swap the setup adds, and builds are slow |
| Storage | 20 GB gp3 |
| Key pair | yours, for SSH |
| Security group | inbound 22 from your IP only; 80 and 443 from anywhere; outbound all |
| Elastic IP | allocate and associate (stable address for HTTPS) |
| Budget alerts | $20 and $50 (AGENTS.md) |

## 2. Install

```bash
ssh ubuntu@<elastic-ip>
git clone https://github.com/chiwjieren/wysiwys.git /tmp/wysiwys && bash /tmp/wysiwys/deploy/ec2/setup.sh
```

The script installs Node 22, Bun, the `cre` CLI, Caddy, adds 2 GB swap, creates the `wysiwys` service user, clones the repo to `/opt/wysiwys`, installs dependencies, builds the decoder and the app, and installs the two systemd units. It is re-runnable.

## 3. Secrets (three files, `chmod 600`, owner `wysiwys`)

Templates in this folder: `runner.env.example`, `cre.env.example`, `app.env.example`.

| File | Template |
|---|---|
| `/opt/wysiwys/.env` | `runner.env.example` (Helius URLs, tokens, CRE runner settings, `CRE_API_KEY`) |
| `/opt/wysiwys/workflow/confidential-preflight/.env` | `cre.env.example` (3 RPC URLs, Scorechain key, policy document, transmitter key, throwaway EVM key) |
| `/opt/wysiwys/app/.env.local` | `app.env.example` (`SOLANA_RPC_URL`, `WYSIWYS_SETTLEMENT_URL=http://127.0.0.1:8787`, `WYSIWYS_SETTLEMENT_TOKEN`) |

Copy from your machine without pasting secrets into a terminal history, e.g.:

```bash
scp .env ubuntu@<ip>:/tmp/runner.env
scp workflow/confidential-preflight/.env ubuntu@<ip>:/tmp/cre.env
# on the server
sudo install -o wysiwys -g wysiwys -m 600 /tmp/runner.env /opt/wysiwys/.env
sudo install -o wysiwys -g wysiwys -m 600 /tmp/cre.env /opt/wysiwys/workflow/confidential-preflight/.env
sudo -u wysiwys nano /opt/wysiwys/app/.env.local && sudo chmod 600 /opt/wysiwys/app/.env.local
rm /tmp/runner.env /tmp/cre.env
```

Then edit `/opt/wysiwys/.env` for the server values (`RUNNER_DB_PATH=/var/lib/wysiwys/runner.db`, `CRE_PROJECT_DIR=/opt/wysiwys/workflow/confidential-preflight`, `CRE_API_KEY`, new `SETTLEMENT_TOKEN` and `REVIEW_TOKEN`). `SETTLEMENT_TOKEN` must equal the app's `WYSIWYS_SETTLEMENT_TOKEN`.

The transmitter key in `CRE_SOLANA_PRIVATE_KEY` pays for every report transaction; keep about 0.3 SOL on it (`7GNmVS4qBBFvGk9b4LiMkoB4j4YcNPCLcR5EWcktUccZ`).

## 4. HTTPS and start

```bash
sudo cp /opt/wysiwys/deploy/ec2/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile        # app.<ip-with-dashes>.sslip.io and runner.<ip-with-dashes>.sslip.io, or your domain
sudo systemctl restart wysiwys-runner wysiwys-app caddy
```

## 5. Check

```bash
systemctl status wysiwys-runner wysiwys-app caddy --no-pager
curl -s localhost:8787/status | jq '{ok, listener: .listener.subscribed, reviews}'   # ok true, subscribed true
journalctl -u wysiwys-runner -f                                                     # [runner] ... trigger: cre simulate review ... --broadcast
sudo -u wysiwys bash -c 'cd /opt/wysiwys/workflow/confidential-preflight && HOME=/var/lib/wysiwys/home CRE_API_KEY=... cre whoami'
```

Open `https://app.<host>/status`: wallet login, chain state, "Runner online", listener subscribed.

## Review path: live DON (primary) or simulator (backup)

Each treasury's GuardConfig fixes its path forever: live treasuries accept only reports from the deployed workflow through the production Keystone forwarder, simulator treasuries only `cre workflow simulate --broadcast` reports through the mock forwarder. Run **one runner at a time**: it skips reviews of the other path's treasuries (`deployments/devnet.json` `forwarders`), so they cost one GuardConfig read and no CRE run. New treasuries created in the app use `deployments/devnet.json` `guard` (the live values).

| | Live (primary) | Simulator (backup) |
|---|---|---|
| `/opt/wysiwys/.env` | `CRE_WORKFLOW_ID=<deployed id>` and `CRE_GATEWAY_PRIVATE_KEY` set | comment both out (`CRE_PROJECT_DIR` stays) |
| Runner log | `review path: only treasuries using forwarder CXsKE...`, `trigger: CRE gateway` | `review path: only treasuries using forwarder 7kuEAA...`, `trigger: cre simulate` |
| Treasury to demo | one created in the app (live GuardConfig) | an existing simulator treasury |

Switch (about a minute):

```bash
sudo -u wysiwys nano /opt/wysiwys/.env      # set or comment out CRE_WORKFLOW_ID and CRE_GATEWAY_PRIVATE_KEY
sudo systemctl restart wysiwys-runner
journalctl -u wysiwys-runner -n 20 --no-pager | grep -E "review path|trigger:"
```

Re-trigger a live review whose DON run failed (only while it is still pending and inside the 15-minute review deadline; after that, propose the payment again):

```bash
curl -s -X POST localhost:8787/review -H "authorization: Bearer $REVIEW_TOKEN" -H 'content-type: application/json' \
  -d '{"multisig":"<multisig>","txIndex":"<n>"}' | jq '{ok, log}'    # ok true only once the decision is on chain
```

A redeploy of the live workflow changes its ID: update `CRE_WORKFLOW_ID` and restart. Re-running `scripts/bootstrap-devnet.ts` rewrites `guard` from the default (simulator) test treasury; restore the live values afterwards.

## SQLite

`/var/lib/wysiwys/runner.db` (plus `-wal`), created on first start. History only: if it is lost, the runner rebuilds it from chain on the next start. It survives reboots; it is gone only if the instance and its volume are terminated.

## Update

```bash
cd /opt/wysiwys && sudo -u wysiwys git pull --ff-only && sudo -u wysiwys HOME=/var/lib/wysiwys/home npm ci --ignore-scripts \
  && sudo -u wysiwys npm run build --workspace=packages/decoder && sudo -u wysiwys npm run build --workspace=app \
  && sudo systemctl restart wysiwys-runner wysiwys-app
```

## Notes

- Simulation only: reports go through the CRE simulator's mock forwarder (`cre workflow simulate --broadcast`), which does not verify DON signatures; the TEE is simulated.
- If the runner is down, new reviews are not processed and payments cannot execute (fail closed). systemd restarts it; the listener backfills missed reviews on start.
- Stop the instance after the event to stop billing; the Elastic IP is billed while unattached.
