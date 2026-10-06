# AGENTS.md

## Project

**Wysiwys** (What You See Is What You Sign). A treasury payment firewall for Solana: a Squads v4 payout executes only when the human signers approved it in Squads **and** a matching, current, unexpired, unused APPROVED Guard review exists. The review comes from a Chainlink CRE workflow that re-reads the stored transaction from three independent RPC providers, decodes every instruction and evaluates a confidential policy (including a private destination whitelist) inside a TEE.

> Execute only when human approval AND a matching, current, unexpired, unused Guard review are present.

Votes and review may arrive in either order. A CRE verdict is neither a Squads vote nor permission for a human to execute directly. Human signers and DON node operators are separate roles.

Built for the TOKEN2049 Origins Hackathon (Singapore, 6 to 8 Oct 2026). Tracks: Main, Solana, Chainlink (Best Workflow with CRE). Submission needs a public repo, a live devnet URL and a deck with an embedded demo video.

Architecture reference: `docs/plans/architecture.md` and `docs/plans/architecture_diagram.png`. Sections marked **PROPOSED** there are project-owned contracts, not Chainlink or Squads APIs; freeze them in `packages/shared` before building against them.

## End-to-end flow

1. **Propose:** a treasury member picks recipient, token and integer amount in the Next.js app (optional off-chain memo/invoice). The app uses the Squads SDK to create the `VaultTransaction` and `Proposal`. Browser previews and memos never authorize payment.
2. **Request review:** the app calls Guard `request_review`. Guard validates multisig, vault, Squads-owned accounts and PDAs, computes the exact `tx_hash` of the stored message on-chain, creates the `Review` PDA for that transaction index (PENDING, `created_at` starts the report deadline) and emits `ReviewRequested`. Only the vault transaction's creator can request it.
3. **Fetch and agree:** the event adapter (runner) observes the **finalized** event and sends an authenticated HTTP trigger to CRE with identifiers only. In a CRE node-mode HTTP callback, each node reads the required accounts from QuickNode, Helius and Alchemy and needs a 2-of-3 exact content match to produce an observation. CRE consensus aggregates node outputs. No quorum means no ALLOW.
4. **Decode and evaluate:** decode every instruction of the agreed stored message with the pinned decoder. Pass typed actions, `tx_hash` and destination facts into the Confidential Workflow, which fetches/decrypts the private policy and checks the destination whitelist, program and instruction allowlists, mints, per-payment caps and screening. Output: ALLOW / DENY + reason + policy version.
5. **Write the review:** the DON-signed report goes through the Keystone Forwarder (CPI) to Guard `on_report`, which authenticates the forwarder, checks the binding to the current request and stores APPROVED or REJECTED with the validated destination facts and expiry.
6. **Human approval:** three treasury signers (Propose + Vote only, 3 of 3) approve in Squads. Votes can happen before, during or after the review.
7. **Guarded execution:** anyone calls `guarded_execute`. Guard checks APPROVED (not yet Executed), exact current `tx_hash`, unexpired, and re-checks the reviewed destination (same account; for SPL the token program, mint and owner, not frozen). It marks the review Executed, then CPIs into Squads execute signed by the executor PDA (the sole Execute member). Squads checks votes and timelock; the vault authorizes the transfer. Any failure rolls back consumption and payout together.

## Narrow MVP

- Solana devnet first. Live DON/forwarder path configured separately when access exists.
- One reviewed payment instruction: System SOL transfer or legacy SPL Token `TransferChecked` for an explicitly configured test mint.
- Destination token account must already exist and be valid. No account creation, on-chain Memo or extra instructions without a deliberate decoder/policy extension.
- Amounts are integer base units. Diagram values ("50,000 USDC") are examples, not configured limits.
- Per-payment caps only. Daily/cumulative caps need atomic on-chain accounting and are out of scope.

## Repo layout

```
programs/wysiwys_guard/        Anchor Guard program
tests/                         Anchor TS tests (local validator)
packages/shared/               Seeds, events, report layout, reason codes, tx_hash spec,
                               DecodedAction schema, IDL, runner API types, fixtures
packages/decoder/              Pure TS decoder + policy + summary
workflow/                      CRE workflow (TypeScript)
services/runner/               EC2: event adapter (listener + authenticated CRE trigger) + SQLite
app/                           Next.js app (standalone install, own lockfile, own docs/)
scripts/                       bootstrap, e2e, scenario builders
deployments/devnet.json        Addresses written by bootstrap
docs/                          Architecture, plans, specs
evidence/cre/                  CRE simulation logs (track evidence)
```

Packages use the `@wysiwys/` scope.

## Commands

```bash
# Install / check TS workspaces (packages, workflow, runner)
npm install
npm run typecheck
npm test

# Guard program
anchor build
anchor test --validator legacy             # solana-test-validator, Squads loaded from tests/fixtures
anchor deploy --provider.cluster devnet

# Devnet setup and end-to-end (e2e not written yet)
npx tsx scripts/bootstrap-devnet.ts        # idempotent; mUSD mint + metadata, Squads, recipients,
                                           # guard config once GUARD_* CRE values are set; writes deployments/devnet.json
npx tsx scripts/e2e-devnet.ts              # approve path + reject paths

# Decoder + policy
npm test --workspace=packages/decoder

# CRE workflow
cd workflow && cre workflow simulate       # save output to evidence/cre/

# Runner (event adapter)
npm run dev --workspace=services/runner

# Web app (installed with workspaces disabled to protect the root lockfile)
cd app && npm install --workspaces=false
npm run dev | npm test | npm run test:e2e | npm run typecheck | npm run build
```

Keep this section accurate. Update it in the same commit that changes a command.

## Source of truth

- **`packages/shared`** owns every cross-component contract: seeds, events, report layout, reason codes, the canonical `tx_hash` encoding, `DecodedAction`, IDL and runner API types, plus cross-language fixtures. Never redefine them elsewhere. Announce changes to the team before merging.
- **`deployments/devnet.json`** owns every address. Never hardcode program IDs, multisig, vault, mint, forwarder program/state or executor addresses.
- **On-chain state wins.** If the database, a cache or the UI disagrees with the chain, show and trust the chain.
- **Docs:** `docs/plans/architecture.md` is the design reference. Add plans for workflow, runner and Guard in `docs/plans/` before building them; the app keeps its plan in `app/docs/`. Update a plan when a decision changes.
- **Never invent** native trigger support, report-metadata offsets, enclave attestation, DON membership, program IDs, whitelist entries, policy values or deployment evidence. Verify against pinned dependencies and official docs.

## Contracts in `packages/shared` (frozen for the guard)

Plan: `docs/plans/2026-10-06-wysiwys-guard-migration.md`. Ask before changing any of these.

- **Seeds:** `["config", multisig]`, `["review", multisig, tx_index u64 LE]`, `["executor", multisig]`. One Review per Squads transaction index; Reviews are never closed, so the Review is the permanent consumed marker. No `RequestHead` or review generations: a rejected or expired review means a new Squads transaction.
- **`GuardConfig`** (immutable after `initialize_guard`): multisig, forwarder program and state, `policy_hash` (`policyHash` in `packages/shared`: commitment over the private policy document and the decoder version; compute with `npx tsx scripts/policy-hash.ts`), CRE `workflow_owner`, `max_review_lifetime`, `review_deadline_secs`, bumps. No pause or admin instructions.
- **`Review`:** multisig, vault transaction, proposal, tx_index, `tx_hash`, status, reason, `policy_hash`, `action_kind`, `destination_hash`, `issued_at`, `expires_at`, `created_at`.
- **`tx_hash`** = SHA-256(`"wysiwys:tx:v1"` || vault transaction address || VaultTransaction account data), computed by the guard. One TS implementation (`txHash`) for the workflow and app.
- **Report payload v2** (fixed layout, 117 bytes LE). CRE caps the Solana raw report at 265 bytes = 109 forwarder metadata + 32 account hash + 4 length + payload, so the payload must stay <= 120: `version u8 = 2 | verdict u8 (1 approve, 2 reject) | reason u16 | tx_hash [32] | policy_hash [32] | action_kind u8 (0 none, reject only, zero hash; 1 SOL; 2 SPL) | destination_hash [32] | issued_at i64 | expires_at i64`.
- **`destination_hash`** = SHA-256(`"wysiwys:dest:v1"` || kind || destination || owner || mint). SOL: destination = owner = recipient wallet, mint zero. SPL: destination = token account, owner = its owner wallet, mint = its mint. `guarded_execute` recomputes it from the live account.
- **Guard config values** (simulator): see `docs/specs/guard-cre-interface.md` section 7 (mock forwarder, simulator owner, policy hash) and its trust caveat.
- **Reason codes** (`ReviewReason`, u16, append only): 0 WITHIN_POLICY, 1 RPC_NO_QUORUM, 2 TX_HASH_MISMATCH, 3 UNKNOWN_PROGRAM, 4 UNEXPECTED_INSTRUCTION, 5 UNSUPPORTED_FEATURE, 6 AUTHORITY_CHANGE_BLOCKED, 7 DURABLE_NONCE_DETECTED, 8 DESTINATION_NOT_WHITELISTED, 9 DESTINATION_OWNER_UNRESOLVED, 10 MINT_NOT_ALLOWED, 11 AMOUNT_OVER_CAP, 12 SCREENING_REJECTED, 13 POLICY_STALE.
- **Instructions:** `initialize_guard(forwarder_program, forwarder_state, policy_hash, workflow_owner [20], max_review_lifetime i64, review_deadline_secs i64)`, `request_review()`, `on_report(metadata, report)`, `guarded_execute()` with the reviewed `destination` account.
- **Events:** `ReviewRequested { review, multisig, tx_index, tx_hash }`, `DecisionRecorded { review, verdict, reason, policy_hash, action_kind, destination_hash, expires_at }` (no private policy data), `Executed { review, multisig, tx_index }`.
- **Review states shown to users:** PENDING, APPROVED, REJECTED, EXPIRED, INDETERMINATE/ERROR, EXECUTED. Only APPROVED with every other gate passing can execute. EXPIRED is derived from chain state (`expires_at`, or `created_at + review_deadline_secs` while PENDING); no background job revokes approvals.
- **Runner API:** authenticated `POST /review { multisig, txIndex }`, `GET /status`. Event DB table: `reviews(review, multisig, tx_index, status, reason, tx_hash, tx_signature, updated_at)`.

## Component guidelines

### Guard program (`programs/wysiwys_guard`)
- Instructions: `initialize_guard`, `request_review`, `on_report`, `guarded_execute`. No admin, pause or config update. Nothing else without team agreement.
- Security rules (every rule has a test; never weaken a security test to make something pass):
  1. CPI target is exactly Squads `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`. No general-purpose CPI or PDA-signing entry point.
  2. The executor PDA signs only the Squads vault-transaction execute CPI, and is the sole Execute member.
  3. `GuardConfig` is immutable after init; `max_review_lifetime` and `review_deadline_secs` must be positive. `request_review` takes no arguments, computes `tx_hash` on-chain and only the vault transaction's creator may call it.
  4. `on_report`: forwarder state owner == pinned forwarder program and authority == PDA `["forwarder", forwarder_state, guard_program_id]`, signed; metadata names the configured `workflow_owner` (a payload field is not proof of origin; live approval stays disabled until provenance on the deployed Solana path is verified); review Pending; payload v2 exact length and ranges; `issued_at <= now + 60`; `expires_at > now` and `<= issued_at + max_review_lifetime`; arrives by `created_at + review_deadline_secs`; `tx_hash` and `policy_hash` match. A second report on a decided review fails.
  5. `guarded_execute`: check the instructions sysvar address, then reject if instruction 0 is `AdvanceNonceAccount`; re-derive the Review and bind it to multisig, vault transaction and proposal; APPROVED and unexpired; recompute `tx_hash`; recompute `destination_hash` from the passed destination account and its live data (`DestinationChanged`); refuse a message that references the executor PDA.
  6. One-way status Pending → Approved | Rejected; Approved → Executed, written **before** the Squads CPI in the same transaction. Reviews are never closed, so an executed transaction index can never be re-authorized.
  7. Owner checks on every account; re-derive seeds; `has_one` constraints. Expiry uses `Clock::get()`. Payload decoding is exact-length and range-checked.
  8. `init` only, never `init_if_needed`.
  9. A policy or decoder change means a new guard config (new multisig); old approvals carry the old `policy_hash` and only bind to the old config. Upgrade authority is protected.
- Bypass closure: no other Squads Execute members, no spending limits, clean token authorities/delegates on the vault. Bootstrap verifies this.

### Decoder and policy (`packages/decoder`)
- Pure TypeScript, **no Node.js APIs**, minimal dependencies (runs in CRE WASM; also imported by the app).
- Deterministic: no clocks, randomness or network.
- Verify the content hash/`tx_hash` before decoding. Decode every top-level instruction and account in order. Unknown program, unknown instruction, Address Lookup Tables, ephemeral signers, account creation, Token-2022 extensions → unsupported → DENY.
- The decoder describes; the policy decides. Policy layers: program allowlist → instruction allowlist → parameters (destination whitelist, mint, decimals, per-payment cap, source authority) → screening. Anything not explicitly allowed is denied. Missing inputs, unresolved ownership or stale policy never produce ALLOW.
- Whitelist semantics: SOL compares the destination pubkey. SPL validates the destination account's owning token program, decodes its mint and **token-account owner authority** and checks that wallet against the whitelist (program owner and wallet owner are different fields). Never infer a recipient from a memo.
- Summaries are templates driven by decoded actions and reason codes. **No AI in the decision path.**
- Every supported instruction and every demo scenario has a fixture-based test (real devnet account bytes in `packages/decoder/fixtures/`).

### CRE workflow (`workflow/`)
- Orchestration: HTTP trigger → node-mode three-provider read → consensus → decode → confidential policy → report.
- Trigger: authenticated HTTP from the runner. Use a native Solana trigger only after verifying it works.
- Reads: `getMultipleAccounts` at `finalized` for the Guard/Squads accounts and relevant token/mint accounts. Validate transport/JSON-RPC errors, missing accounts, owners, schema, addresses, lengths and a shared minimum context slot before counting a response. Compare a deterministic encoding of account contents, never JSON order, request IDs, timestamps or response slots. 2-of-3 exact match per node; missing/error responses never count as agreement. Return agreed contents with the observation hash so decoding uses the same data.
- The three-provider callback is our design, not a CRE feature. Do not build an ad hoc operator vote and call it DON BFT; use CRE consensus.
- Confidential Workflow: fetch/decrypt private policy and evaluate inside the enclave; return only a minimal bound verdict. Keep the whitelist out of source constants, public logs, reports and UI. If confidential access is unavailable, say so plainly; never claim attestation that did not happen.
- Never trust trigger payload data beyond identifiers. RPC errors, no quorum, unavailable DON/TEE, missing policy or report rejection never fall back to ALLOW (leave PENDING with an operational error, or DENY).
- Simulation vs live: local simulation is single-node consensus and a mock forwarder (`--broadcast` writes real devnet state). Keep mock and live forwarder config separate. Simulation evidence is not evidence of live DON signatures or TEE attestation. Keep every simulation log in `evidence/cre/`.

### Event adapter and runner (`services/runner`)
- Listener: `logsSubscribe` on the Guard program via a configured provider, act only on **finalized** events, parse Anchor events with the IDL, backfill with `getSignaturesForAddress` on startup and every minute from a stored cursor, dedupe events by `(signature, index)` and reviews by `review`. Built: `services/runner/src/listener.ts`.
- Sends authenticated, idempotent HTTP triggers to CRE (or runs `cre workflow simulate` in the demo setup). `POST /review` is bearer-token protected and rate limited.
- SQLite stores events for the activity feed. The DB is history, not truth.
- Adapter down means reviews do not start and payments cannot execute (fail closed). Expose health on `GET /status` (503 when not subscribed or the last backfill is over 2 minutes old) and history on `GET /reviews`. `POST /review` (bearer `REVIEW_TOKEN`) runs `cre workflow simulate --broadcast` for one review; the listener does the same in-process for each new review when `CRE_PROJECT_DIR` is set. Settlement routes for the app: `/frontend/propose`, `/frontend/execute`, `/frontend/groups/:multisig` (bearer `SETTLEMENT_TOKEN`).

### Web app (`app/`)
- Next.js App Router, Tailwind CSS, shadcn/ui, built from the approved Figma; see `app/README.md` and `app/docs/implementation-plan.md`.
- Screens: dashboard, transactions, transaction review (verdict + summary + proposer claim vs decoded reality), members, settings, `/status`. Propose, request review, vote and guarded-execute actions.
- `src/lib/mock` holds UI-only view models (still OTC-flavoured from the first pass). They are not protocol contracts; map authoritative records from `packages/shared` into them when wiring the backend.
- Read current state (balances, votes, Review status) from chain via a server route proxy; read history from the runner DB. Show the on-chain verdict first; a local decoder preview is labelled "preview" and never overrides it. A frontend button is never a permission boundary.
- Signer keys, RPC keys and the runner token live only in server routes. Nothing secret in client bundles. Rate limit and cap amounts so the devnet vault cannot be drained.

### Scripts (`scripts/`)
- `bootstrap-devnet.ts` (logic in `scripts/lib/bootstrap.ts`, tested in `tests/bootstrap.ts`) is idempotent: mUSD legacy SPL mint (6 decimals) with Metaplex metadata, 3 signers topped up with SOL, Squads multisig (3 of 3 Initiate+Vote, executor PDA as sole Execute member, autonomous, verified every run), vault funded with mUSD, whitelisted and lookalike recipient token accounts, Guard config only once all `GUARD_*` CRE values are set (never changed after), and writes `deployments/devnet.json`. Keys in `keys/`.
- Scenario builders are shared by e2e tests, the app and the video recording.

## Acceptance checks

- A whitelisted payment executes exactly once, only after both approvals, in either arrival order.
- One conflicting provider can be outvoted; missing/error responses do not count. No source or DON quorum → no APPROVED.
- Non-whitelisted wallets fail, including a lookalike address or a whitelisted-looking token account owned by another wallet. Wrong mint/program and changed destination ownership fail.
- Unknown instructions, wrong derivations, modified message/amount/privileges and stale policy/decoder fail.
- Forged or direct report calls, wrong forwarder, wrong network/request, expired, late (after the review deadline), replayed and executed reviews fail.
- Direct human execution and spending-limit bypasses fail. Missing votes/timelock or a failed transfer leave no consumption.
- Keep separate evidence for provider-quorum tests, mock devnet delivery, live DON consensus and TEE attestation.

## Demo scenarios (must always work)

1. Clean payment: test-USDC `TransferChecked` to a whitelisted wallet → APPROVED → 3 of 3 → executed.
2. Lookalike destination: address resembling a whitelisted wallet → DENY (destination not whitelisted).
3. Drift-style takeover: extra `SetAuthority` + `AdvanceNonceAccount` hidden in the payout → DENY (authority change blocked).
4. Ownership swap: destination token account owner changes after APPROVED → `guarded_execute` fails.
5. `guarded_execute` sent as a durable-nonce transaction → `DurableNonceDetected`.

Record each scenario as soon as it works.

## Working style

- **TDD always.** Failing test → run → implement → run. Use superpowers skills (brainstorming, writing-plans, executing-plans) for non-trivial work.
- **Never commit or push automatically.** Run `git commit` or `git push` only when the user explicitly asks. Stop after tests pass and report.
- **Small commits** (when asked), conventional style: `feat:`, `fix:`, `test:`, `chore:`, `docs:`, scoped by component (`feat(decoder): ...`).
- **Ask before changing a frozen contract**, the security rules or the policy layers.
- **Integrate early.** Mocks unblock work (stub decoder, fake Review data, mock policy result) but replace them before the 7 Oct 12:00 integration milestone.
- **Prefer cutting scope over adding it.** Prove the narrow payment path first; stretch items only after the full flow works on devnet.
- Never use em dashes in user-facing text, docs, the README or the deck.

## Secrets

- Never commit keypairs, API keys, tokens, `.env` files or whitelist entries. Devnet keypairs go in `keys/` (gitignored).
- RPC credentials (QuickNode, Helius, Alchemy) are operational access; the whitelist is a confidential business rule; forwarder/workflow authentication is a security boundary. Store them accordingly and do not treat them as interchangeable.
- Hosted secrets: AWS SSM Parameter Store (runner), Amplify environment variables (app), CRE secrets / confidential inputs (workflow).
- Treat every key as devnet-only. Label the live site "Devnet, test keys only".

## Deployment

- Solana: devnet only. Program ID fixed in hour 1; redeploys are upgrades. Upgrade authority stays with the deployer key during the event.
- Web app: AWS Amplify (Next.js), region `ap-southeast-1`.
- Event adapter + CRE runner + SQLite: one EC2 `t3.small` with Elastic IP, Caddy for HTTPS, systemd services.
- AWS CLI: `export AWS_PROFILE=origins`. Never use Learner Lab credentials. Budget alerts at $20 and $50.
- Milestones: first devnet deploy 6 Oct 22:00; integration 7 Oct 12:00; **feature freeze 7 Oct 18:00**; submit by 22:00. No redeploys after recording unless something is broken. Keep everything running through 8 Oct.

## Out of scope

- Mainnet, Token-2022, Address Lookup Table resolution, account creation, on-chain Memo, arbitrary program support, daily/cumulative caps, native Solana triggers (until verified).
- Program trust scoring, transaction simulation, AI explanations: roadmap or stretch only.
