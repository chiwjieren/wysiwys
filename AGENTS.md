# CLAUDE.md

Guidance for Claude Code working anywhere in this repository (program, decoder, CRE workflow, runner, web app, scripts).

## Project

**Wysiwys** ("What You See Is What You Sign", pronounced "wizzy-wiss"). An on-chain firewall for Solana treasuries: a Squads v4 multisig payment can only execute after a Chainlink CRE workflow independently decodes it and confirms it matches the treasury policy.

> Wysiwys: what you see is what you sign. Fooled signers cannot move funds.

Built for the TOKEN2049 Origins Hackathon (Singapore, 6 to 8 Oct 2026). Tracks: Main, Solana, Chainlink (Best Workflow with CRE), NOWNodes (Multichain Infrastructure). Submission needs a public repo, a live URL (Demo mode) and a deck with an embedded demo video.

## End-to-end flow

1. A signer proposes a payment in the web app → Squads `vaultTransactionCreate` + `proposalCreate`.
2. The app calls the guard's `request_review` → stores a `Review` (`msg_hash` = SHA-256 of the Squads `VaultTransaction` account data) and emits `ReviewRequested`.
3. The **listener** (NOWNodes WebSocket) catches the event, stores it, and POSTs to the **CRE workflow** HTTP trigger.
4. The workflow fetches the Review, VaultTransaction and token account owners via NOWNodes + a second RPC (consensus, finalized), checks the hash, decodes, applies the policy, builds a summary and reason code.
5. The verdict is written to the guard via `on_report` (demo: runner dev key; production: Chainlink DON + Keystone Forwarder).
6. The web app shows the verdict and plain-English summary next to the proposer's claim. Signers approve 3 of 3 in Squads.
7. Anyone calls `guarded_execute` → guard checks verdict, expiry, single use, hash, durable nonce → CPI into Squads execute, signed by the executor PDA.

Architecture diagram: `docs/architecture-v3.png`.

## Repo layout and owners

```
programs/wysiwys_guard/    Anchor guard program                         Jun Heng
packages/shared/           Seeds, events, payload, reason codes,         everyone (changes announced)
                           DecodedAction schema, IDL, runner API types
packages/decoder/          Pure TS decoder + policy + summary           Teammate B
workflow/                  CRE workflow (TypeScript)                    Teammate A
services/runner/           EC2: listener + CRE runner + SQLite          Teammate A
app/                       Next.js web app, Demo mode, server routes    Teammate C
scripts/                   bootstrap, e2e, demo scenario builders       Jun Heng + Teammate B
deployments/devnet.json    Addresses written by bootstrap               Jun Heng
docs/                      Plans, specs, spikes, diagrams, pitch        everyone
evidence/cre/              CRE simulation logs (track evidence)         Teammate A
```

## Commands

```bash
# Install / check everything
npm install
npm run typecheck
npm test                                   # all TS workspaces

# Guard program
anchor build
anchor test                                # local validator, Squads cloned from devnet
anchor deploy --provider.cluster devnet

# Devnet setup and end-to-end
npx tsx scripts/bootstrap-devnet.ts        # idempotent; writes deployments/devnet.json
npx tsx scripts/e2e-devnet.ts              # approve path + both reject paths

# Decoder + policy
npm test --workspace=packages/decoder

# CRE workflow
cd workflow && cre workflow simulate       # save output to evidence/cre/

# Runner (listener + CRE runner)
npm run dev --workspace=services/runner

# Web app
npm run dev --workspace=app
```

Keep this section accurate. Update it in the same commit that changes a command.

## Source of truth

- **`packages/shared`** owns every cross-component contract. Never redefine seeds, events, payload layout, reason codes, `DecodedAction` or runner API types elsewhere. Announce changes to the team before merging.
- **`deployments/devnet.json`** owns every address. Never hardcode program IDs, multisig, vault, mint or reporter keys.
- **On-chain state wins.** If the database, a cache or the UI disagrees with the chain, show and trust the chain.
- **Specs and plans in `docs/`:**
  - `docs/plans/2026-10-06-wysiwys-guard-solana-plan.md` (guard program)
  - `docs/specs/decoder-spec.md` (decoder)
  - Add plans for workflow, runner and app in `docs/plans/` before building them. Update a plan when a decision changes.

## Frozen interfaces (summary; full definitions in `packages/shared`)

- Seeds: `["config", multisig]`, `["review", multisig, tx_index u64 LE]`, `["executor", multisig]`
- Events: `ReviewRequested { multisig, tx_index, review, msg_hash }`, `DecisionRecorded { review, verdict, reason, policy_hash, expiry }`, `Executed { review, multisig, tx_index }`
- Report payload (Borsh): `{ review, msg_hash [32], verdict u8 (1 approve, 2 reject), reason u16, policy_hash [32], expiry i64 }`
- Reason codes: 0 ok, 1 recipient not allowlisted, 2 over limit, 3 authority/owner change, 4 durable nonce, 5 unsupported program/instruction, 6 new delegate, 7 data source mismatch, 8 hash mismatch
- `msg_hash` = SHA-256 of the full Squads `VaultTransaction` account data
- Reporter modes: 0 = Keystone Forwarder (production), 1 = runner dev key (demo)
- Runner API: `POST /review { multisig, txIndex }` (bearer token), `GET /status`
- Event DB table: `reviews(review, multisig, tx_index, status, reason, msg_hash, tx_signature, updated_at)`

## Component guidelines

### Guard program (`programs/wysiwys_guard`)
- Instructions: `initialize_guard`, `request_review`, `on_report`, `guarded_execute`. Nothing else without team agreement.
- Security rules (every rule has a test; never weaken a security test to make something pass):
  1. CPI target is exactly Squads `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`.
  2. The executor PDA signs only the Squads `vault_transaction_execute` CPI.
  3. `GuardConfig` is immutable after init. No admin can change the reporter.
  4. Check the instructions sysvar address before the durable-nonce check.
  5. Owner checks on every account; re-derive seeds; `has_one = multisig`.
  6. One-way status: Pending → Approved | Rejected → Executed. Set Executed before the CPI.
  7. Expiry uses `Clock::get()`. Payload decoding is exact-length and range-checked.
  8. `init` only, never `init_if_needed`.
- Support repeated runs (Demo mode): each proposal gets its own Review; no global state.

### Decoder and policy (`packages/decoder`)
- Pure TypeScript, **no Node.js APIs**, minimal dependencies (compiles to WASM for CRE; also imported by the app).
- Deterministic: no clocks, randomness or network.
- Verify `sha256(data) == msg_hash` before decoding.
- Decode every top-level instruction in order. Unknown program, unknown instruction or Address Lookup Tables → `unsupported`.
- The decoder describes; the policy decides. Policy layers: program allowlist → instruction allowlist → parameters (recipient owner wallet, amount per mint, mint). Anything not explicitly allowed is rejected.
- Summaries are templates driven by decoded actions and reason codes. **No AI in the decision path.**
- Every supported instruction and every demo scenario has a fixture-based test (real devnet account bytes in `packages/decoder/fixtures/`).

### CRE workflow (`workflow/`)
- CRE is the orchestration layer: trigger → fetch → hash check → decode → policy → summary → report.
- Triggers: HTTP (primary, called by the runner/listener). Solana log trigger only if verified working.
- All Solana reads go through HTTP to NOWNodes + a second RPC, `finalized` commitment, compare decoded fields (not raw responses).
- Always re-read `msg_hash` and the transaction from chain. Never trust data in the trigger payload beyond identifiers.
- Include `policy_hash` in every report. The policy file (`workflow/policy.json`) is versioned; its hash is stored in `GuardConfig`.
- Keep every simulation log for the Chainlink track (`evidence/cre/`).

### Listener and runner (`services/runner`)
- Listener: NOWNodes WebSocket `logsSubscribe` on the guard program, parse Anchor events with the IDL, backfill with `getSignaturesForAddress` on startup and every minute, dedupe by `review`.
- Runner: `POST /review` runs `cre workflow simulate` for that review; protected by a bearer token; rate limited; returns logs.
- Store events in SQLite for the activity feed. The DB is history, not truth.
- Listener down means reviews do not start, and payments cannot execute (fail closed). Expose health on `GET /status`.

### Web app (`app/`)
- Screens: Demo mode (3 scenario buttons), Propose, Review screen (verdict + summary + proposer claim vs reality), Approve x3, Execute, Activity feed, `/status`.
- Read current state (balances, votes, Review status) directly from chain via a server route proxy. Read history from the runner DB.
- Show the on-chain verdict first. The local decoder preview is labelled "preview" and never overrides it.
- Demo signer keys, the NOWNodes key and the runner token live only in server routes. Nothing secret in client bundles.
- Rate limit Demo mode and cap amounts so the demo vault cannot be drained.

### Scripts (`scripts/`)
- `bootstrap-devnet.ts` is idempotent and re-runnable; it creates the mint, signers, Squads multisig (3 of 3 + executor Execute-only), guard config, vault funding, vendor token accounts, and writes `deployments/devnet.json`.
- Scenario builders (approve, Drift-style, lookalike) are shared by e2e tests, Demo mode and the video recording.

## Working style

- **TDD always.** Failing test → run → implement → run → commit. Use superpowers skills (brainstorming, writing-plans, executing-plans) for non-trivial work.
- **Small commits**, conventional style: `feat:`, `fix:`, `test:`, `chore:`, `docs:`, scoped by component (`feat(decoder): ...`).
- **Ask before changing a frozen interface**, the security rules or the policy layers.
- **Integrate early.** Use mocks to unblock (dev-key `on_report`, stub decoder, fake Review data) but replace them before the 7 Oct 12:00 integration milestone.
- **Prefer cutting scope over adding it.** Stretch items only after the full flow works on devnet.
- Never use em dashes in user-facing text, docs, the README or the deck.

## Secrets

- Never commit keypairs, API keys, tokens or `.env` files. Devnet keypairs go in `keys/` (gitignored).
- Hosted secrets live in AWS SSM Parameter Store (runner) and Amplify environment variables (app).
- Treat every key as devnet-only. Label Demo mode "Devnet demo, test keys only".

## Deployment

- Solana: devnet only. Program ID fixed in hour 1; redeploys are upgrades. Upgrade authority stays with the deployer key during the event.
- Web app: AWS Amplify (Next.js), region `ap-southeast-1`.
- Listener + CRE runner + SQLite: one EC2 `t3.small` with Elastic IP, Caddy for HTTPS, systemd services.
- AWS CLI: `export AWS_PROFILE=origins`. Never use Learner Lab credentials. Budget alerts at $20 and $50.
- Milestones: first devnet deploy 6 Oct 22:00; integration 7 Oct 12:00; **feature freeze 7 Oct 18:00**; submit by 22:00. No redeploys after recording unless something is broken. Keep everything running through 8 Oct.

## Demo scenarios (must always work)

1. Normal vendor payment: `TransferChecked` 2,500 USDC to Acme → approved → 3 of 3 → executed.
2. Drift-style takeover: unknown recipient + `SetAuthority` + `AdvanceNonceAccount` → rejected, blocked on-chain.
3. Lookalike address: payment to an Acme lookalike → rejected.
Plus: `guarded_execute` sent as a durable-nonce transaction → `DurableNonceDetected`.

Record each scenario as soon as it works.

## Out of scope

- Mainnet, Token-2022, Address Lookup Table resolution, arbitrary program support, Cardano.
- Program trust scoring, transaction simulation, AI explanations, guarded config changes: roadmap or stretch only.