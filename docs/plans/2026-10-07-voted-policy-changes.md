# Voted Policy Changes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A treasury's policy (whitelist, caps, mints, screening) can be changed only by a Squads vote of its members followed by a waiting period, enforced by the guard; old approvals stop working the moment the policy changes.

**Architecture:** Members propose a Squads vault transaction whose single instruction is a guard "policy change" marker (new hash, expected current hash). The marker is never executed: once the Squads proposal is Approved and the waiting period has passed, anyone calls a new guard instruction `apply_policy_change`, which reads the Squads proposal and transaction, checks them, records a one-time `PolicyChange` account and updates `GuardConfig.policy_hash`. The CRE workflow keeps a registry of policy documents and uses the one whose hash the treasury's GuardConfig names. Members read the proposed policy in the app (wallet-authenticated, members only) before they vote.

**Tech Stack:** Anchor 1.2 (guard), TypeScript (packages/shared, CRE workflow, runner, Next.js app), Squads v4 (`@sqds/multisig` 2.1.4, IDL in `node_modules/@sqds/multisig/idl`).

**Spec:** this document (Design section) and `docs/production-gaps.md` item 21.

## Why this design

- **Squads votes, not a new voting system.** Members already vote in Squads; reusing its proposals keeps one membership, one threshold, Squads' cancel and stale rules and the existing approve UI.
- **The marker is never executed.** The guard cannot apply the change by executing the vault transaction: that would be guard -> Squads -> guard, and Solana refuses re-entrant CPI. So the guard reads the approved proposal instead and marks it consumed itself.
- **A waiting period is the safety net.** Without it, signers who reach the threshold (or whose keys are stolen) could whitelist an attacker and pay out in one sitting, which is exactly what the firewall is meant to stop. During the wait, members can still cancel (`proposalCancel` works on Approved proposals) and alerts can fire.
- **Old approvals die with the old policy.** `guarded_execute` gets a new check: the Review's `policy_hash` must equal the current `GuardConfig.policy_hash`.
- **No GuardConfig layout change.** `policy_hash` is updated in place; history lives in `PolicyChange` accounts. Existing treasuries keep working without a migration.

## Policy document format (v1)

A voted policy must mean exactly what it says, so every field is validated in one place (`parsePolicy` in `packages/shared`) and every field is enforced by the workflow. Today `allowedPrograms`, `allowedInstructions` and `screening` are hashed but not read (programs and instructions are hardcoded in the decoder path, screening is a workflow config flag); this plan makes them binding. The current `workflow/policy.json` is a valid v1 document and keeps its hash.

| Field | Type and rule | Enforced by |
|---|---|---|
| `version` | positive safe integer; a proposed change must increase it | workflow (hash), app and runner (increase) |
| `salt` | hex string, at least 32 hex characters (16 bytes) | hash only (prevents guessing whitelist entries) |
| `allowedPrograms` | non-empty array, unique, each one of `11111111111111111111111111111111` (System), `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` (Token) | workflow: payment program must be listed, else `UNKNOWN_PROGRAM` |
| `allowedInstructions` | non-empty array, unique, each one of `system:transfer`, `spl-token:transferChecked`; each one's program must be in `allowedPrograms` | workflow: decoded action must be listed, else `UNEXPECTED_INSTRUCTION` |
| `allowedMints` | array (may be empty only if `spl-token:transferChecked` is not allowed), unique by `mint`; each `{ mint: base58 32-byte key, decimals: integer 0..9 }` | workflow (`MINT_NOT_ALLOWED`) |
| `maxAmountPerPayment` | decimal string, positive, no leading zeros, at most u64 max; base units of the paid asset (lamports for SOL, token base units for SPL) | workflow (`AMOUNT_OVER_CAP`) |
| `destinationWhitelist` | array, unique, each a base58 32-byte wallet address (SPL: the token account owner) | workflow (`DESTINATION_NOT_WHITELISTED`) |
| `screening` | `{ "provider": "scorechain", "blockOn": ["SANCTIONED"] }`, or absent for no screening | workflow: screens only when present (and the workflow's `screening` config is on) |

Unknown keys are rejected. The parser returns the typed policy; callers hash the parsed document with `policyHash` so validation and hashing see the same object.

## Decisions for the team (needed before Task 1)

| # | Decision | Recommendation |
|---|---|---|
| D1 | Mechanism | Squads proposal + `apply_policy_change` (this plan). Alternative: guard-native voting, which duplicates Squads. |
| D2 | Waiting period | `max(multisig.time_lock, POLICY_CHANGE_MIN_DELAY)`. `POLICY_CHANGE_MIN_DELAY` = 300 s on devnet for the demo; 86 400 s (24 h) for production. It is a program constant, so changing it is a program upgrade. |
| D3 | Threshold | Same as payments (the Squads threshold). Stricter (all members) is possible later by checking the approved count against the member count. |
| D4 | CRE check of the change itself | Not in this plan. Later: the DON screens newly whitelisted addresses before a change can apply. |
| D5 | Where members read policy documents | Runner SQLite, served only through the app to wallet-authenticated members of that multisig (checked on chain). Production: an encrypted store fetched inside the TEE. |
| D6 | How the workflow gets a new document | Operator uploads the registry to the Vault DON (`cre secrets update`) before applying. The app shows a warning; production replaces this with the encrypted store (D5). |

Changing the rules below needs team agreement (AGENTS.md "Ask before changing a frozen contract, the security rules"): security rule 3 ("GuardConfig is immutable after init") becomes "immutable except `policy_hash`, changed only by `apply_policy_change`"; security rule 9 ("A policy or decoder change means a new guard config") is replaced; the instruction list gains `apply_policy_change`.

## Global Constraints

- Anchor 1.2, `init` only (never `init_if_needed`); owner checks, re-derived seeds and `has_one` on every account (security rules 5, 7, 8).
- CPI target is exactly Squads `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`; `apply_policy_change` makes **no** CPI and signs nothing with the executor PDA.
- `packages/shared` owns every new contract: seed `["policy_change", multisig, tx_index u64 LE]`, the marker instruction layout, the `PolicyChanged` event, the registry format.
- Policy hash stays `policyHash(policy, decoderVersion)` from `packages/shared` (domain `wysiwys:policy:v1`).
- Decoder stays pure TS with no Node APIs; the workflow never trusts trigger data beyond identifiers.
- Never print or commit policy documents, salts or whitelist entries; no em dashes in user-facing text.
- TDD for every task; `anchor test --validator legacy`.

## Review Focus

1. **An approved change applied after another change landed first:** expected refusal (`PolicyChangeOutdated`), because the marker carries the expected current hash. Test in Task 2.
2. **A change cancelled by members during the waiting period:** `apply_policy_change` must refuse (status no longer Approved). Test in Task 2.
3. **A proposal that went stale after a membership change** (index <= `stale_transaction_index`): refused like Squads does. Test in Task 2.
4. **A payment approved under the old policy and executed after the change:** `guarded_execute` refuses with `PolicyMismatch`. Test in Task 3.
5. **The marker transaction itself is never executable as a payment:** `guarded_execute` refuses any message that invokes the guard program. The CRE decoder rejects it as an unknown program too. Test in Task 3.
6. **The workflow does not have the new document yet:** reviews fail closed with POLICY_STALE and no report. Test in Task 5.

---

### Task 1: Shared contract (marker, seed, event, registry format)

**Files:**
- Create: `packages/shared/src/policy-change.ts`
- Modify: `packages/shared/src/index.ts` (export), `packages/shared/src/seeds.ts` (add `policyChange`)
- Test: `packages/shared/test/policy-change.test.ts`
- Fixture: `packages/shared/fixtures/policy-change-marker.json` (bytes shared with the Rust tests)

**Interfaces (produces):**
- `parsePolicy(input: unknown): PolicyV1` (throws `PolicyFormatError` naming the field) and `type PolicyV1`, per "Policy document format (v1)"; in `packages/shared/src/policy.ts`
- `POLICY_CHANGE_MARKER_DISCRIMINATOR: Uint8Array` = first 8 bytes of `sha256("global:policy_change_marker")`
- `encodePolicyChangeMarker({ newPolicyHash, expectedPolicyHash }): Uint8Array` (8 + 32 + 32 = 72 bytes)
- `decodePolicyChangeMarker(data: Uint8Array): { newPolicyHash, expectedPolicyHash } | null` (null unless exactly 72 bytes and the discriminator matches)
- `policyChangePda(guardProgram, multisig, txIndex): PublicKey`
- `type PolicyRegistry = Policy[]` (the Vault DON secret `POLICY_DOCUMENTS` is its JSON)

- [ ] Write tests: `parsePolicy` accepts the documented example and a document shaped like today's `workflow/policy.json` (synthetic values, same keys); rejects each rule violation in the format table (one test per field: wrong type, out of range, duplicates, unknown program or instruction, instruction whose program is not allowed, unknown key, cap with leading zero or above u64, bad base58, salt too short); parsing does not change the hash of a valid document.
- [ ] Write tests: marker round trip; wrong length, wrong discriminator and equal hashes (`new == expected`) decode to null; PDA matches `["policy_change", multisig, u64 LE]`; fixture bytes equal the encoder output.
- [ ] Run `npm test --workspace=packages/shared`: fails (module missing).
- [ ] Implement; run: passes.
- [ ] Commit `feat(shared): policy change marker, seed and registry format`.

### Task 1b: Workflow enforces every policy field

**Files:** Modify `workflow/confidential-preflight/review/review-logic.ts` (use `PolicyV1`, enforce allowlists), `workflow.ts` (parse with `parsePolicy`, screening from the policy); Test `review-logic.test.ts`, `workflow.test.ts`; Modify `scripts/policy-hash.ts` (validate with `parsePolicy` before hashing).

- [ ] Tests first: a valid payment is rejected with `UNKNOWN_PROGRAM` when its program is not in `allowedPrograms`, and with `UNEXPECTED_INSTRUCTION` when its instruction is not in `allowedInstructions`; screening runs only when the policy has `screening`; an invalid policy document fails closed (no report); today's policy shape still approves the clean fixture.
- [ ] Implement; `bun test` and `npx tsc --noEmit` in the workflow; `npx tsx scripts/policy-hash.ts` still prints the deployed hash for the current `workflow/policy.json`.
- [ ] Commit `feat(workflow): enforce every policy field (programs, instructions, screening)`.

### Task 2: Guard `apply_policy_change`

**Files:**
- Create: `programs/wysiwys_guard/src/instructions/apply_policy_change.rs`
- Modify: `state.rs` (`PolicyChange` account), `events.rs` (`PolicyChanged`), `errors.rs` (append only), `constants.rs` (`POLICY_CHANGE_SEED`, `POLICY_CHANGE_MIN_DELAY`, marker discriminator), `logic.rs` (parsers and checks), `lib.rs`, `instructions/mod.rs`
- Test: `tests/policy_change.ts` (local validator), unit tests in `logic.rs`

**Interfaces (produces):**
```rust
#[account] pub struct PolicyChange { multisig: Pubkey, tx_index: u64, old_policy_hash: [u8; 32],
    new_policy_hash: [u8; 32], approved_at: i64, applied_at: i64, bump: u8 }
#[event] pub struct PolicyChanged { multisig: Pubkey, tx_index: u64, old_policy_hash: [u8; 32], new_policy_hash: [u8; 32] }
// errors (appended): PolicyChangeNotApproved, PolicyChangeTooEarly, PolicyChangeStale,
//                    PolicyChangeOutdated, InvalidPolicyChange, GuardInMessage (used in Task 3)
```
Accounts: `config` (mut, seeds `["config", multisig]`, `has_one = multisig`), `multisig` (owner Squads), `proposal` (owner Squads), `vault_transaction` (owner Squads), `policy_change` (`init`, seeds `["policy_change", multisig, tx_index]`), `payer` (signer, mut), `system_program`. Anyone may call it; the vote is the authorization.

Handler checks, in order:
1. `parse_vault_transaction`: multisig matches; tx_index read from it; the PDA derivations of `proposal` (Squads `["multisig", ms, "transaction", idx, "proposal"]`) and `vault_transaction` re-derived and compared.
2. The vault transaction message has exactly **one** instruction, its program is the guard program, no other account keys beyond the multisig vault and the guard program, no address table lookups, and its data decodes as the marker (`logic::parse_policy_change_marker`). Anything else: `InvalidPolicyChange`.
3. `marker.expected_policy_hash == config.policy_hash`, else `PolicyChangeOutdated`; `new != expected`.
4. Proposal: discriminator, multisig, `transaction_index == tx_index`, status tag `Approved` (variant 3 of `ProposalStatus` in the pinned Squads IDL: Draft, Active, Rejected, Approved, Executing, Executed, Cancelled), `approved_at` = its timestamp; else `PolicyChangeNotApproved`.
5. Multisig: `tx_index > stale_transaction_index` (bytes 86..94), else `PolicyChangeStale`; `time_lock` (bytes 74..78).
6. `Clock::get()`: `now >= approved_at + max(time_lock, POLICY_CHANGE_MIN_DELAY)`, else `PolicyChangeTooEarly`.
7. Write `PolicyChange` (the one-time consumed marker; `init` fails on reuse), set `config.policy_hash = new`, emit `PolicyChanged`.

- [ ] Unit tests in `logic.rs`: marker parsing (exact length, discriminator), proposal status parsing for every variant (only Approved passes, timestamp read), multisig `time_lock` and `stale_transaction_index` offsets against fixture bytes.
- [ ] Validator tests (`tests/policy_change.ts`), each failing first:
  - applies after approval and the delay; `GuardConfig.policy_hash` changes; `PolicyChanged` emitted; `PolicyChange` stored
  - refuses before the delay (`PolicyChangeTooEarly`); uses `time_lock` when it is longer than the minimum
  - refuses Active, Rejected and Cancelled proposals, including one cancelled during the delay
  - refuses a stale proposal (membership changed through `guarded_config_execute` after approval)
  - refuses a second apply of the same index (account already in use)
  - refuses when `expected_policy_hash` is not the current hash (`PolicyChangeOutdated`)
  - refuses a vault transaction with two instructions, another program, extra accounts, wrong data length, or another multisig's proposal (`InvalidPolicyChange`, `WrongMultisig`)
  - refuses non-Squads-owned proposal or transaction accounts (`NotSquadsAccount`)
- [ ] Implement until green; `cargo test` and `anchor test --validator legacy` pass.
- [ ] Commit `feat(guard): apply_policy_change after a Squads vote and a waiting period`.

### Task 3: Guard `guarded_execute` hardening

**Files:** Modify `programs/wysiwys_guard/src/instructions/guarded_execute.rs`; Test `tests/guarded_execute.ts`, `tests/policy_change.ts`

- [ ] Tests first:
  - a payment approved under policy A, policy changed to B, then `guarded_execute`: refused with `PolicyMismatch`
  - a vault transaction whose message invokes the guard program (the marker): refused with the new `GuardInMessage` error (appended to `errors.rs`), even with an Approved review
- [ ] Add `require!(review.policy_hash == config.policy_hash, PolicyMismatch)` before Executed is written; add the guard-program-in-message check next to the existing `ExecutorInMessage` check.
- [ ] All existing guard tests still pass (no security test weakened).
- [ ] Commit `fix(guard): executions need the current policy; markers are never executable`.

### Task 4: Deploy the guard upgrade and sync the IDL

- [ ] `anchor build`, copy IDL to `packages/shared/idl/`, `npm test` everywhere.
- [ ] `anchor deploy --provider.cluster devnet` (program upgrade, same ID). Record in `docs/spikes.md`.
- [ ] Existing treasuries unaffected: run `scripts/e2e-devnet.ts clean` on the test treasury and one live-treasury payment.

### Task 5: Workflow policy registry

**Files:** Modify `workflow/confidential-preflight/review/workflow.ts`, `review-secrets.yaml`, `workflow/confidential-preflight/.env` handling docs; Test `workflow.test.ts`

**Interfaces:** secret `POLICY_DOCUMENTS` = JSON array of policy documents; `POLICY_DOCUMENT` (single) still accepted for backward compatibility.

- [ ] Tests first: picks the document whose `policyHash` equals the GuardConfig's; several documents with one match works; no match fails closed with `POLICY_STALE` and no report; duplicate hashes or malformed entries are rejected; the single-document secret still works.
- [ ] Implement `selectPolicy(registry, guardPolicyHash, decoderVersion)` in `review-logic.ts` (every entry parsed with `parsePolicy`); use it in `runReview`.
- [ ] `scripts/policy-hash.ts --registry` prints the hash of every document in `workflow/policies/*.json` (gitignored) and writes the one-line registry into the CRE `.env` without printing it.
- [ ] Simulate (local-simulation target) against a treasury on the old hash and one on the new hash: both evaluate.
- [ ] Commit `feat(workflow): policy registry keyed by the treasury's policy hash`.

### Task 6: Runner (policy store, apply route, events)

**Files:** `services/runner/src/store.ts` (table `policies(hash PRIMARY KEY, multisig, document, created_at)`), `src/settlement.ts` (`applyPolicyChange` instruction builder), `src/server.ts` (routes), `src/events.ts` (parse `PolicyChanged`); tests in `test/`.

Routes (bearer `SETTLEMENT_TOKEN`, called only by the app server):
- `POST /frontend/policies { multisig, document }`: validates with `parsePolicy`, requires `version` greater than the treasury's current policy version, computes the hash with `packages/shared`, stores it, returns `{ hash }`
- `GET /frontend/policies/:multisig/:hash`: the stored document
- `POST /frontend/policy-apply { multisig, txIndex }`: returns the `apply_policy_change` instruction

- [ ] Tests first for each route (validation, unknown hash 404, token required, instruction accounts and seeds), and `PolicyChanged` in the activity feed.
- [ ] Implement; commit `feat(runner): policy store and apply_policy_change route`.

### Task 7: App (view, propose, vote, apply)

**Files:** `app/src/lib/squads/policy.ts` (diff, marker build, validation), `app/src/app/api/policy/route.ts` (member-only proxy: wallet-signed request, membership checked on chain), `app/src/components/squads/policy-panel.tsx` (Settings), `proposal-review.tsx` (new record kind `policy`), `transaction list` labels, `progress.ts` (steps Proposed, Member approvals, Waiting period, Applied); tests in `app/tests/`.

- [ ] Tests first: diff of two policies (added and removed addresses, cap and mint changes, version); marker transaction built with exactly one guard instruction and the expected current hash; member-only access (non-member and unsigned requests refused); progress steps for a policy change, including "Waiting period ends at ..." and "Cancelled".
- [ ] Settings: "Policy" panel shows the current version and hash; members can view the document and open "Propose change" (edit whitelist, cap, mints; preview the diff; submit stores the draft through the runner, then the wallet signs `vaultTransactionCreate` + `proposalCreate` with the marker).
- [ ] Proposal page for a policy change: the diff in plain words ("Adds 2 addresses to the whitelist, raises the cap from 100,000 to 200,000 mUSD"), approve and cancel buttons, the waiting period on the tracker, then "Apply policy change" (runner-built instruction). Warns that the workflow must have the new document (D6).
- [ ] Commit `feat(app): view, propose and apply voted policy changes`.

### Task 8: Docs and evidence

- [ ] AGENTS.md: instruction list, security rules 3 and 9, `packages/shared` contracts, commands (`policy-hash.ts --registry`).
- [ ] `docs/specs/guard-cre-interface.md`: registry and `apply_policy_change`.
- [ ] `docs/production-gaps.md` item 21: closed for devnet; remaining gaps D4 and D5.
- [ ] Devnet evidence in `evidence/`: propose, vote, cancel-during-delay, apply, payment approved under the old policy refused, payment under the new policy approved.

## Estimate

Guard and tests about 6 h, workflow 2 h, runner 2 h, app 5 h, deploy and evidence 2 h: about two working days. It does not fit before the 7 Oct 18:00 feature freeze; present it as the next milestone. If something must ship before the freeze, Task 5 alone (the registry) is safe and useful: rotating the policy no longer strands existing treasuries.
