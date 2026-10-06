# OmniCounter Guard (Solana Program) Implementation Plan v3 (OTC pre-settlement)

**Project:** OmniCounter (OTC pre-settlement firewall for Solana)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Use TDD for every task: write the failing test, run it, implement, run it, commit.

> **Hackathon rule:** this plan was written before kickoff and contains no code. All code is written after the hacking period starts (6 Oct 2026, 12:00 SGT).

**Goal:** An Anchor program that holds the only Execute permission on an OTC desk's Squads v4 multisig and executes a payout only when a CRE report has approved that exact transaction for that exact approved trade (bound by `settlement_intent_hash` and `trade_ref_hash`), after the client's leg was verified on-chain.

**Architecture:**
- Squads v4 is the multisig: 3 humans with Initiate + Vote, threshold **3 of 3**, and the guard's `executor` PDA as the only member with Execute.
- The guard stores a `Review` per Squads transaction, receives the CRE verdict via `on_report`, and executes through a CPI into Squads `vault_transaction_execute`, signed by the executor PDA.
- CRE reads Solana with the native `SolanaClient`, cross-checked with NOWNodes. It is triggered over HTTP by an off-chain **listener** that subscribes to the guard's events via NOWNodes WebSocket, so the guard must emit clear Anchor events.
- One reporter path: the **Keystone Forwarder**. `cre workflow simulate --broadcast` uses Chainlink's simulator mock forwarder on devnet (program `7kuEAA3mSC1Tz8gQjnvH7bKFda9xSPRRin9SZbH49cNK`, state `5Tipz3yhTBdVsDbaBxZkrp7Gjf3brGq5SKkxReefPMP7`), so the demo exercises the real forwarder checks. `CRE_SOLANA_PRIVATE_KEY` only pays fees. No dev-key mode.

**Tech stack:** Rust, Anchor, Solana devnet, Squads v4 (`SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`, same ID on devnet), `@sqds/multisig` for tests, scripts and the web app, TypeScript tests via `anchor test` on a local validator that clones Squads from devnet.

---

## Shared interfaces (frozen with the team by 14:00 day 1, in `packages/shared`)

**Seeds**
- `GuardConfig`: `["config", multisig]`
- `Review`: `["review", multisig, tx_index (u64 LE)]`
- `executor` (signer only, no data): `["executor", multisig]`

**Events (Anchor `emit!`, consumed by the listener)**
- `ReviewRequested { review, multisig, tx_index, msg_hash, settlement_intent_hash, trade_ref_hash }`
- `DecisionRecorded { review, verdict, reason, policy_hash, expires_at }`
- `Executed { review, multisig, tx_index }`
- `ExecutionBlocked { review, error_code }` (optional, emitted only on paths that do not revert; most blocks are reverts and are tracked by the UI instead)

**Instruction signatures**
- `request_review(settlement_intent_hash: [u8; 32], trade_ref_hash: [u8; 32])`; accounts `multisig, vault_transaction, proposal, review (init), payer, system_program`
- `on_report(metadata: Vec<u8>, report: Vec<u8>)`; accounts `forwarder_state, forwarder_authority (signer), config, review` (forwarder accounts first, per Chainlink's `kv_store_receiver`)

**CRE report payload (Borsh, fixed 171 bytes)**: `{ review: Pubkey, verdict: u8 (1 = approve, 2 = reject), reason: u16, msg_hash: [u8; 32], settlement_intent_hash: [u8; 32], trade_ref_hash: [u8; 32], policy_hash: [u8; 32], expires_at: i64 }`. `expires_at` = min(policy expiry, trade `valid_until`), set by the workflow.

**Reason codes** (`ReviewReason`, u16, shared with workflow and UI): 0 WITHIN_POLICY, 1 RPC_NO_CONSENSUS, 2 TX_HASH_MISMATCH, 3 TRADE_NOT_FOUND, 4 TRADE_NOT_READY, 5 TRADE_EXPIRED, 6 TRADE_CANCELLED, 7 TRADE_ALREADY_SETTLED, 8 INTENT_HASH_MISMATCH, 9 COUNTERPARTY_LEG_NOT_RECEIVED, 10 ASSET_MISMATCH, 11 AMOUNT_MISMATCH, 12 DESTINATION_MISMATCH, 13 UNEXPECTED_INSTRUCTION, 14 UNKNOWN_PROGRAM, 15 AUTHORITY_CHANGE_BLOCKED, 16 DURABLE_NONCE_DETECTED, 17 COUNTERPARTY_SUSPENDED, 18 WALLET_NOT_VERIFIED, 19 SANCTIONED_WALLET, 20 WALLET_RISK_REJECTED, 21 LIMIT_EXCEEDED, 22 POLICY_HASH_MISMATCH. The guard only range-checks `reason` (<= 22); it never interprets it.

**`settlement_intent_hash` / `trade_ref_hash`**: computed off-chain by `packages/shared` (canonical SettlementIntent; SHA-256 of `trade_id + ":" + version`). The guard stores them opaquely and requires the report to echo them exactly.

**`msg_hash`**: SHA-256 of the full Squads `VaultTransaction` account data, computed on-chain in `request_review`. The CRE workflow re-hashes the fetched bytes and must match before decoding.

**Deployment config**: `deployments/devnet.json` with `programId, multisig, vault, executorPda, configPda, mint, forwarderProgram, forwarderState, policyHash, signers`. Owned by Jun Heng, written by the bootstrap script, read by everyone.

---

## Accounts

**GuardConfig** (immutable after init): `multisig`, `forwarder_program`, `forwarder_state`, `policy_hash`, `bump`, `executor_bump`.
- No admin update instruction. Changing config means re-running bootstrap with a new multisig. This removes the admin backdoor.

**Review**: `version`, `multisig`, `vault_transaction`, `proposal`, `tx_index`, `msg_hash`, `settlement_intent_hash`, `trade_ref_hash`, `status` (Pending, Approved, Rejected, Executed), `reason`, `policy_hash`, `expires_at`, `created_at`, `bump`. One status enum; no separate `used` flag.

## Errors

`NotSquadsAccount`, `WrongMultisig`, `WrongTxIndex`, `ReviewMismatch`, `HashMismatch`, `NotApproved`, `Expired`, `AlreadyExecuted`, `InvalidStatusTransition`, `DurableNonceDetected`, `InvalidPayload`, `InvalidSquadsProgram`, `InvalidInstructionsSysvar`, `PolicyMismatch`, `IntentMismatch`, `InvalidForwarder`.

---

## Security checklist (every item must have a test)

1. 🔴 CPI target must be exactly the Squads program ID (`InvalidSquadsProgram`). A fake program must never receive the executor signature.
2. 🔴 The executor PDA signs only the Squads `vault_transaction_execute` CPI, nothing else.
3. 🔴 No admin path to change `forwarder_program`, `forwarder_state` or `policy_hash` (config immutable).
4. 🔴 Instructions sysvar account must be the real sysvar ID (`InvalidInstructionsSysvar`) before the durable-nonce check.
5. 🟠 Owner checks: `VaultTransaction` and `Proposal` owned by Squads; `Review` and `GuardConfig` owned by the guard; seeds and bumps re-derived; `has_one = multisig`.
6. 🟠 `Review.multisig` and `Review.tx_index` must match the `VaultTransaction` being executed; re-hash its data at execute.
7. 🟠 One-way status: Pending → Approved | Rejected → Executed. No re-report after Executed. Set Executed before the CPI.
8. 🟠 `on_report`: `forwarder_state` owned by `forwarder_program` and equal to config; `forwarder_authority` == PDA `["forwarder", state, guard_id]` under the forwarder program and signed (`InvalidForwarder`); payload `review` equals the Review passed; `msg_hash` equal (`HashMismatch`); `settlement_intent_hash` and `trade_ref_hash` equal (`IntentMismatch`); `policy_hash` equals config (`PolicyMismatch`).
9. 🟡 Expiry from `Clock::get()`, never from caller input.
10. 🟡 Payload: exactly 171 bytes, no trailing bytes, verdict in {1, 2}, reason <= 22, `expires_at` > now.
11. 🟡 `init` only, never `init_if_needed`.
12. 🟡 Upgrade authority stays with the deployer key during the hackathon; README states it moves to governance or the program is made immutable before mainnet.

---

## Task 0: Spikes (12:00 to 14:00, timeboxed)

Record answers in `docs/spikes.md`.

1. **Program ID:** generate the program keypair, set `declare_id!` and `Anchor.toml`, commit the public key to `packages/shared`. Never changes after this.
2. **Squads on the local validator:** clone the Squads program and its ProgramConfig account from devnet in `Anchor.toml`. Create a 3 of 3 multisig with a PDA member holding only Execute. Confirm `multisigCreateV2` does not require member signatures.
3. **Squads CPI path:** check whether the `squads-multisig-program` crate (`cpi` feature) compiles with our Anchor version. If not, build `vault_transaction_execute` manually (discriminator plus account metas from the Squads source). Note the exact account order and remaining accounts.
4. **Forwarder interface (with Teammate A):** confirm against `building-blocks/solana-read-write` (`kv_store_receiver`): `on_report(metadata, report)`, accounts `forwarderState`, `forwarderAuthority`, then receiver accounts; authority PDA `["forwarder", state, receiver_program_id]`.
5. **Simulation path (with Teammate A):** confirm `cre workflow simulate --broadcast` delivers through the mock forwarder (`7kuE...cNK`, state `5Tip...PMP7`) to our program on devnet. If it does not, only then add a dev-key fallback.

**Exit criteria:** all answered. Go/no-go on the Squads CPI by **18:00 day 1**; if not working, switch to the fallback (end of plan).

---

## Task 1: Scaffold and `initialize_guard`

**Files:** `programs/omnicounter_guard/src/lib.rs`, `state.rs`, `errors.rs`, `events.rs`, `tests/omnicounter_guard.ts`

**Tests first:**
- Initializes `GuardConfig` with forwarder program, forwarder state, policy hash.
- Rejects a second initialization for the same multisig.
- Executor PDA matches the client-side derivation.
- There is no instruction that can modify config afterwards.

**Commit:** `feat: initialize guard config`

## Task 2: Squads test fixture

**Files:** `tests/helpers/squads.ts`

**Build:** helper that creates the 3 of 3 multisig with the executor PDA as the Execute-only member, funds the vault with a test USDC mint, pre-creates counterparty token accounts, and creates a vault transaction plus proposal. Variants: clean OTC payout (`TransferChecked` USDC to the counterparty's verified wallet), lookalike destination, Drift-style (extra `SetAuthority` + `AdvanceNonceAccount`).

**Test:** proposal is Active; a human member cannot execute it.

**Commit:** `test: squads fixture`

## Task 3: `request_review`

**Tests first:**
- Creates a Pending `Review` whose `msg_hash` equals SHA-256 of the vault transaction account data, computed on-chain.
- Stores `settlement_intent_hash`, `trade_ref_hash`, `vault_transaction`, `proposal` exactly as passed.
- Emits `ReviewRequested` with correct fields (listener can parse it with the IDL).
- Second `request_review` for the same tx index fails (`init`).
- Rejects an account not owned by Squads (`NotSquadsAccount`).
- Rejects a vault transaction from another multisig (`WrongMultisig`) or wrong index (`WrongTxIndex`).
- Works for many sequential `tx_index` values (Demo mode runs repeatedly, no leftover state).

**Commit:** `feat: request_review`

## Task 4: `on_report`

**Tests first (local validator with a test forwarder that mirrors the mock forwarder's PDA scheme):**
- Valid payload via the forwarder sets status, reason, policy hash, expiry; emits `DecisionRecorded`.
- Wrong forwarder state owner, wrong authority PDA or unsigned authority → `InvalidForwarder`.
- Payload `review` or `msg_hash` mismatch → `ReviewMismatch` / `HashMismatch`.
- `settlement_intent_hash` or `trade_ref_hash` mismatch → `IntentMismatch`.
- `policy_hash` different from config → `PolicyMismatch`.
- Malformed payload (not 171 bytes, trailing bytes, verdict 0 or 3, reason > 22, expired `expires_at`) → `InvalidPayload`.
- Report after Executed → `InvalidStatusTransition`.
- Re-report while still Pending/Approved is either rejected or idempotent (decide and document).

**Then:** implement with the Task 0 account order. Single `verify_forwarder()` function. Keep compute well under 290,000 CU.

**Commit:** `feat: on_report`

## Task 5: `guarded_execute` (core)

**Tests first:**
- Happy path: approved review, 3 of 3 votes → executes the USDC payout; status Executed; emits `Executed`.
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
- Bootstrap (idempotent, re-runnable): test USDC mint, 3 signer keypairs, Squads multisig (3 of 3 + executor), `initialize_guard` (mock forwarder program + state, policy hash), vault funding, counterparty token accounts. Writes `deployments/devnet.json`.
- e2e script: propose → `request_review` → `cre workflow simulate --broadcast` (mock forwarder) → 3 votes → `guarded_execute`, for the clean settlement and the reject paths (no client leg, lookalike, Drift-style). Log signatures and explorer links.

**Commit:** `chore: devnet deploy, bootstrap and e2e`

## Task 7: Integrate the real CRE run

- With Teammate A: listener catches `ReviewRequested` → runner simulates → `on_report` on devnet. Save logs to `evidence/cre/`.
- If Chainlink deploys the workflow to a DON: re-run bootstrap with the production forwarder program and state, and record that path too.

## Task 8: Security review (day 2, about 1 hour)

- Teammate B attacks the program using the security checklist; AI-assisted code review of the diff.
- README "Security" section: threat model, trust assumptions (Squads audited, Chainlink, our guard not audited), devnet only, audit before mainnet.

## Stretch tasks (only after Task 7)

- `guarded_config_execute` for Squads config transactions (member and threshold changes also need the firewall).
- Emergency bypass (all humans + time delay); note: with 3 of 3 this also needs every signer.
- Hand the upgrade authority to governance or make the program immutable after the event.

---

## Fallback (decide at 18:00 day 1)

If the CPI into Squads is not working: give Execute to a relayer keypair. The relayer calls Squads execute only after reading an Approved, unexpired `Review` whose `msg_hash` still matches, then calls `mark_executed`. Tasks 3 and 4 stay unchanged. State this trade-off openly in the pitch.

## Definition of done

- All tests pass with `anchor test`, including every security checklist test.
- Devnet e2e runs the clean settlement and all reject paths repeatedly (Demo mode).
- Listener receives all three events; activity feed shows them.
- Explorer links and CRE logs saved for the recorded demo.
- README lists accounts, instructions, events, errors, security checks and trust assumptions.
