# Treasury Guard (Solana Program) Implementation Plan v2

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Use TDD for every task: write the failing test, run it, implement, run it, commit.

> **Hackathon rule:** this plan was written before kickoff and contains no code. All code is written after the hacking period starts (6 Oct 2026, 12:00 SGT).

**Goal:** An Anchor program that holds the only Execute permission on a Squads v4 multisig and executes a vault transaction only when a CRE report has approved that exact transaction.

**Architecture:**
- Squads v4 is the multisig: 3 humans with Initiate + Vote, threshold **3 of 3**, and the guard's `executor` PDA as the only member with Execute.
- The guard stores a `Review` per Squads transaction, receives the CRE verdict via `on_report`, and executes through a CPI into Squads `vault_transaction_execute`, signed by the executor PDA.
- CRE reads Solana only through HTTP (NOWNodes + a second RPC). It is triggered over HTTP by an off-chain **listener** that subscribes to the guard's events via NOWNodes WebSocket, so the guard must emit clear Anchor events.
- Two reporter modes:
  - **Mode 1 (dev key):** the hosted CRE simulation runner on AWS EC2 submits `on_report` signed by a runner key. Used for the live demo.
  - **Mode 0 (forwarder):** Chainlink DON report delivered by the Keystone Forwarder. Production path, used if Chainlink deploys the workflow.

**Tech stack:** Rust, Anchor, Solana devnet, Squads v4 (`SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`, same ID on devnet), `@sqds/multisig` for tests, scripts and the web app, TypeScript tests via `anchor test` on a local validator that clones Squads from devnet.

---

## Shared interfaces (frozen with the team by 14:00 day 1, in `packages/shared`)

**Seeds**
- `GuardConfig`: `["config", multisig]`
- `Review`: `["review", multisig, tx_index (u64 LE)]`
- `executor` (signer only, no data): `["executor", multisig]`

**Events (Anchor `emit!`, consumed by the listener)**
- `ReviewRequested { multisig, tx_index, review, msg_hash }`
- `DecisionRecorded { review, verdict, reason, policy_hash, expiry }`
- `Executed { review, multisig, tx_index }`
- `ExecutionBlocked { review, error_code }` (optional, emitted only on paths that do not revert; most blocks are reverts and are tracked by the UI instead)

**CRE report payload (Borsh, fixed size)**: `{ review: Pubkey, msg_hash: [u8; 32], verdict: u8 (1 = approve, 2 = reject), reason: u16, policy_hash: [u8; 32], expiry: i64 }`

**Reason codes** (shared with workflow and UI): 0 ok, 1 recipient not allowlisted, 2 amount over limit, 3 authority or owner change, 4 durable nonce instruction, 5 unknown or unsupported program/instruction, 6 new delegate, 7 data source mismatch, 8 hash mismatch.

**`msg_hash`**: SHA-256 of the full Squads `VaultTransaction` account data, computed on-chain in `request_review`. The CRE workflow re-hashes the fetched bytes and must match before decoding.

**Deployment config**: `deployments/devnet.json` with `programId, multisig, vault, executorPda, configPda, mint, forwarderProgram, reporterKey, signers`. Owned by Jun Heng, written by the bootstrap script, read by everyone.

---

## Accounts

**GuardConfig** (immutable after init): `multisig`, `reporter_mode` (0 forwarder, 1 dev key), `trusted_reporter` (forwarder authority PDA or runner key), `forwarder_program`, `policy_hash`, `bump`, `executor_bump`.
- No admin update instruction. Changing config means re-running bootstrap with a new multisig. This removes the admin backdoor.

**Review**: `multisig`, `tx_index`, `msg_hash`, `status` (Pending, Approved, Rejected, Executed), `reason`, `policy_hash`, `expiry`, `created_at`, `bump`.

## Errors

`NotSquadsAccount`, `WrongMultisig`, `WrongTxIndex`, `UnauthorizedReporter`, `ReviewMismatch`, `HashMismatch`, `NotApproved`, `Expired`, `AlreadyExecuted`, `InvalidStatusTransition`, `DurableNonceDetected`, `InvalidPayload`, `InvalidSquadsProgram`, `InvalidInstructionsSysvar`.

---

## Security checklist (every item must have a test)

1. 🔴 CPI target must be exactly the Squads program ID (`InvalidSquadsProgram`). A fake program must never receive the executor signature.
2. 🔴 The executor PDA signs only the Squads `vault_transaction_execute` CPI, nothing else.
3. 🔴 No admin path to change `trusted_reporter` or `reporter_mode` (config immutable).
4. 🔴 Instructions sysvar account must be the real sysvar ID (`InvalidInstructionsSysvar`) before the durable-nonce check.
5. 🟠 Owner checks: `VaultTransaction` and `Proposal` owned by Squads; `Review` and `GuardConfig` owned by the guard; seeds and bumps re-derived; `has_one = multisig`.
6. 🟠 `Review.multisig` and `Review.tx_index` must match the `VaultTransaction` being executed; re-hash its data at execute.
7. 🟠 One-way status: Pending → Approved | Rejected → Executed. No re-report after Executed. Set Executed before the CPI.
8. 🟠 `on_report`: reporter must sign and match `trusted_reporter`; payload `review` must equal the Review account passed.
9. 🟡 Expiry from `Clock::get()`, never from caller input.
10. 🟡 Payload: exact length, no trailing bytes, verdict in {1, 2}, reason within table.
11. 🟡 `init` only, never `init_if_needed`.
12. 🟡 Upgrade authority stays with the deployer key during the hackathon; README states it moves to governance or the program is made immutable before mainnet.

---

## Task 0: Spikes (12:00 to 14:00, timeboxed)

Record answers in `docs/spikes.md`.

1. **Program ID:** generate the program keypair, set `declare_id!` and `Anchor.toml`, commit the public key to `packages/shared`. Never changes after this.
2. **Squads on the local validator:** clone the Squads program and its ProgramConfig account from devnet in `Anchor.toml`. Create a 3 of 3 multisig with a PDA member holding only Execute. Confirm `multisigCreateV2` does not require member signatures.
3. **Squads CPI path:** check whether the `squads-multisig-program` crate (`cpi` feature) compiles with our Anchor version. If not, build `vault_transaction_execute` manually (discriminator plus account metas from the Squads source). Note the exact account order and remaining accounts.
4. **Forwarder interface (with Teammate A):** exact `on_report` signature, account order (`forwarderState`, `forwarderAuthority`, then receiver accounts), forwarder authority PDA derivation, devnet forwarder program ID.
5. **Simulation path (with Teammate A):** does `cre workflow simulate` route through the real forwarder or sign with `CRE_SOLANA_PRIVATE_KEY` directly? Confirms whether the demo uses mode 1.

**Exit criteria:** all answered. Go/no-go on the Squads CPI by **18:00 day 1**; if not working, switch to the fallback (end of plan).

---

## Task 1: Scaffold and `initialize_guard`

**Files:** `programs/treasury_guard/src/lib.rs`, `state.rs`, `errors.rs`, `events.rs`, `tests/treasury_guard.ts`

**Tests first:**
- Initializes `GuardConfig` with reporter mode, trusted reporter, forwarder program, policy hash.
- Rejects a second initialization for the same multisig.
- Executor PDA matches the client-side derivation.
- There is no instruction that can modify config afterwards.

**Commit:** `feat: initialize guard config`

## Task 2: Squads test fixture

**Files:** `tests/helpers/squads.ts`

**Build:** helper that creates the 3 of 3 multisig with the executor PDA as the Execute-only member, funds the vault with SOL and a test SPL mint, pre-creates vendor token accounts, and creates a vault transaction plus proposal. Variants: SOL transfer, `TransferChecked` to Acme, Drift-style (unknown recipient + `SetAuthority` + `AdvanceNonceAccount`), lookalike recipient.

**Test:** proposal is Active; a human member cannot execute it.

**Commit:** `test: squads fixture`

## Task 3: `request_review`

**Tests first:**
- Creates a Pending `Review` whose `msg_hash` equals SHA-256 of the vault transaction account data.
- Emits `ReviewRequested` with correct fields (listener can parse it with the IDL).
- Rejects an account not owned by Squads (`NotSquadsAccount`).
- Rejects a vault transaction from another multisig (`WrongMultisig`) or wrong index (`WrongTxIndex`).
- Works for many sequential `tx_index` values (Demo mode runs repeatedly, no leftover state).

**Commit:** `feat: request_review`

## Task 4: `on_report`

**Tests first (mode 1, dev key):**
- Valid payload from the trusted reporter sets status, reason, policy hash, expiry; emits `DecisionRecorded`.
- Any other signer → `UnauthorizedReporter`.
- Payload `review` or `msg_hash` mismatch → `ReviewMismatch` / `HashMismatch`.
- Malformed payload (wrong length, trailing bytes, verdict 0 or 3) → `InvalidPayload`.
- Report after Executed → `InvalidStatusTransition`.
- Re-report while still Pending/Approved is either rejected or idempotent (decide and document).

**Then:** implement with the Task 0 account order. Single `verify_reporter()` function handles both modes. Keep compute well under 290,000 CU.

**Commit:** `feat: on_report`

## Task 5: `guarded_execute` (core)

**Tests first:**
- Happy path: approved review, 3 of 3 votes → executes SOL transfer and token transfer; status Executed; emits `Executed`.
- Status Pending or Rejected → `NotApproved`.
- After expiry → `Expired`.
- Second execution → `AlreadyExecuted`.
- Vault transaction data no longer hashes to `msg_hash` → `HashMismatch`.
- Outer transaction starting with System `AdvanceNonceAccount` → `DurableNonceDetected`.
- Fake instructions sysvar account → `InvalidInstructionsSysvar`.
- Fake Squads program passed as CPI target → `InvalidSquadsProgram`.
- Review from a different multisig → `WrongMultisig`.
- Only 2 of 3 humans approved → Squads rejects.

**Then:** implement checks → set Executed → CPI to Squads with executor PDA seeds, passing remaining accounts through. Raise compute budget in tests.

**Commit:** `feat: guarded_execute`

## Task 6: Devnet deploy and bootstrap

**Files:** `scripts/bootstrap-devnet.ts`, `scripts/e2e-devnet.ts`, `deployments/devnet.json`

**Steps:**
- First devnet deploy by **22:00 day 1** (even partial). Deploy with priority fee via NOWNodes or a paid RPC; resume from buffer on failure.
- Bootstrap (idempotent, re-runnable): test mint, 3 signer keypairs, Squads multisig (3 of 3 + executor), `initialize_guard` (mode 1 with runner key), vault funding, vendor token accounts. Writes `deployments/devnet.json`.
- e2e script: propose → `request_review` → simulated report (dev key) → 3 votes → `guarded_execute`, for the approve path and both reject paths. Log signatures and explorer links.

**Commit:** `chore: devnet deploy, bootstrap and e2e`

## Task 7: Integrate the real CRE run

- With Teammate A: listener catches `ReviewRequested` → runner simulates → `on_report` on devnet. Save logs to `evidence/cre/`.
- If Chainlink deploys the workflow: re-run bootstrap with mode 0 (forwarder) and record that path too.

## Task 8: Security review (day 2, about 1 hour)

- Teammate B attacks the program using the security checklist; AI-assisted code review of the diff.
- README "Security" section: threat model, trust assumptions (Squads audited, Chainlink, our guard not audited), devnet only, audit before mainnet.

## Stretch tasks (only after Task 7)

- `guarded_config_execute` for Squads config transactions (member and threshold changes also need the firewall).
- Emergency bypass (all humans + time delay); note: with 3 of 3 this also needs every signer.
- Hand the upgrade authority to governance or make the program immutable after the event.

---

## Fallback (decide at 18:00 day 1)

If the CPI into Squads is not working: give Execute to a relayer keypair. The relayer calls Squads execute only after reading an Approved, unexpired, unused `Review`, then calls `mark_executed`. Tasks 3 and 4 stay unchanged. State this trade-off openly in the pitch.

## Definition of done

- All tests pass with `anchor test`, including every security checklist test.
- Devnet e2e runs the approve path and both reject paths repeatedly (Demo mode).
- Listener receives all three events; activity feed shows them.
- Explorer links and CRE logs saved for the recorded demo.
- README lists accounts, instructions, events, errors, security checks and trust assumptions.
