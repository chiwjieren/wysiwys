# Wysiwys Guard Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the guard program from the OTC settlement contracts (trade hashes, intent check) to the Wysiwys treasury design: a domain-separated `tx_hash`, destination facts bound at review and re-checked at execution, and time bounds on reports.

**Architecture:** Keep the existing security core (sole executor, single `invoke_signed`, forwarder + workflow owner check, durable nonce check, Executed before CPI). Replace the OTC fields in `Review`, the report payload and events. `on_report` stores the destination facts from the CRE report; `guarded_execute` takes the destination account and refuses if its token program, mint or owner changed since review.

**Tech Stack:** Anchor 1.2 (Rust), Squads v4, TypeScript (`packages/shared`, mocha tests on surfpool), `@noble/hashes`.

**Spec:** `docs/plans/architecture.md` (PROPOSED sections), `AGENTS.md` (Contracts to freeze, Guard program rules).

## Decisions taken in this plan

- **No `RequestHead` / review generations.** One Review per Squads transaction index, as today. A rejected or expired review means proposing a new Squads transaction. Reviews are never closed, so the Review itself is the permanent consumed marker. Revisit only after the full flow works on devnet.
- **`GuardConfig` stays immutable** (security rule 3). No pause or admin instructions. A policy or decoder change means a new guard config (new multisig).
- **`policy_hash` commits to the policy file and the decoder version together**, so the payload carries one commitment, not two.
- **Payload budget.** CRE's Solana raw report limit is 265 bytes including the 64-byte Keystone metadata, so the payload must be at most 201 bytes. The new payload is 181 bytes. The review address is bound through the accounts (`on_report` derives it) and through `tx_hash` (which includes the vault transaction address).
- **Single supported payment per review:** System SOL transfer or legacy SPL `TransferChecked`. Token-2022 is out of scope; the guard requires the destination token account to be owned by the legacy Token program.

## Global Constraints

- CPI target is exactly Squads `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`; exactly one `invoke_signed` in the guard.
- Instructions stay exactly `initialize_guard`, `request_review`, `on_report`, `guarded_execute`.
- `init` only, never `init_if_needed`.
- Payload decoding is exact-length and range-checked.
- Expiry and time checks use `Clock::get()`.
- Error code order in `errors.rs` is the contract with `packages/shared/src/guard.ts`; change both together.
- Never weaken a security test to make something pass.
- No em dashes in docs or user-facing text.

## Review Focus

1. Destination token account re-assigned to a new owner after APPROVED: `guarded_execute` must fail with `DestinationChanged` and the Review must stay Approved (Task 4).
2. Report signed long ago and delivered late: `on_report` must refuse after `created_at + review_deadline_secs` (`ReviewDeadlinePassed`) (Task 3).
3. Report claiming a very long approval window: `expires_at - issued_at > max_review_lifetime` must be `InvalidPayload` (Task 3).
4. Report from the future: `issued_at > now + 60` must be `InvalidPayload` (Task 2 unit test).
5. Approve verdict with no destination (`action_kind = 0`) must be `InvalidPayload`; a reject verdict may omit it (Task 2 unit test).

---

## File Structure

| File | Change |
|---|---|
| `programs/wysiwys_guard/src/constants.rs` | `TX_HASH_DOMAIN`, payload v1 offsets/len 181, `ACTION_*`, `MAX_REASON = 13`, `MAX_CLOCK_SKEW = 60`, `SPL_TOKEN_PROGRAM_ID`, `REVIEW_VERSION = 2` |
| `programs/wysiwys_guard/src/state.rs` | `GuardConfig` + `max_review_lifetime`, `review_deadline_secs`; `Review` drops trade hashes, `msg_hash` → `tx_hash`, adds destination facts and `issued_at` |
| `programs/wysiwys_guard/src/logic.rs` | `tx_hash()`, new `decode_report()`, `check_report_times()`, `check_destination()`; drop `intent_hash()` |
| `programs/wysiwys_guard/src/errors.rs` | Drop `IntentMismatch`; append `DestinationChanged`, `ReviewDeadlinePassed`, `InvalidConfig` |
| `programs/wysiwys_guard/src/events.rs` | New `ReviewRequested`, `DecisionRecorded` fields |
| `programs/wysiwys_guard/src/instructions/*.rs` | Wire the above |
| `packages/shared/src/{report,guard,reasons}.ts` | Mirror payload, `txHash()`, errors, reason codes |
| `tests/helpers/{guard,forwarder}.ts`, `tests/*.ts` | New args, payload, destination account |
| `Anchor.toml` | Load `test_forwarder` via `[[test.genesis]]` (surfpool does not deploy it on a fresh checkout) |
| `README.md`, `AGENTS.md`, `packages/shared/idl/wysiwys_guard.json` | Document and sync |

## Report payload v1 (181 bytes, little-endian)

| Offset | Field | Type | Rule |
|---|---|---|---|
| 0 | version | u8 | must be 1 |
| 1 | verdict | u8 | 1 approve, 2 reject |
| 2 | reason | u16 | `<= MAX_REASON` (13) |
| 4 | tx_hash | [32] | equals `Review.tx_hash` |
| 36 | policy_hash | [32] | equals `GuardConfig.policy_hash` |
| 68 | action_kind | u8 | 0 none (reject only), 1 SOL transfer, 2 SPL `TransferChecked` |
| 69 | destination | Pubkey | SOL: recipient wallet. SPL: destination token account |
| 101 | destination_owner | Pubkey | SOL: same as destination. SPL: token account owner wallet |
| 133 | mint | Pubkey | SOL: zero. SPL: mint |
| 165 | issued_at | i64 | `<= now + 60` |
| 173 | expires_at | i64 | `> now`, `expires_at - issued_at <= max_review_lifetime` |

`tx_hash = SHA-256("wysiwys:tx:v1" || vault_transaction_pubkey || vault_transaction_account_data)`.

## Reason codes (u16)

0 WITHIN_POLICY, 1 RPC_NO_QUORUM, 2 TX_HASH_MISMATCH, 3 UNKNOWN_PROGRAM, 4 UNEXPECTED_INSTRUCTION, 5 UNSUPPORTED_FEATURE, 6 AUTHORITY_CHANGE_BLOCKED, 7 DURABLE_NONCE_DETECTED, 8 DESTINATION_NOT_WHITELISTED, 9 DESTINATION_OWNER_UNRESOLVED, 10 MINT_NOT_ALLOWED, 11 AMOUNT_OVER_CAP, 12 SCREENING_REJECTED, 13 POLICY_STALE.

---

### Task 0: Test environment

**Files:** Modify `AGENTS.md` (Commands)

Anchor 1.2 defaults to the surfpool validator, which does not load `test_forwarder` and only advances the clock on transactions (the expiry test then waits forever). The test config in `Anchor.toml` targets `solana-test-validator`.

- [x] Run `anchor test --validator legacy`. Baseline after the main merge: 52 passing.
- [x] Document `anchor test --validator legacy` in AGENTS.md Commands.

### Task 1: Shared contracts (TypeScript)

**Files:** Modify `packages/shared/src/report.ts`, `guard.ts`, `reasons.ts`, `report.test.ts`

**Interfaces produced:**
- `REPORT_PAYLOAD_LEN = 181`, `REPORT_VERSION = 1`, `ACTION_KIND = { NONE: 0, SOL: 1, SPL: 2 }`
- `interface ReportPayload { verdict; reason; txHash; policyHash; actionKind; destination: Uint8Array; destinationOwner: Uint8Array; mint: Uint8Array; issuedAt: bigint; expiresAt: bigint }`
- `encodeReportPayload(p): Uint8Array`, `decodeReportPayload(b): ReportPayload`
- `txHash(vaultTransaction: Uint8Array /*32*/, data: Uint8Array): Uint8Array`
- `ReviewReason` (0..13), `MAX_REASON = 13`, error list without `IntentMismatch` plus `DestinationChanged`, `ReviewDeadlinePassed`, `InvalidConfig`

- [x] **Step 1: Write failing tests** in `report.test.ts`: payload is 181 bytes with the offsets in the table; round-trip; wrong length throws; `txHash` vectors (`txHash(zeros32, "abc")` equals the Rust vector from Task 2); error codes (`DestinationChanged` = 6019 … `InvalidConfig` = 6021); reason codes (`POLICY_STALE === MAX_REASON === 13`).
- [x] **Step 2:** `npm test --workspace=packages/shared` → FAIL.
- [x] **Step 3:** Implement `report.ts`, `guard.ts`, `reasons.ts`. Remove `intentHash`.
- [x] **Step 4:** `npm test --workspace=packages/shared` → PASS.

### Task 2: Pure guard logic (Rust unit tests)

**Files:** Modify `constants.rs`, `errors.rs`, `state.rs`, `logic.rs`

**Interfaces produced:**
- `pub fn tx_hash(vault_transaction: &Pubkey, data: &[u8]) -> [u8; 32]`
- `pub struct ReportPayload { verdict, reason, tx_hash, policy_hash, action_kind, destination, destination_owner, mint, issued_at, expires_at }`
- `pub fn decode_report(bytes: &[u8], now: i64) -> Result<ReportPayload>`: length, version, verdict, reason, action kind rules, `issued_at <= now + MAX_CLOCK_SKEW`, `expires_at > now`, `expires_at > issued_at`.
- `pub fn check_report_times(p: &ReportPayload, created_at: i64, now: i64, cfg: &GuardConfig) -> Result<()>`: `now <= created_at + review_deadline_secs` else `ReviewDeadlinePassed`; `expires_at - issued_at <= max_review_lifetime` else `InvalidPayload`.
- `pub fn check_destination(kind: u8, expected: &Pubkey, expected_owner: &Pubkey, expected_mint: &Pubkey, key: &Pubkey, owner_program: &Pubkey, data: &[u8]) -> Result<()>`: key must equal `expected`; for SPL, `owner_program == SPL_TOKEN_PROGRAM_ID`, `data.len() == 165`, `data[0..32] == mint`, `data[32..64] == owner`, `data[108] == 1` (Initialized, not frozen). Any failure → `DestinationChanged`.

- [x] **Step 1: Write failing unit tests** in `logic.rs` covering: tx_hash vector + domain separation (different vault tx key → different hash); payload decode happy path for SOL and SPL; exact length; version != 1; verdict 0/3; reason 14; approve with kind 0; kind 3; SOL with mint != 0 or owner != destination; SPL with zero mint; issued_at in the future beyond skew; expires_at <= now; expires_at <= issued_at; deadline passed; lifetime exceeded; destination checks (wrong key, wrong program, wrong mint, wrong owner, frozen, short data; SOL accepts matching key with any data).
- [x] **Step 2:** `cargo test -p wysiwys_guard` → FAIL to compile / FAIL.
- [x] **Step 3:** Implement constants, errors, state fields, logic.
- [x] **Step 4:** `cargo test -p wysiwys_guard` → PASS.

### Task 3: Instructions

**Files:** Modify `instructions/initialize_guard.rs`, `request_review.rs`, `on_report.rs`, `guarded_execute.rs`, `lib.rs`, `events.rs`

- `initialize_guard(forwarder_program, forwarder_state, policy_hash, workflow_owner, max_review_lifetime: i64, review_deadline_secs: i64)`; both durations must be `> 0` else `InvalidConfig`.
- `request_review()` takes no arguments; stores `tx_hash`; emits `ReviewRequested { review, multisig, tx_index, tx_hash }`.
- `on_report`: forwarder + workflow checks unchanged; Pending; `decode_report`; `check_report_times`; `tx_hash` and `policy_hash` equality; store verdict, reason, destination facts, `issued_at`, `expires_at`; emit `DecisionRecorded { review, verdict, reason, policy_hash, action_kind, destination, destination_owner, mint, expires_at }`.
- `guarded_execute`: new account `destination: UncheckedAccount` after `vault_transaction`; recompute `tx_hash`; `check_destination` before writing Executed.

- [x] **Step 1: Update failing integration tests** (Task 4 helpers first): `initialize_guard` rejects zero durations; `request_review` stores `tx_hash` computed with the domain; `on_report` stores destination facts, rejects tx_hash/policy mismatch, late delivery, over-long lifetime; `guarded_execute` passes `destination`.
- [x] **Step 2:** `anchor build && anchor test` → FAIL.
- [x] **Step 3:** Implement.
- [x] **Step 4:** `anchor test` → PASS. Copy `target/idl/wysiwys_guard.json` to `packages/shared/idl/`.

### Task 4: Integration tests and helpers

**Files:** Modify `tests/helpers/guard.ts`, `tests/helpers/forwarder.ts`, `tests/initialize_guard.ts`, `tests/request_review.ts`, `tests/on_report.ts`, `tests/guarded_execute.ts`

- `setupGuardedDesk` passes `MAX_REVIEW_LIFETIME = 3600n` and `REVIEW_DEADLINE = 900n` (overridable).
- `requestReview(desk, p, proposer?)` with no hashes.
- `approvePayload(review, desk, overrides)` builds an SPL payload for `desk.counterpartyAta` / `desk.counterparty` / `desk.mint`, `issuedAt = now`, `expiresAt = now + 600`.
- New `guarded_execute` tests: destination owner changed after approval (SPL `SetAuthority` AccountOwner on `counterpartyAta`, signed by `counterparty`) → `DestinationChanged`, review stays Approved; wrong destination account passed → `DestinationChanged`.
- New `on_report` tests: deadline passed (guard with `review_deadline_secs = 1`, wait 2s) → `ReviewDeadlinePassed`; `expiresAt - issuedAt > lifetime` → `InvalidPayload`; stored destination facts equal the payload.

### Task 5: Docs

**Files:** Modify `README.md`, `AGENTS.md`, `packages/shared/README.md`

- [x] README security table: replace intent check with destination re-check, deadline and lifetime rows; drop the OTC note.
- [x] AGENTS.md "Contracts to freeze": record the decisions above (payload v1, no `RequestHead`, immutable config, reason codes) as frozen.
