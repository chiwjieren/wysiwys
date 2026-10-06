# AGENTS.md

## Project

**OmniCounter**. An OTC pre-settlement firewall for Solana: an OTC desk's Squads v4 payout can only execute after a Chainlink CRE workflow confirms the client's leg arrived on-chain, independently decodes the payout, matches it exactly to the approved trade ticket and passes the desk's confidential policy.

> OmniCounter: no proof, no payout.

Built for the TOKEN2049 Origins Hackathon (Singapore, 6 to 8 Oct 2026). Tracks: Main, Solana, Chainlink (Best Workflow with CRE), NOWNodes (Multichain Infrastructure). Submission needs a public repo, a live URL (Demo mode) and a deck with an embedded demo video.

## End-to-end flow

1. The settlement operator selects an approved trade from the (mock) trade system. The app derives the `SettlementIntent` and computes `settlement_intent_hash` and `trade_ref_hash`.
2. The app builds the payout (USDC `TransferChecked` to the counterparty's verified wallet) → Squads `vaultTransactionCreate` + `proposalCreate`.
3. The app calls the guard's `request_review(settlement_intent_hash, trade_ref_hash)` → stores a `Review` (`msg_hash` = SHA-256 of the Squads `VaultTransaction` account data, computed on-chain) and emits `ReviewRequested`.
4. The **listener** (NOWNodes WebSocket) catches the event, stores it, and POSTs identifiers to the **CRE workflow** HTTP trigger.
5. The workflow reads the Review, VaultTransaction and destination owner (`SolanaClient` + NOWNodes cross-check, finalized), checks `msg_hash`, decodes, fetches the trade ticket, **verifies the client's leg on Tron/Ethereum via NOWNodes**, recomputes both hashes, applies the confidential policy, builds a summary and reason code.
6. The report goes through the Keystone Forwarder to `on_report` (demo: `cre workflow simulate --broadcast` uses Chainlink's simulator mock forwarder on devnet).
7. The web app shows the verdict and plain-English summary next to the operator's claim. Signers approve 3 of 3 in Squads.
8. Anyone calls `guarded_execute` → guard checks verdict, expiry, hash, durable nonce, Squads program ID → sets Executed → CPI into Squads execute, signed by the executor PDA → emits `Executed` → listener marks the trade SETTLED.

Architecture reference: `docs/plans/omnicounter_otc_architecture.html`.

## Repo layout

```
programs/omnicounter_guard/    Anchor guard program
tests/                         Anchor TS tests (local validator)
packages/shared/               Seeds, events, payload, reason codes, intent hashing,
                               DecodedAction schema, IDL, runner API types
packages/decoder/              Pure TS decoder + policy + summary
workflow/                      CRE workflow (TypeScript)
services/runner/               EC2: listener + CRE runner + SQLite
app/                           Next.js web app, Demo mode, server routes,
                               mock trade system API (trades, registry, limits)
scripts/                       bootstrap, e2e, demo scenario builders
deployments/devnet.json        Addresses written by bootstrap
docs/                          Plans, specs, spikes, diagrams, pitch
evidence/cre/                  CRE simulation logs (track evidence)
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

# Isolated Wysiwys preflights (run from workflow/confidential-preflight)
cre workflow simulate confidential-check --target local-simulation --non-interactive --trigger-index 0
cre workflow simulate confidential-check/rpc-preflight --target local-simulation --non-interactive --trigger-index 0
# Tests/typecheck: run bun test and bun run typecheck from confidential-check

# Runner (listener + CRE runner)
npm run dev --workspace=services/runner

# Web app
npm run dev --workspace=app
```

Keep this section accurate. Update it in the same commit that changes a command.

## Source of truth

- **`packages/shared`** owns every cross-component contract. Never redefine seeds, events, payload layout, reason codes, `DecodedAction` or runner API types elsewhere. Announce changes to the team before merging.
- **`deployments/devnet.json`** owns every address. Never hardcode program IDs, multisig, vault, mint or forwarder addresses.
- **On-chain state wins.** If the database, a cache or the UI disagrees with the chain, show and trust the chain.
- **Specs and plans in `docs/`:**
  - `docs/plans/2026-10-06-omnicounter-guard-solana-plan.md` (guard program)
  - `docs/specs/decoder-spec.md` (decoder)
  - Add plans for workflow, runner and app in `docs/plans/` before building them. Update a plan when a decision changes.

## Frozen interfaces (summary; full definitions in `packages/shared`)

- Seeds: `["config", multisig]`, `["review", multisig, tx_index u64 LE]`, `["executor", multisig]`
- Events: `ReviewRequested { review, multisig, tx_index, msg_hash, settlement_intent_hash, trade_ref_hash }`, `DecisionRecorded { review, verdict, reason, policy_hash, expires_at }`, `Executed { review, multisig, tx_index }`
- `request_review(settlement_intent_hash [32], trade_ref_hash [32])`; accounts `multisig, vault_transaction, proposal, review (init), payer`
- `on_report(metadata: Vec<u8>, report: Vec<u8>)`; accounts `forwarder_state, forwarder_authority (signer), config, review`
- Report payload (Borsh, fixed 171 bytes): `{ review Pubkey, verdict u8 (1 approve, 2 reject), reason u16, msg_hash [32], settlement_intent_hash [32], trade_ref_hash [32], policy_hash [32], expires_at i64 }`. `expires_at` = min(policy expiry, trade `valid_until`).
- Reason codes (u16, `ReviewReason`): 0 WITHIN_POLICY, 1 RPC_NO_CONSENSUS, 2 TX_HASH_MISMATCH, 3 TRADE_NOT_FOUND, 4 TRADE_NOT_READY, 5 TRADE_EXPIRED, 6 TRADE_CANCELLED, 7 TRADE_ALREADY_SETTLED, 8 INTENT_HASH_MISMATCH, 9 COUNTERPARTY_LEG_NOT_RECEIVED, 10 ASSET_MISMATCH, 11 AMOUNT_MISMATCH, 12 DESTINATION_MISMATCH, 13 UNEXPECTED_INSTRUCTION, 14 UNKNOWN_PROGRAM, 15 AUTHORITY_CHANGE_BLOCKED, 16 DURABLE_NONCE_DETECTED, 17 COUNTERPARTY_SUSPENDED, 18 WALLET_NOT_VERIFIED, 19 SANCTIONED_WALLET, 20 WALLET_RISK_REJECTED, 21 LIMIT_EXCEEDED, 22 POLICY_HASH_MISMATCH
- `msg_hash` = SHA-256 of the full Squads `VaultTransaction` account data, computed by the guard in `request_review`; the workflow only checks it
- `settlement_intent_hash` = SHA-256 of the canonical `SettlementIntent` (fixed key order, no whitespace, amounts as strings); `trade_ref_hash` = SHA-256(`trade_id + ":" + version`). One implementation in `packages/shared`, used by the app and the workflow.
- Reporter: Keystone Forwarder only. Guard checks forwarder state owner == `forwarder_program` and `forwarder_authority` == PDA `["forwarder", state, guard_id]`. Demo uses the simulator mock forwarder (program `7kuEAA3mSC1Tz8gQjnvH7bKFda9xSPRRin9SZbH49cNK`, state `5Tipz3yhTBdVsDbaBxZkrp7Gjf3brGq5SKkxReefPMP7`).
- Mock trade API: `GET /trades/:id` (TradeRecord with `client_leg` and `desk_leg`), `GET /counterparties/:id`, `POST /trades/:id/settled`
- Runner API: `POST /review { multisig, txIndex }` (bearer token), `GET /status`
- Event DB table: `reviews(review, multisig, tx_index, status, reason, msg_hash, tx_signature, updated_at)`

## Component guidelines

### Guard program (`programs/omnicounter_guard`)
- Instructions: `initialize_guard`, `request_review`, `on_report`, `guarded_execute`. Nothing else without team agreement.
- Security rules (every rule has a test; never weaken a security test to make something pass):
  1. CPI target is exactly Squads `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`.
  2. The executor PDA signs only the Squads `vault_transaction_execute` CPI.
  3. `GuardConfig` is immutable after init. No admin can change the forwarder or `policy_hash`.
  4. Check the instructions sysvar address before the durable-nonce check (instruction 0 must not be `AdvanceNonceAccount`).
  4a. `on_report`: forwarder state owner and authority PDA checked; review Pending; `msg_hash`, `settlement_intent_hash`, `trade_ref_hash` equal the Review; `policy_hash` equals config (`PolicyMismatch`).
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
- CRE is the orchestration layer: trigger → fetch → hash check → decode → trade fetch → client leg check → policy → summary → report.
- Triggers: HTTP (primary, called by the runner/listener). Solana log trigger only if verified working.
- Solana reads: native `SolanaClient` (DON consensus) cross-checked with NOWNodes HTTP, `finalized` commitment, compare decoded fields (not raw responses). Disagreement → `RPC_NO_CONSENSUS`. Helius/Triton only if time allows.
- Client leg ("proof before payout"): via NOWNodes Tron/Ethereum RPC, confirm the USDT transfer to the desk deposit address, amount >= expected, enough confirmations, deposit tx not reused. Missing → `COUNTERPARTY_LEG_NOT_RECEIVED`.
- Recompute `settlement_intent_hash` and `trade_ref_hash` from the fetched trade with `packages/shared`; mismatch → `INTENT_HASH_MISMATCH`.
- Trade ticket fetch and sensitive rules run in the Confidential Workflow if available; otherwise the normal workflow.
- Always re-read `msg_hash` and the transaction from chain. Never trust data in the trigger payload beyond identifiers.
- Include `policy_hash` in every report. The policy file (`workflow/policy.json`) is versioned; its hash is stored in `GuardConfig`.
- Keep every simulation log for the Chainlink track (`evidence/cre/`).

### Listener and runner (`services/runner`)
- Listener: NOWNodes WebSocket `logsSubscribe` on the guard program, parse Anchor events with the IDL, backfill with `getSignaturesForAddress` on startup and every minute, dedupe by `review`.
- Runner: `POST /review` runs `cre workflow simulate` for that review; protected by a bearer token; rate limited; returns logs.
- Store events in SQLite for the activity feed. The DB is history, not truth.
- On `Executed`, call the mock trade API `POST /trades/:id/settled`.
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

- **TDD always.** Failing test → run → implement → run. Use superpowers skills (brainstorming, writing-plans, executing-plans) for non-trivial work.
- **Never commit or push automatically.** Run `git commit` or `git push` only when the user explicitly asks. Stop after tests pass and report.
- **Small commits** (when asked), conventional style: `feat:`, `fix:`, `test:`, `chore:`, `docs:`, scoped by component (`feat(decoder): ...`).
- **Ask before changing a frozen interface**, the security rules or the policy layers.
- **Integrate early.** Use mocks to unblock (mock trade API, stub decoder, fake Review data, mock client-leg result) but replace them before the 7 Oct 12:00 integration milestone.
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

1. Clean settlement: client's 500,250 USDT received on Tron → payout of 500,000 USDC to ABC Capital's verified wallet → approved → 3 of 3 → executed → trade SETTLED.
2. No proof, no payout: same trade before the client leg arrives → `COUNTERPARTY_LEG_NOT_RECEIVED`.
3. Lookalike destination: payout to an address resembling the verified wallet → `DESTINATION_MISMATCH`.
4. Drift-style takeover: extra `SetAuthority` + `AdvanceNonceAccount` hidden in the payout → `AUTHORITY_CHANGE_BLOCKED`, blocked on-chain.
Plus: `guarded_execute` sent as a durable-nonce transaction → `DurableNonceDetected`.

Record each scenario as soon as it works.

## Out of scope

- Mainnet, real OMS/RFQ integration (mock trade API only), Token-2022, Address Lookup Table resolution, arbitrary program support, Cardano.
- Program trust scoring, transaction simulation, AI explanations, guarded config changes: roadmap or stretch only.
