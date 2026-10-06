# Wysiwys Guard Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `wysiwys_guard` Anchor program so a Squads v4 payout executes only through `guarded_execute`, after a Chainlink CRE report (delivered by the Keystone forwarder) approved that exact vault transaction for that exact trade.

**Architecture:** One Anchor 1.2.0 program with four instructions (`initialize_guard`, `request_review`, `on_report`, `guarded_execute`). All parsing, payload decoding and checks live in a pure `logic` module covered by `cargo test`; instruction handlers are thin wiring covered by `anchor test` on a local validator that loads the real Squads v4 program. The CPI into Squads `vault_transaction_execute` is built by hand (the `squads-multisig-program` crate is pinned to an old Anchor). A test-only `test_forwarder` program reproduces the Keystone forwarder CPI so the forwarder checks are exercised locally.

**Tech Stack:** Rust 1.89, Anchor 1.2.0 (`anchor-lang = "1.2.0"`), `solana-sha256-hasher 3`, `solana-instructions-sysvar 3`, TypeScript tests with mocha + chai run through `tsx`, `@anchor-lang/core 1.2`, `@solana/web3.js 1.x`, `@sqds/multisig 2.1.4`, `@solana/spl-token 0.4`, `@noble/hashes 1.x`.

**Spec:** `docs/plans/2026-10-06-wysiwys-guard-solana-plan.md` (guard plan v3) plus the decisions recorded below. `AGENTS.md` holds the frozen interfaces.

## Decisions made while planning (6 Oct)

1. **Report payload is 107 bytes, not 171.** CRE's default Solana `ReportSizeLimit` is 265 bytes of raw report (109-byte header + 32-byte account hash + 4-byte length + payload), so the payload must be at most 120 bytes. Approved by the user. New layout (little-endian, no Borsh framing):

   | offset | size | field |
   |---|---|---|
   | 0 | 1 | `verdict` u8 (1 approve, 2 reject) |
   | 1 | 2 | `reason` u16 (<= 22) |
   | 3 | 32 | `msg_hash` |
   | 35 | 32 | `intent_hash` = SHA-256(`settlement_intent_hash` \|\| `trade_ref_hash`) |
   | 67 | 32 | `policy_hash` |
   | 99 | 8 | `expires_at` i64 |

   `review` is dropped: the Review is the account passed to `on_report`, and its PDA is bound to `multisig` + `tx_index`, which `msg_hash` already covers. The workflow echoes the Review's stored hashes and reports problems through `reason`. `expires_at` must be in the future for rejects too.
2. **Re-report policy:** `on_report` only accepts a Review in `Pending`. Approved, Rejected or Executed → `InvalidStatusTransition`. A rejected trade needs a new Squads proposal (Demo mode creates one per run anyway).
3. **`initialize_guard` front-running guard:** it takes the Squads `create_key` as a signer and re-derives the multisig PDA from it, so only whoever created the multisig can attach a config.
4. **Sole-executor check at init:** `initialize_guard` parses the Squads `Multisig` and requires `config_authority == default` (autonomous multisig), the executor PDA to be a member with exactly the Execute permission, and no other member to have Execute. New error `InvalidMultisigConfig`. Without this, a human holding Execute bypasses the firewall.
5. **Squads facts (verified against Squads v4 source and devnet):**
   - Account discriminators: `VaultTransaction` `[168, 250, 162, 100, 81, 14, 162, 207]`, `Proposal` `[26, 94, 189, 187, 116, 136, 53, 33]`, `Multisig` `[224, 116, 121, 186, 68, 161, 79, 236]`.
   - `VaultTransaction`: `multisig` at bytes 8..40, `index` u64 LE at 72..80.
   - `Proposal`: `multisig` at 8..40, `transaction_index` u64 LE at 40..48.
   - `Multisig`: `config_authority` at 40..72, `rent_collector` Option tag at 94, then `bump`, then `members: Vec<{key, mask u8}>` (33 bytes each). Permission bits: Initiate 1, Vote 2, Execute 4.
   - `vault_transaction_execute`: discriminator `[194, 8, 161, 87, 153, 164, 25, 171]`, no args. Accounts: `multisig` (ro), `proposal` (w), `transaction` (ro), `member` (signer). Then remaining accounts in message order; the vault PDA is passed as a non-signer. Squads checks member Execute permission and proposal `Approved`. Execute does not modify the `VaultTransaction` account.
   - Devnet `ProgramConfig` PDA `BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr` (treasury `HM5y4mz3Bt9JY9mr1hkyhnvqxSH4H2u2451j7Hc2dtvK`, creation fee 0).
6. **Forwarder facts (verified against `chainlink-solana` and `cre-templates`):** the forwarder CPIs with data `[214, 173, 18, 221, 173, 148, 151, 208]` (Anchor `global:on_report`) + Borsh `Vec<u8>` metadata (64 bytes) + Borsh `Vec<u8>` report. Accounts `[forwarder_state (ro), forwarder_authority (signer, ro), ...receiver accounts (non-signer)]`. Authority PDA `["forwarder", state, receiver_program_id]` under the forwarder program. The workflow passes `[forwarderState, forwarderAuthority, config, review]`. Compute limit: use 290,000 or less in `computeConfig`.

## Global Constraints

- Anchor `1.2.0`, Rust `1.89.0` (from `rust-toolchain.toml`), Solana CLI 4.x. Do not change versions.
- Squads program ID is exactly `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` and lives only as a constant in the guard program and test helpers.
- Never hardcode devnet addresses (multisig, vault, mint, forwarder) outside `deployments/devnet.json`; tests create their own.
- Seeds: `["config", multisig]`, `["review", multisig, tx_index u64 LE]`, `["executor", multisig]`, forwarder authority `["forwarder", state, guard_id]`.
- Events: `ReviewRequested { review, multisig, tx_index, msg_hash, settlement_intent_hash, trade_ref_hash }`, `DecisionRecorded { review, verdict, reason, policy_hash, expires_at }`, `Executed { review, multisig, tx_index }`.
- `init` only, never `init_if_needed`. No instruction may modify `GuardConfig` after init.
- Exactly one `invoke_signed` in the guard, and it targets Squads `vault_transaction_execute`.
- Status is one-way: Pending → Approved | Rejected; Approved → Executed. Executed is written to the account before the CPI.
- Expiry uses `Clock::get()`. Payload decoding is exact-length and range-checked.
- `packages/shared` owns cross-component TS contracts (seeds, payload codec, reason codes, error codes, IDL). Do not redefine them in tests.
- Never commit or push unless the user asks. Every "Checkpoint" step below means: run the tests, report to the user, and commit with the given message only if asked.
- Never use em dashes in docs or user-facing text.
- Never commit keypairs. Program keypairs are backed up to `keys/` (gitignored).

## Review Focus

1. **Report arrives before the votes, execute attempted at 2 of 3:** the transaction reverts with Squads `InvalidProposalStatus`, the Review stays `Approved` (the Executed write is rolled back), and execute succeeds after the third vote. Test in Task 7.
2. **Squads multisig with `rent_collector = Some`:** the members vector shifts by 32 bytes; `parse_multisig` must handle both Option tags. Test in Task 2.
3. **A Squads `Proposal` passed as `vault_transaction`:** both are Squads-owned and both start with the multisig key; only the discriminator tells them apart. Expect `NotSquadsAccount`. Test in Task 5.
4. **Wrong or truncated remaining accounts in `guarded_execute`:** Squads rejects, the whole transaction reverts and the Review stays `Approved`. Test in Task 7.
5. **Reject report with an expiry in the past:** decoded as `InvalidPayload` (workflow must always set a future expiry). Test in Task 2.

---

## File structure

```
programs/wysiwys_guard/
  Cargo.toml                     add solana-sha256-hasher, solana-instructions-sysvar
  src/lib.rs                     declare_id, #[program] dispatch only
  src/constants.rs               Squads ID, seeds, discriminators, payload constants
  src/errors.rs                  GuardError (order is the error code contract)
  src/events.rs                  ReviewRequested, DecisionRecorded, Executed
  src/state.rs                   GuardConfig, Review, ReviewStatus
  src/logic.rs                   pure parsing/decoding/check functions + unit tests
  src/instructions/mod.rs
  src/instructions/initialize_guard.rs
  src/instructions/request_review.rs
  src/instructions/on_report.rs
  src/instructions/guarded_execute.rs
programs/test_forwarder/         local-test-only Keystone forwarder stand-in
  Cargo.toml, src/lib.rs
packages/shared/
  package.json, src/index.ts, src/guard.ts, src/reasons.ts, src/report.ts,
  src/report.test.ts, idl/wysiwys_guard.json
tests/
  fixtures/squads_multisig.so, fixtures/squads_program_config.json
  helpers/squads.ts              desk fixture: multisig, mint, vault, payout builders
  helpers/guard.ts               PDAs, errors, events, clock, guarded desk setup
  helpers/forwarder.ts           test forwarder setup and report delivery
  wysiwys_guard.ts           smoke: guard + Squads loaded
  squads_fixture.ts
  initialize_guard.ts
  request_review.ts
  on_report.ts
  guarded_execute.ts
  structure.ts                   IDL / source structural security tests
docs/spikes.md
```

---

### Task 0: Toolchain, program ID and Squads on the local validator

**Files:**
- Modify: `Anchor.toml`, `package.json`, `tests/wysiwys_guard.ts`, `programs/wysiwys_guard/src/lib.rs` (declare_id only)
- Create: `tests/fixtures/squads_multisig.so`, `tests/fixtures/squads_program_config.json`, `docs/spikes.md`

**Interfaces:**
- Produces: the final guard program ID (in `declare_id!` and `Anchor.toml`), a working `anchor test` that runs TypeScript through `tsx`, Squads v4 + its ProgramConfig on the local validator.

- [ ] **Step 1: Install test dependencies**

```bash
npm install
npm install --save-dev @sqds/multisig@2.1.4 @solana/web3.js@^1.98.0 @solana/spl-token@^0.4.13
```

- [ ] **Step 2: Dump Squads from devnet into fixtures**

```bash
mkdir -p tests/fixtures
solana program dump -u d SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf tests/fixtures/squads_multisig.so
solana account -u d BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr --output json -o tests/fixtures/squads_program_config.json
```

Expected: a ~1 MB `.so` and a JSON account owned by `SQDS4...`.

- [ ] **Step 3: Write the failing smoke test**

Replace `tests/wysiwys_guard.ts` with:

```ts
import * as anchor from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";

const SQUADS_PROGRAM_ID = new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
const SQUADS_PROGRAM_CONFIG = new PublicKey("BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr");

describe("smoke", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.wysiwysGuard as anchor.Program;

  it("guard is deployed to the local validator", async () => {
    const info = await provider.connection.getAccountInfo(program.programId);
    expect(info?.executable).to.equal(true);
  });

  it("Squads v4 and its ProgramConfig are loaded", async () => {
    const squads = await provider.connection.getAccountInfo(SQUADS_PROGRAM_ID);
    expect(squads?.executable).to.equal(true);
    const config = await provider.connection.getAccountInfo(SQUADS_PROGRAM_CONFIG);
    expect(config?.owner.toBase58()).to.equal(SQUADS_PROGRAM_ID.toBase58());
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `anchor test`
Expected: FAIL on "Squads v4 and its ProgramConfig are loaded" (ProgramConfig not cloned), or the run fails earlier because the placeholder program ID has no keypair match.

- [ ] **Step 5: Generate the program ID and load Squads**

```bash
anchor keys sync
mkdir -p keys && cp target/deploy/wysiwys_guard-keypair.json keys/wysiwys_guard-program-keypair.json
```

Edit `Anchor.toml`: keep `[programs.*]` as rewritten by `keys sync`, remove the old comments about placeholders, and replace the `[scripts]` and `[test.validator]` sections with:

```toml
[scripts]
test = "NODE_OPTIONS='--import tsx' npx mocha -t 1000000 'tests/**/*.ts'"

# Squads v4 loaded from a devnet dump so tests run offline and deterministically.
[[test.genesis]]
address = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf"
program = "tests/fixtures/squads_multisig.so"

[[test.validator.account]]
address = "BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr"
filename = "tests/fixtures/squads_program_config.json"
```

Remove the `url = ...` and `[[test.validator.clone]]` entries.

- [ ] **Step 6: Run the smoke tests to verify they pass**

Run: `anchor test`
Expected: 2 passing. If mocha cannot load `.ts` through `--import tsx` (mocha 9 uses `require` first), upgrade with `npm install --save-dev mocha@^10` and retry; record the outcome in `docs/spikes.md`.

- [ ] **Step 7: Record spike answers**

Create `docs/spikes.md`:

```markdown
# Spikes (6 Oct)

1. Program ID: <paste from Anchor.toml>. Keypair backed up in keys/ (gitignored). Never regenerate.
2. Squads on the local validator: loaded from tests/fixtures (devnet dump) plus ProgramConfig BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr. multisigCreateV2 needs only create_key and creator signatures.
3. Squads CPI: built by hand (the squads crate pins an old Anchor). vault_transaction_execute discriminator [194, 8, 161, 87, 153, 164, 25, 171]; accounts multisig (ro), proposal (w), transaction (ro), member (signer), then message accounts in order with the vault as non-signer.
4. Forwarder: on_report(metadata, report); accounts [forwarder_state, forwarder_authority (signer)] then receiver accounts; authority PDA ["forwarder", state, receiver_program_id] under the forwarder program. Metadata is 64 bytes (workflow_cid 32, workflow_name 10, workflow_owner 20, report_id 2).
5. Report size: CRE Solana ReportSizeLimit is 265 bytes of raw report, so the payload was cut to 107 bytes (see AGENTS.md). Simulate --broadcast through the mock forwarder: to be confirmed with Teammate A.
```

- [ ] **Step 8: Checkpoint**

```bash
git add Anchor.toml package.json package-lock.json programs/wysiwys_guard/src/lib.rs tests docs/spikes.md
git commit -m "chore(guard): program id, squads on local validator, spike notes"
```

---

### Task 1: Shared contracts in `packages/shared` and the interface docs

**Files:**
- Modify: `packages/shared/package.json`, `AGENTS.md`, `docs/plans/2026-10-06-wysiwys-guard-solana-plan.md`
- Create: `packages/shared/src/index.ts`, `packages/shared/src/guard.ts`, `packages/shared/src/reasons.ts`, `packages/shared/src/report.ts`, `packages/shared/src/report.test.ts`

**Interfaces:**
- Produces (imported as `@wysiwys/shared`):
  - `SEEDS: { config: "config"; review: "review"; executor: "executor"; forwarder: "forwarder" }`
  - `txIndexSeed(txIndex: bigint): Uint8Array` (8 bytes, u64 LE)
  - `GuardErrorCode: Record<GuardErrorName, number>` (6000 + enum order)
  - `ReviewStatus = { Pending: 0, Approved: 1, Rejected: 2, Executed: 3 }`
  - `ReviewReason` (0..22), `MAX_REASON = 22`
  - `REPORT_PAYLOAD_LEN = 107`, `VERDICT = { APPROVE: 1, REJECT: 2 }`
  - `interface ReportPayload { verdict: 1 | 2; reason: number; msgHash: Uint8Array; intentHash: Uint8Array; policyHash: Uint8Array; expiresAt: bigint }`
  - `intentHash(settlementIntentHash: Uint8Array, tradeRefHash: Uint8Array): Uint8Array`
  - `encodeReportPayload(p: ReportPayload): Uint8Array`, `decodeReportPayload(bytes: Uint8Array): ReportPayload`

- [ ] **Step 1: Configure the package**

Replace `packages/shared/package.json` with:

```json
{
  "name": "@wysiwys/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "tsx --test src/*.test.ts",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@noble/hashes": "^1.8.0"
  }
}
```

Run: `npm install`

- [ ] **Step 2: Write the failing test**

Create `packages/shared/src/report.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REPORT_PAYLOAD_LEN, VERDICT, encodeReportPayload, decodeReportPayload, intentHash,
  txIndexSeed, GuardErrorCode, ReviewReason, MAX_REASON,
} from "./index";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const filled = (n: number) => new Uint8Array(32).fill(n);

test("payload is 107 bytes with fixed offsets", () => {
  const bytes = encodeReportPayload({
    verdict: VERDICT.APPROVE, reason: 0x0102, msgHash: filled(1), intentHash: filled(2),
    policyHash: filled(3), expiresAt: 0x0102030405060708n,
  });
  assert.equal(bytes.length, REPORT_PAYLOAD_LEN);
  assert.equal(bytes[0], 1);
  assert.deepEqual([...bytes.subarray(1, 3)], [0x02, 0x01]);
  assert.equal(bytes[3], 1); assert.equal(bytes[34], 1);
  assert.equal(bytes[35], 2); assert.equal(bytes[66], 2);
  assert.equal(bytes[67], 3); assert.equal(bytes[98], 3);
  assert.deepEqual([...bytes.subarray(99, 107)], [8, 7, 6, 5, 4, 3, 2, 1]);
});

test("payload round-trips", () => {
  const p = { verdict: VERDICT.REJECT, reason: 12, msgHash: filled(9), intentHash: filled(8), policyHash: filled(7), expiresAt: 1_800_000_000n } as const;
  const back = decodeReportPayload(encodeReportPayload(p));
  assert.equal(back.verdict, 2); assert.equal(back.reason, 12); assert.equal(back.expiresAt, 1_800_000_000n);
  assert.equal(hex(back.msgHash), hex(p.msgHash));
});

test("decode rejects wrong length", () => {
  assert.throws(() => decodeReportPayload(new Uint8Array(106)));
  assert.throws(() => decodeReportPayload(new Uint8Array(108)));
});

test("intentHash is sha256(settlement_intent_hash || trade_ref_hash), shared vector with Rust", () => {
  assert.equal(hex(intentHash(new Uint8Array(32), new Uint8Array(32))),
    "f5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b");
  const a = Uint8Array.from({ length: 32 }, (_, i) => i);
  const b = Uint8Array.from({ length: 32 }, (_, i) => i + 32);
  assert.equal(hex(intentHash(a, b)), "fdeab9acf3710362bd2658cdc9a29e8f9c757fcf9811603a8c447cd1d9151108");
});

test("txIndexSeed is u64 little-endian", () => {
  assert.deepEqual([...txIndexSeed(258n)], [2, 1, 0, 0, 0, 0, 0, 0]);
});

test("error codes follow the Rust enum order", () => {
  assert.equal(GuardErrorCode.NotSquadsAccount, 6000);
  assert.equal(GuardErrorCode.InvalidForwarder, 6015);
  assert.equal(GuardErrorCode.InvalidMultisigConfig, 6016);
});

test("reason codes match AGENTS.md", () => {
  assert.equal(ReviewReason.WITHIN_POLICY, 0);
  assert.equal(ReviewReason.COUNTERPARTY_LEG_NOT_RECEIVED, 9);
  assert.equal(ReviewReason.DESTINATION_MISMATCH, 12);
  assert.equal(ReviewReason.AUTHORITY_CHANGE_BLOCKED, 15);
  assert.equal(ReviewReason.POLICY_HASH_MISMATCH, MAX_REASON);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test --workspace=packages/shared`
Expected: FAIL, cannot find module `./index`.

- [ ] **Step 4: Implement the shared modules**

`packages/shared/src/guard.ts`:

```ts
// Guard program contracts shared by the app, runner, workflow and tests.
// Addresses live in deployments/devnet.json, not here.

export const SEEDS = {
  config: "config",
  review: "review",
  executor: "executor",
  forwarder: "forwarder",
} as const;

export function txIndexSeed(txIndex: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, txIndex, true);
  return out;
}

// Order must match programs/wysiwys_guard/src/errors.rs (Anchor codes start at 6000).
const GUARD_ERRORS = [
  "NotSquadsAccount",
  "WrongMultisig",
  "WrongTxIndex",
  "ReviewMismatch",
  "HashMismatch",
  "NotApproved",
  "Expired",
  "AlreadyExecuted",
  "InvalidStatusTransition",
  "DurableNonceDetected",
  "InvalidPayload",
  "InvalidSquadsProgram",
  "InvalidInstructionsSysvar",
  "PolicyMismatch",
  "IntentMismatch",
  "InvalidForwarder",
  "InvalidMultisigConfig",
] as const;

export type GuardErrorName = (typeof GUARD_ERRORS)[number];

export const GuardErrorCode = Object.fromEntries(
  GUARD_ERRORS.map((name, i) => [name, 6000 + i]),
) as Record<GuardErrorName, number>;

export const ReviewStatus = { Pending: 0, Approved: 1, Rejected: 2, Executed: 3 } as const;
```

`packages/shared/src/reasons.ts`:

```ts
export enum ReviewReason {
  WITHIN_POLICY = 0,
  RPC_NO_CONSENSUS = 1,
  TX_HASH_MISMATCH = 2,
  TRADE_NOT_FOUND = 3,
  TRADE_NOT_READY = 4,
  TRADE_EXPIRED = 5,
  TRADE_CANCELLED = 6,
  TRADE_ALREADY_SETTLED = 7,
  INTENT_HASH_MISMATCH = 8,
  COUNTERPARTY_LEG_NOT_RECEIVED = 9,
  ASSET_MISMATCH = 10,
  AMOUNT_MISMATCH = 11,
  DESTINATION_MISMATCH = 12,
  UNEXPECTED_INSTRUCTION = 13,
  UNKNOWN_PROGRAM = 14,
  AUTHORITY_CHANGE_BLOCKED = 15,
  DURABLE_NONCE_DETECTED = 16,
  COUNTERPARTY_SUSPENDED = 17,
  WALLET_NOT_VERIFIED = 18,
  SANCTIONED_WALLET = 19,
  WALLET_RISK_REJECTED = 20,
  LIMIT_EXCEEDED = 21,
  POLICY_HASH_MISMATCH = 22,
}

export const MAX_REASON = ReviewReason.POLICY_HASH_MISMATCH;
```

`packages/shared/src/report.ts`:

```ts
import { sha256 } from "@noble/hashes/sha256";

// CRE report payload consumed by the guard's on_report. Fixed 107 bytes, little-endian.
// Sized to fit CRE's 265-byte Solana raw report limit.
export const REPORT_PAYLOAD_LEN = 107;
export const VERDICT = { APPROVE: 1, REJECT: 2 } as const;

export interface ReportPayload {
  verdict: 1 | 2;
  reason: number;
  msgHash: Uint8Array;
  intentHash: Uint8Array;
  policyHash: Uint8Array;
  expiresAt: bigint;
}

export function intentHash(settlementIntentHash: Uint8Array, tradeRefHash: Uint8Array): Uint8Array {
  const joined = new Uint8Array(64);
  joined.set(settlementIntentHash, 0);
  joined.set(tradeRefHash, 32);
  return sha256(joined);
}

function check32(name: string, v: Uint8Array) {
  if (v.length !== 32) throw new Error(`${name} must be 32 bytes`);
}

export function encodeReportPayload(p: ReportPayload): Uint8Array {
  check32("msgHash", p.msgHash);
  check32("intentHash", p.intentHash);
  check32("policyHash", p.policyHash);
  const out = new Uint8Array(REPORT_PAYLOAD_LEN);
  const view = new DataView(out.buffer);
  view.setUint8(0, p.verdict);
  view.setUint16(1, p.reason, true);
  out.set(p.msgHash, 3);
  out.set(p.intentHash, 35);
  out.set(p.policyHash, 67);
  view.setBigInt64(99, p.expiresAt, true);
  return out;
}

export function decodeReportPayload(bytes: Uint8Array): ReportPayload {
  if (bytes.length !== REPORT_PAYLOAD_LEN) throw new Error(`payload must be ${REPORT_PAYLOAD_LEN} bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const verdict = view.getUint8(0);
  if (verdict !== 1 && verdict !== 2) throw new Error(`invalid verdict ${verdict}`);
  return {
    verdict,
    reason: view.getUint16(1, true),
    msgHash: bytes.slice(3, 35),
    intentHash: bytes.slice(35, 67),
    policyHash: bytes.slice(67, 99),
    expiresAt: view.getBigInt64(99, true),
  };
}
```

`packages/shared/src/index.ts`:

```ts
export * from "./guard";
export * from "./reasons";
export * from "./report";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test --workspace=packages/shared && npm run typecheck --workspace=packages/shared`
Expected: 7 passing, no type errors.

- [ ] **Step 6: Update the frozen interface docs**

In `AGENTS.md`, replace the "Report payload" bullet under "Frozen interfaces" with:

```markdown
- Report payload (fixed 107 bytes, little-endian, no Borsh framing): `{ verdict u8 (1 approve, 2 reject), reason u16, msg_hash [32], intent_hash [32], policy_hash [32], expires_at i64 }`, where `intent_hash` = SHA-256(`settlement_intent_hash || trade_ref_hash`). The Review is the account passed to `on_report`, not a payload field. Sized for CRE's 265-byte Solana raw report limit. Fields echo the Review's stored values; problems are reported through `reason`. `expires_at` = min(policy expiry, trade `valid_until`) and must be in the future, also for rejects. Codec: `packages/shared/src/report.ts`.
```

In `AGENTS.md` security rule 4a, replace "`msg_hash`, `settlement_intent_hash`, `trade_ref_hash` equal the Review" with "`msg_hash` and `intent_hash` match the Review; only a Pending Review accepts a report".

In `AGENTS.md` "Commands", under "# Guard program", add the line:

```bash
cargo test -p wysiwys_guard --lib      # guard pure logic unit tests
```

In `docs/plans/2026-10-06-wysiwys-guard-solana-plan.md`: replace the "CRE report payload" paragraph with the 107-byte layout above; add `InvalidMultisigConfig` to "Errors"; in Task 4 replace the last test bullet with "Re-report on a non-Pending Review → `InvalidStatusTransition` (decided 6 Oct)"; in "Accounts", add to GuardConfig: "`initialize_guard` requires the Squads `create_key` signer and checks the executor PDA is the sole Execute member of an autonomous multisig".

Tell the team (Teammate A owns the workflow) that the payload changed.

- [ ] **Step 7: Checkpoint**

```bash
git add packages/shared AGENTS.md docs/plans package-lock.json
git commit -m "feat(shared): 107-byte report payload codec, guard seeds and error codes"
```

---

### Task 2: Program skeleton and pure logic module

**Files:**
- Modify: `programs/wysiwys_guard/Cargo.toml`, `programs/wysiwys_guard/src/lib.rs`
- Create: `src/constants.rs`, `src/errors.rs`, `src/events.rs`, `src/state.rs`, `src/logic.rs` (all under `programs/wysiwys_guard/`)

**Interfaces:**
- Produces (Rust, `crate::...`):
  - `constants::{SQUADS_PROGRAM_ID, CONFIG_SEED, REVIEW_SEED, EXECUTOR_SEED, FORWARDER_SEED, VAULT_TRANSACTION_DISCRIMINATOR, PROPOSAL_DISCRIMINATOR, MULTISIG_DISCRIMINATOR, VAULT_TRANSACTION_EXECUTE_DISCRIMINATOR, PERMISSION_EXECUTE, REPORT_PAYLOAD_LEN, VERDICT_APPROVE, VERDICT_REJECT, MAX_REASON, REVIEW_VERSION}`
  - `errors::GuardError` (17 variants, order fixed)
  - `state::{GuardConfig, Review, ReviewStatus}`
  - `events::{ReviewRequested, DecisionRecorded, Executed}`
  - `logic::sha256(&[u8]) -> [u8; 32]`, `logic::intent_hash(&[u8; 32], &[u8; 32]) -> [u8; 32]`
  - `logic::parse_vault_transaction(&[u8]) -> Result<VaultTxHeader { multisig: Pubkey, index: u64 }>`
  - `logic::parse_proposal(&[u8]) -> Result<ProposalHeader { multisig: Pubkey, transaction_index: u64 }>`
  - `logic::parse_multisig(&[u8]) -> Result<MultisigInfo { config_authority: Pubkey, members: Vec<(Pubkey, u8)> }>`
  - `logic::check_sole_executor(&MultisigInfo, &Pubkey) -> Result<()>`
  - `logic::tx_index_seed_from(&[u8]) -> [u8; 8]`
  - `logic::decode_report(&[u8], now: i64) -> Result<ReportPayload { verdict, reason, msg_hash, intent_hash, policy_hash, expires_at }>`
  - `logic::verify_forwarder(state_key: &Pubkey, state_owner: &Pubkey, authority_key: &Pubkey, authority_is_signer: bool, config: &GuardConfig) -> Result<()>`
  - `logic::is_advance_nonce(program_id: &Pubkey, data: &[u8]) -> bool`
  - `logic::check_executable(status: ReviewStatus, expires_at: i64, now: i64) -> Result<()>`

- [ ] **Step 1: Add dependencies**

In `programs/wysiwys_guard/Cargo.toml`, `[dependencies]`:

```toml
anchor-lang = "1.2.0"
solana-sha256-hasher = { version = "3", features = ["sha2"] }
solana-instructions-sysvar = "3"
```

- [ ] **Step 2: Write the types the tests need**

`src/constants.rs`:

```rust
use anchor_lang::prelude::*;

pub const SQUADS_PROGRAM_ID: Pubkey = pubkey!("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");

pub const CONFIG_SEED: &[u8] = b"config";
pub const REVIEW_SEED: &[u8] = b"review";
pub const EXECUTOR_SEED: &[u8] = b"executor";
pub const FORWARDER_SEED: &[u8] = b"forwarder";

// Anchor discriminators of Squads v4 accounts and instructions (sha256 of "account:<Name>" / "global:<name>").
pub const VAULT_TRANSACTION_DISCRIMINATOR: [u8; 8] = [168, 250, 162, 100, 81, 14, 162, 207];
pub const PROPOSAL_DISCRIMINATOR: [u8; 8] = [26, 94, 189, 187, 116, 136, 53, 33];
pub const MULTISIG_DISCRIMINATOR: [u8; 8] = [224, 116, 121, 186, 68, 161, 79, 236];
pub const VAULT_TRANSACTION_EXECUTE_DISCRIMINATOR: [u8; 8] = [194, 8, 161, 87, 153, 164, 25, 171];

pub const PERMISSION_EXECUTE: u8 = 1 << 2;

pub const REPORT_PAYLOAD_LEN: usize = 107;
pub const VERDICT_APPROVE: u8 = 1;
pub const VERDICT_REJECT: u8 = 2;
pub const MAX_REASON: u16 = 22;

pub const REVIEW_VERSION: u8 = 1;
```

If `pubkey!` is not in the Anchor 1.2 prelude, use `Pubkey::from_str_const("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf")`.

`src/errors.rs` (order is the error code contract with `packages/shared/src/guard.ts`):

```rust
use anchor_lang::prelude::*;

#[error_code]
pub enum GuardError {
    #[msg("Account is not a Squads account of the expected type")]
    NotSquadsAccount,
    #[msg("Account belongs to a different multisig")]
    WrongMultisig,
    #[msg("Proposal and vault transaction indexes differ")]
    WrongTxIndex,
    #[msg("Accounts do not match the Review")]
    ReviewMismatch,
    #[msg("Vault transaction hash does not match the Review")]
    HashMismatch,
    #[msg("Review is not approved")]
    NotApproved,
    #[msg("Review approval has expired")]
    Expired,
    #[msg("Review was already executed")]
    AlreadyExecuted,
    #[msg("Invalid Review status transition")]
    InvalidStatusTransition,
    #[msg("Durable nonce transactions cannot execute payouts")]
    DurableNonceDetected,
    #[msg("Malformed report payload")]
    InvalidPayload,
    #[msg("CPI target is not the Squads program")]
    InvalidSquadsProgram,
    #[msg("Invalid instructions sysvar account")]
    InvalidInstructionsSysvar,
    #[msg("Report policy hash does not match the guard config")]
    PolicyMismatch,
    #[msg("Report intent hash does not match the Review")]
    IntentMismatch,
    #[msg("Report did not come from the configured forwarder")]
    InvalidForwarder,
    #[msg("Multisig must be autonomous with the executor as the only Execute member")]
    InvalidMultisigConfig,
}
```

`src/state.rs`:

```rust
use anchor_lang::prelude::*;

/// Immutable after `initialize_guard`. No instruction updates it.
#[account]
#[derive(InitSpace)]
pub struct GuardConfig {
    pub multisig: Pubkey,
    pub forwarder_program: Pubkey,
    pub forwarder_state: Pubkey,
    pub policy_hash: [u8; 32],
    pub bump: u8,
    pub executor_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum ReviewStatus {
    Pending,
    Approved,
    Rejected,
    Executed,
}

#[account]
#[derive(InitSpace)]
pub struct Review {
    pub version: u8,
    pub multisig: Pubkey,
    pub vault_transaction: Pubkey,
    pub proposal: Pubkey,
    pub tx_index: u64,
    pub msg_hash: [u8; 32],
    pub settlement_intent_hash: [u8; 32],
    pub trade_ref_hash: [u8; 32],
    pub status: ReviewStatus,
    pub reason: u16,
    pub policy_hash: [u8; 32],
    pub expires_at: i64,
    pub created_at: i64,
    pub bump: u8,
}
```

`src/events.rs`:

```rust
use anchor_lang::prelude::*;

#[event]
pub struct ReviewRequested {
    pub review: Pubkey,
    pub multisig: Pubkey,
    pub tx_index: u64,
    pub msg_hash: [u8; 32],
    pub settlement_intent_hash: [u8; 32],
    pub trade_ref_hash: [u8; 32],
}

#[event]
pub struct DecisionRecorded {
    pub review: Pubkey,
    pub verdict: u8,
    pub reason: u16,
    pub policy_hash: [u8; 32],
    pub expires_at: i64,
}

#[event]
pub struct Executed {
    pub review: Pubkey,
    pub multisig: Pubkey,
    pub tx_index: u64,
}
```

`src/lib.rs` (program stays empty until Task 3):

```rust
use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod logic;
pub mod state;

declare_id!("<GUARD_PROGRAM_ID from Task 0>");

#[program]
pub mod wysiwys_guard {}
```

- [ ] **Step 3: Write the failing unit tests**

Create `src/logic.rs` with only the test module first (functions are added in Step 5):

```rust
use anchor_lang::error::Error;
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::GuardError;
use crate::state::{GuardConfig, ReviewStatus};

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::error::Error;

    fn code_of<T>(r: Result<T>) -> u32 {
        match r {
            Err(Error::AnchorError(e)) => e.error_code_number,
            Err(e) => panic!("unexpected error {e:?}"),
            Ok(_) => panic!("expected an error"),
        }
    }
    // Anchor custom errors start at 6000.
    fn code(e: GuardError) -> u32 {
        e as u32 + 6000
    }
    fn key(n: u8) -> Pubkey {
        Pubkey::new_from_array([n; 32])
    }
    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    fn vault_tx_bytes(multisig: Pubkey, index: u64) -> Vec<u8> {
        let mut d = VAULT_TRANSACTION_DISCRIMINATOR.to_vec();
        d.extend_from_slice(multisig.as_ref());
        d.extend_from_slice(key(9).as_ref()); // creator
        d.extend_from_slice(&index.to_le_bytes());
        d.extend_from_slice(&[255, 0, 254]); // bump, vault_index, vault_bump
        d.extend_from_slice(&0u32.to_le_bytes()); // ephemeral_signer_bumps
        d
    }

    fn proposal_bytes(multisig: Pubkey, index: u64) -> Vec<u8> {
        let mut d = PROPOSAL_DISCRIMINATOR.to_vec();
        d.extend_from_slice(multisig.as_ref());
        d.extend_from_slice(&index.to_le_bytes());
        d.push(1); // Active
        d.extend_from_slice(&0i64.to_le_bytes());
        d.push(255); // bump
        for _ in 0..3 {
            d.extend_from_slice(&0u32.to_le_bytes());
        }
        d
    }

    fn multisig_bytes(config_authority: Pubkey, rent_collector: Option<Pubkey>, members: &[(Pubkey, u8)]) -> Vec<u8> {
        let mut d = MULTISIG_DISCRIMINATOR.to_vec();
        d.extend_from_slice(key(7).as_ref()); // create_key
        d.extend_from_slice(config_authority.as_ref());
        d.extend_from_slice(&3u16.to_le_bytes()); // threshold
        d.extend_from_slice(&0u32.to_le_bytes()); // time_lock
        d.extend_from_slice(&0u64.to_le_bytes()); // transaction_index
        d.extend_from_slice(&0u64.to_le_bytes()); // stale_transaction_index
        match rent_collector {
            None => d.push(0),
            Some(k) => {
                d.push(1);
                d.extend_from_slice(k.as_ref());
            }
        }
        d.push(255); // bump
        d.extend_from_slice(&(members.len() as u32).to_le_bytes());
        for (k, mask) in members {
            d.extend_from_slice(k.as_ref());
            d.push(*mask);
        }
        d
    }

    fn payload(verdict: u8, reason: u16, expires_at: i64) -> Vec<u8> {
        let mut d = vec![verdict];
        d.extend_from_slice(&reason.to_le_bytes());
        d.extend_from_slice(&[1u8; 32]);
        d.extend_from_slice(&[2u8; 32]);
        d.extend_from_slice(&[3u8; 32]);
        d.extend_from_slice(&expires_at.to_le_bytes());
        d
    }

    const HUMAN: u8 = 1 | 2; // Initiate + Vote

    // sha256

    #[test]
    fn sha256_known_vector() {
        assert_eq!(hex(&sha256(b"abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn intent_hash_matches_shared_ts_vectors() {
        assert_eq!(hex(&intent_hash(&[0; 32], &[0; 32])), "f5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b");
        let a: [u8; 32] = core::array::from_fn(|i| i as u8);
        let b: [u8; 32] = core::array::from_fn(|i| i as u8 + 32);
        assert_eq!(hex(&intent_hash(&a, &b)), "fdeab9acf3710362bd2658cdc9a29e8f9c757fcf9811603a8c447cd1d9151108");
    }

    // Squads parsing

    #[test]
    fn parses_vault_transaction_header() {
        let h = parse_vault_transaction(&vault_tx_bytes(key(1), 42)).unwrap();
        assert_eq!(h.multisig, key(1));
        assert_eq!(h.index, 42);
    }

    #[test]
    fn proposal_bytes_are_not_a_vault_transaction() {
        assert_eq!(code_of(parse_vault_transaction(&proposal_bytes(key(1), 42))), code(GuardError::NotSquadsAccount));
    }

    #[test]
    fn short_vault_transaction_is_rejected() {
        assert_eq!(code_of(parse_vault_transaction(&vault_tx_bytes(key(1), 1)[..79])), code(GuardError::NotSquadsAccount));
    }

    #[test]
    fn parses_proposal_header() {
        let h = parse_proposal(&proposal_bytes(key(2), 7)).unwrap();
        assert_eq!(h.multisig, key(2));
        assert_eq!(h.transaction_index, 7);
    }

    #[test]
    fn vault_transaction_bytes_are_not_a_proposal() {
        assert_eq!(code_of(parse_proposal(&vault_tx_bytes(key(2), 7))), code(GuardError::NotSquadsAccount));
    }

    #[test]
    fn tx_index_seed_reads_bytes_72_to_80_or_zero() {
        assert_eq!(tx_index_seed_from(&vault_tx_bytes(key(1), 258)), [2, 1, 0, 0, 0, 0, 0, 0]);
        assert_eq!(tx_index_seed_from(&[0u8; 10]), [0u8; 8]);
    }

    #[test]
    fn parses_multisig_without_rent_collector() {
        let m = parse_multisig(&multisig_bytes(Pubkey::default(), None, &[(key(1), HUMAN), (key(4), PERMISSION_EXECUTE)])).unwrap();
        assert_eq!(m.config_authority, Pubkey::default());
        assert_eq!(m.members, vec![(key(1), HUMAN), (key(4), PERMISSION_EXECUTE)]);
    }

    #[test]
    fn parses_multisig_with_rent_collector() {
        let m = parse_multisig(&multisig_bytes(Pubkey::default(), Some(key(8)), &[(key(4), PERMISSION_EXECUTE)])).unwrap();
        assert_eq!(m.members, vec![(key(4), PERMISSION_EXECUTE)]);
    }

    #[test]
    fn multisig_with_bad_option_tag_is_rejected() {
        let mut d = multisig_bytes(Pubkey::default(), None, &[]);
        d[94] = 2;
        assert_eq!(code_of(parse_multisig(&d)), code(GuardError::NotSquadsAccount));
    }

    #[test]
    fn truncated_member_list_is_rejected() {
        let d = multisig_bytes(Pubkey::default(), None, &[(key(1), HUMAN)]);
        assert_eq!(code_of(parse_multisig(&d[..d.len() - 1])), code(GuardError::NotSquadsAccount));
    }

    // Sole executor

    fn members_ok() -> Vec<(Pubkey, u8)> {
        vec![(key(1), HUMAN), (key(2), HUMAN), (key(3), HUMAN), (key(4), PERMISSION_EXECUTE)]
    }

    #[test]
    fn sole_executor_accepts_autonomous_multisig() {
        let m = MultisigInfo { config_authority: Pubkey::default(), members: members_ok() };
        check_sole_executor(&m, &key(4)).unwrap();
    }

    #[test]
    fn sole_executor_rejects_config_authority() {
        let m = MultisigInfo { config_authority: key(9), members: members_ok() };
        assert_eq!(code_of(check_sole_executor(&m, &key(4))), code(GuardError::InvalidMultisigConfig));
    }

    #[test]
    fn sole_executor_rejects_human_with_execute() {
        let mut members = members_ok();
        members[0].1 = HUMAN | PERMISSION_EXECUTE;
        let m = MultisigInfo { config_authority: Pubkey::default(), members };
        assert_eq!(code_of(check_sole_executor(&m, &key(4))), code(GuardError::InvalidMultisigConfig));
    }

    #[test]
    fn sole_executor_rejects_executor_with_vote() {
        let mut members = members_ok();
        members[3].1 = PERMISSION_EXECUTE | 2;
        let m = MultisigInfo { config_authority: Pubkey::default(), members };
        assert_eq!(code_of(check_sole_executor(&m, &key(4))), code(GuardError::InvalidMultisigConfig));
    }

    #[test]
    fn sole_executor_rejects_missing_executor() {
        let m = MultisigInfo { config_authority: Pubkey::default(), members: members_ok()[..3].to_vec() };
        assert_eq!(code_of(check_sole_executor(&m, &key(4))), code(GuardError::InvalidMultisigConfig));
    }

    // Report payload

    #[test]
    fn decodes_valid_payload() {
        let p = decode_report(&payload(VERDICT_APPROVE, 0, 1_000), 999).unwrap();
        assert_eq!(p.verdict, VERDICT_APPROVE);
        assert_eq!(p.reason, 0);
        assert_eq!(p.msg_hash, [1u8; 32]);
        assert_eq!(p.intent_hash, [2u8; 32]);
        assert_eq!(p.policy_hash, [3u8; 32]);
        assert_eq!(p.expires_at, 1_000);
    }

    #[test]
    fn payload_length_must_be_exact() {
        let p = payload(VERDICT_APPROVE, 0, 1_000);
        assert_eq!(code_of(decode_report(&p[..106], 0)), code(GuardError::InvalidPayload));
        let mut long = p.clone();
        long.push(0);
        assert_eq!(code_of(decode_report(&long, 0)), code(GuardError::InvalidPayload));
    }

    #[test]
    fn verdict_must_be_1_or_2() {
        assert_eq!(code_of(decode_report(&payload(0, 0, 1_000), 0)), code(GuardError::InvalidPayload));
        assert_eq!(code_of(decode_report(&payload(3, 0, 1_000), 0)), code(GuardError::InvalidPayload));
    }

    #[test]
    fn reason_is_range_checked() {
        assert!(decode_report(&payload(VERDICT_REJECT, 22, 1_000), 0).is_ok());
        assert_eq!(code_of(decode_report(&payload(VERDICT_REJECT, 23, 1_000), 0)), code(GuardError::InvalidPayload));
    }

    #[test]
    fn expiry_must_be_in_the_future() {
        assert!(decode_report(&payload(VERDICT_APPROVE, 0, 1_001), 1_000).is_ok());
        assert_eq!(code_of(decode_report(&payload(VERDICT_APPROVE, 0, 1_000), 1_000)), code(GuardError::InvalidPayload));
    }

    #[test]
    fn reject_with_past_expiry_is_invalid() {
        assert_eq!(code_of(decode_report(&payload(VERDICT_REJECT, 12, 10), 1_000)), code(GuardError::InvalidPayload));
    }

    // Forwarder

    fn config(forwarder_program: Pubkey, forwarder_state: Pubkey) -> GuardConfig {
        GuardConfig { multisig: key(1), forwarder_program, forwarder_state, policy_hash: [3; 32], bump: 255, executor_bump: 255 }
    }

    fn authority_for(state: &Pubkey, forwarder_program: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[FORWARDER_SEED, state.as_ref(), crate::ID.as_ref()], forwarder_program).0
    }

    #[test]
    fn forwarder_accepts_configured_state_and_authority() {
        let (prog, state) = (key(20), key(21));
        verify_forwarder(&state, &prog, &authority_for(&state, &prog), true, &config(prog, state)).unwrap();
    }

    #[test]
    fn forwarder_rejects_other_state() {
        let (prog, state, other) = (key(20), key(21), key(22));
        assert_eq!(
            code_of(verify_forwarder(&other, &prog, &authority_for(&other, &prog), true, &config(prog, state))),
            code(GuardError::InvalidForwarder)
        );
    }

    #[test]
    fn forwarder_rejects_state_with_wrong_owner() {
        let (prog, state) = (key(20), key(21));
        assert_eq!(
            code_of(verify_forwarder(&state, &key(23), &authority_for(&state, &prog), true, &config(prog, state))),
            code(GuardError::InvalidForwarder)
        );
    }

    #[test]
    fn forwarder_rejects_wrong_authority() {
        let (prog, state) = (key(20), key(21));
        assert_eq!(code_of(verify_forwarder(&state, &prog, &key(24), true, &config(prog, state))), code(GuardError::InvalidForwarder));
    }

    #[test]
    fn forwarder_rejects_unsigned_authority() {
        let (prog, state) = (key(20), key(21));
        assert_eq!(
            code_of(verify_forwarder(&state, &prog, &authority_for(&state, &prog), false, &config(prog, state))),
            code(GuardError::InvalidForwarder)
        );
    }

    // Durable nonce

    #[test]
    fn detects_advance_nonce_account() {
        let system = anchor_lang::solana_program::system_program::ID;
        assert!(is_advance_nonce(&system, &[4, 0, 0, 0]));
        assert!(!is_advance_nonce(&system, &[2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0])); // Transfer
        assert!(!is_advance_nonce(&key(5), &[4, 0, 0, 0]));
        assert!(!is_advance_nonce(&system, &[4]));
    }

    // Execution status

    #[test]
    fn approved_and_unexpired_is_executable() {
        check_executable(ReviewStatus::Approved, 1_001, 1_000).unwrap();
    }

    #[test]
    fn pending_and_rejected_are_not_approved() {
        assert_eq!(code_of(check_executable(ReviewStatus::Pending, 1_001, 1_000)), code(GuardError::NotApproved));
        assert_eq!(code_of(check_executable(ReviewStatus::Rejected, 1_001, 1_000)), code(GuardError::NotApproved));
    }

    #[test]
    fn executed_is_already_executed() {
        assert_eq!(code_of(check_executable(ReviewStatus::Executed, 1_001, 1_000)), code(GuardError::AlreadyExecuted));
    }

    #[test]
    fn approval_expires_at_expires_at() {
        assert_eq!(code_of(check_executable(ReviewStatus::Approved, 1_000, 1_000)), code(GuardError::Expired));
    }
}
```

- [ ] **Step 4: Run them to verify they fail**

Run: `cargo test -p wysiwys_guard --lib`
Expected: FAIL to compile, `cannot find function sha256`, `parse_vault_transaction`, and so on.

- [ ] **Step 5: Implement the logic module**

Add above the test module in `src/logic.rs`:

```rust
pub fn sha256(data: &[u8]) -> [u8; 32] {
    solana_sha256_hasher::hash(data).to_bytes()
}

/// SHA-256(settlement_intent_hash || trade_ref_hash). Same as `intentHash` in packages/shared.
pub fn intent_hash(settlement_intent_hash: &[u8; 32], trade_ref_hash: &[u8; 32]) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[settlement_intent_hash, trade_ref_hash]).to_bytes()
}

fn not_squads() -> Error {
    error!(GuardError::NotSquadsAccount)
}

fn read_pubkey(d: &[u8], off: usize) -> Result<Pubkey> {
    let s: [u8; 32] = d.get(off..off + 32).ok_or_else(not_squads)?.try_into().unwrap();
    Ok(Pubkey::new_from_array(s))
}

fn read_u64(d: &[u8], off: usize) -> Result<u64> {
    let s: [u8; 8] = d.get(off..off + 8).ok_or_else(not_squads)?.try_into().unwrap();
    Ok(u64::from_le_bytes(s))
}

fn read_u32(d: &[u8], off: usize) -> Result<u32> {
    let s: [u8; 4] = d.get(off..off + 4).ok_or_else(not_squads)?.try_into().unwrap();
    Ok(u32::from_le_bytes(s))
}

pub struct VaultTxHeader {
    pub multisig: Pubkey,
    pub index: u64,
}

/// Squads VaultTransaction: discriminator, multisig (8..40), creator (40..72), index (72..80).
pub fn parse_vault_transaction(data: &[u8]) -> Result<VaultTxHeader> {
    require!(data.len() >= 80 && data[..8] == VAULT_TRANSACTION_DISCRIMINATOR, GuardError::NotSquadsAccount);
    Ok(VaultTxHeader { multisig: read_pubkey(data, 8)?, index: read_u64(data, 72)? })
}

/// Review PDA seed taken from raw vault transaction bytes during account validation.
/// Bad data yields zeros; the handler then rejects the account with NotSquadsAccount.
pub fn tx_index_seed_from(data: &[u8]) -> [u8; 8] {
    data.get(72..80).map(|s| s.try_into().unwrap()).unwrap_or([0u8; 8])
}

pub struct ProposalHeader {
    pub multisig: Pubkey,
    pub transaction_index: u64,
}

/// Squads Proposal: discriminator, multisig (8..40), transaction_index (40..48).
pub fn parse_proposal(data: &[u8]) -> Result<ProposalHeader> {
    require!(data.len() >= 48 && data[..8] == PROPOSAL_DISCRIMINATOR, GuardError::NotSquadsAccount);
    Ok(ProposalHeader { multisig: read_pubkey(data, 8)?, transaction_index: read_u64(data, 40)? })
}

pub struct MultisigInfo {
    pub config_authority: Pubkey,
    pub members: Vec<(Pubkey, u8)>,
}

/// Squads Multisig: create_key (8..40), config_authority (40..72), threshold u16, time_lock u32,
/// transaction_index u64, stale_transaction_index u64, rent_collector Option<Pubkey> (tag at 94),
/// bump u8, members Vec<{ key, mask u8 }>.
pub fn parse_multisig(data: &[u8]) -> Result<MultisigInfo> {
    require!(data.len() >= 96 && data[..8] == MULTISIG_DISCRIMINATOR, GuardError::NotSquadsAccount);
    let config_authority = read_pubkey(data, 40)?;
    let bump_at = match data[94] {
        0 => 95,
        1 => 127,
        _ => return err!(GuardError::NotSquadsAccount),
    };
    let mut off = bump_at + 1;
    let len = read_u32(data, off)? as usize;
    off += 4;
    let mut members = Vec::with_capacity(len.min(32));
    for _ in 0..len {
        let key = read_pubkey(data, off)?;
        let mask = *data.get(off + 32).ok_or_else(not_squads)?;
        members.push((key, mask));
        off += 33;
    }
    Ok(MultisigInfo { config_authority, members })
}

/// The firewall only holds if the guard's executor is the only member able to execute
/// and nobody can change members outside a (guarded) config transaction.
pub fn check_sole_executor(info: &MultisigInfo, executor: &Pubkey) -> Result<()> {
    require_keys_eq!(info.config_authority, Pubkey::default(), GuardError::InvalidMultisigConfig);
    let mut found = false;
    for (key, mask) in &info.members {
        if key == executor {
            require!(*mask == PERMISSION_EXECUTE, GuardError::InvalidMultisigConfig);
            found = true;
        } else {
            require!(mask & PERMISSION_EXECUTE == 0, GuardError::InvalidMultisigConfig);
        }
    }
    require!(found, GuardError::InvalidMultisigConfig);
    Ok(())
}

pub struct ReportPayload {
    pub verdict: u8,
    pub reason: u16,
    pub msg_hash: [u8; 32],
    pub intent_hash: [u8; 32],
    pub policy_hash: [u8; 32],
    pub expires_at: i64,
}

/// Fixed 107-byte little-endian layout, see packages/shared/src/report.ts.
pub fn decode_report(bytes: &[u8], now: i64) -> Result<ReportPayload> {
    require!(bytes.len() == REPORT_PAYLOAD_LEN, GuardError::InvalidPayload);
    let verdict = bytes[0];
    require!(verdict == VERDICT_APPROVE || verdict == VERDICT_REJECT, GuardError::InvalidPayload);
    let reason = u16::from_le_bytes([bytes[1], bytes[2]]);
    require!(reason <= MAX_REASON, GuardError::InvalidPayload);
    let expires_at = i64::from_le_bytes(bytes[99..107].try_into().unwrap());
    require!(expires_at > now, GuardError::InvalidPayload);
    Ok(ReportPayload {
        verdict,
        reason,
        msg_hash: bytes[3..35].try_into().unwrap(),
        intent_hash: bytes[35..67].try_into().unwrap(),
        policy_hash: bytes[67..99].try_into().unwrap(),
        expires_at,
    })
}

/// Keystone forwarder check: configured state, owned by the configured forwarder program,
/// authority = PDA ["forwarder", state, guard_id] under that program, and it signed.
pub fn verify_forwarder(
    state_key: &Pubkey,
    state_owner: &Pubkey,
    authority_key: &Pubkey,
    authority_is_signer: bool,
    config: &GuardConfig,
) -> Result<()> {
    require_keys_eq!(*state_key, config.forwarder_state, GuardError::InvalidForwarder);
    require_keys_eq!(*state_owner, config.forwarder_program, GuardError::InvalidForwarder);
    let (expected, _) =
        Pubkey::find_program_address(&[FORWARDER_SEED, state_key.as_ref(), crate::ID.as_ref()], &config.forwarder_program);
    require_keys_eq!(*authority_key, expected, GuardError::InvalidForwarder);
    require!(authority_is_signer, GuardError::InvalidForwarder);
    Ok(())
}

/// System program AdvanceNonceAccount (bincode u32 tag 4).
pub fn is_advance_nonce(program_id: &Pubkey, data: &[u8]) -> bool {
    *program_id == anchor_lang::solana_program::system_program::ID && data.len() >= 4 && data[..4] == [4, 0, 0, 0]
}

pub fn check_executable(status: ReviewStatus, expires_at: i64, now: i64) -> Result<()> {
    match status {
        ReviewStatus::Approved => {}
        ReviewStatus::Executed => return err!(GuardError::AlreadyExecuted),
        _ => return err!(GuardError::NotApproved),
    }
    require!(now < expires_at, GuardError::Expired);
    Ok(())
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test -p wysiwys_guard --lib`
Expected: all logic tests pass. Then `anchor build` succeeds (the program is still empty).

If `Pubkey::find_program_address` is unavailable on the host target, add `solana-pubkey = { version = "3", features = ["curve25519"] }` to `[dependencies]`.

- [ ] **Step 7: Checkpoint**

```bash
git add programs/wysiwys_guard
git commit -m "feat(guard): state, errors, events and pure check logic"
```

---

### Task 3: Squads desk test fixture

**Files:**
- Create: `tests/helpers/squads.ts`, `tests/squads_fixture.ts`

**Interfaces:**
- Consumes: guard program ID (Task 0), `SEEDS` (Task 1).
- Produces:
  - `SQUADS_PROGRAM_ID: PublicKey`, `USDC_DECIMALS = 6`, `usdc(n: number): bigint`
  - `type DeskOptions = { executor?: "execute-only" | "with-vote" | "absent"; humanExecute?: boolean; configAuthority?: PublicKey }`
  - `type DeskFixture = { createKey: Keypair; multisigPda: PublicKey; vaultPda: PublicKey; executorPda: PublicKey; members: Keypair[]; mint: PublicKey; vaultAta: PublicKey; counterparty: Keypair; counterpartyAta: PublicKey; lookalike: Keypair; lookalikeAta: PublicKey }`
  - `createDesk(connection: Connection, payer: Keypair, guardProgramId: PublicKey, opts?: DeskOptions): Promise<DeskFixture>`
  - `payoutIxs(desk: DeskFixture, destinationAta: PublicKey, amount: bigint): TransactionInstruction[]`
  - `driftStyleIxs(desk: DeskFixture, amount: bigint): TransactionInstruction[]`
  - `type Proposed = { transactionIndex: bigint; transactionPda: PublicKey; proposalPda: PublicKey }`
  - `proposePayout(connection: Connection, desk: DeskFixture, ixs: TransactionInstruction[]): Promise<Proposed>`
  - `approve(connection: Connection, desk: DeskFixture, transactionIndex: bigint, count?: number): Promise<void>`
  - `executeRemainingAccounts(connection: Connection, desk: DeskFixture, transactionIndex: bigint): Promise<AccountMeta[]>`
  - `confirm(connection: Connection, sig: Promise<string> | string): Promise<string>`

- [ ] **Step 1: Write the fixture**

`tests/helpers/squads.ts`:

```ts
import * as multisig from "@sqds/multisig";
import {
  AccountMeta, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
  TransactionInstruction, TransactionMessage,
} from "@solana/web3.js";
import {
  AuthorityType, createMint, createSetAuthorityInstruction, createTransferCheckedInstruction,
  getOrCreateAssociatedTokenAccount, mintTo,
} from "@solana/spl-token";
import { SEEDS } from "@wysiwys/shared";

export const SQUADS_PROGRAM_ID = new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
export const USDC_DECIMALS = 6;
export const usdc = (n: number) => BigInt(n) * 10n ** BigInt(USDC_DECIMALS);

const { Permission, Permissions } = multisig.types;

export type DeskOptions = {
  executor?: "execute-only" | "with-vote" | "absent";
  humanExecute?: boolean;
  configAuthority?: PublicKey;
};

export type DeskFixture = {
  createKey: Keypair;
  multisigPda: PublicKey;
  vaultPda: PublicKey;
  executorPda: PublicKey;
  members: Keypair[];
  mint: PublicKey;
  vaultAta: PublicKey;
  counterparty: Keypair;
  counterpartyAta: PublicKey;
  lookalike: Keypair;
  lookalikeAta: PublicKey;
};

export type Proposed = { transactionIndex: bigint; transactionPda: PublicKey; proposalPda: PublicKey };

export async function confirm(connection: Connection, sig: Promise<string> | string): Promise<string> {
  const s = await sig;
  await connection.confirmTransaction(s, "confirmed");
  return s;
}

async function airdrop(connection: Connection, to: PublicKey, sol: number) {
  await confirm(connection, connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL));
}

export async function createDesk(
  connection: Connection,
  payer: Keypair,
  guardProgramId: PublicKey,
  opts: DeskOptions = {},
): Promise<DeskFixture> {
  const createKey = Keypair.generate();
  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const [executorPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.executor), multisigPda.toBuffer()],
    guardProgramId,
  );
  const members = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  await Promise.all(members.map((m) => airdrop(connection, m.publicKey, 2)));

  const humanPerms = opts.humanExecute
    ? Permissions.fromPermissions([Permission.Initiate, Permission.Vote, Permission.Execute])
    : Permissions.fromPermissions([Permission.Initiate, Permission.Vote]);
  const squadMembers = members.map((m, i) => ({
    key: m.publicKey,
    permissions: i === 0 ? humanPerms : Permissions.fromPermissions([Permission.Initiate, Permission.Vote]),
  }));
  const executorMode = opts.executor ?? "execute-only";
  if (executorMode !== "absent") {
    squadMembers.push({
      key: executorPda,
      permissions:
        executorMode === "execute-only"
          ? Permissions.fromPermissions([Permission.Execute])
          : Permissions.fromPermissions([Permission.Vote, Permission.Execute]),
    });
  }

  const [programConfigPda] = multisig.getProgramConfigPda({});
  const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(connection, programConfigPda);
  await confirm(
    connection,
    multisig.rpc.multisigCreateV2({
      connection,
      treasury: programConfig.treasury,
      createKey,
      creator: payer,
      multisigPda,
      configAuthority: opts.configAuthority ?? null,
      threshold: 3,
      members: squadMembers,
      timeLock: 0,
      rentCollector: null,
    }),
  );

  const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });
  await airdrop(connection, vaultPda, 1);
  const mint = await createMint(connection, payer, payer.publicKey, null, USDC_DECIMALS);
  const vaultAta = (await getOrCreateAssociatedTokenAccount(connection, payer, mint, vaultPda, true)).address;
  await mintTo(connection, payer, mint, vaultAta, payer, usdc(2_000_000));

  const counterparty = Keypair.generate();
  const counterpartyAta = (await getOrCreateAssociatedTokenAccount(connection, payer, mint, counterparty.publicKey)).address;
  const lookalike = Keypair.generate();
  const lookalikeAta = (await getOrCreateAssociatedTokenAccount(connection, payer, mint, lookalike.publicKey)).address;

  return { createKey, multisigPda, vaultPda, executorPda, members, mint, vaultAta, counterparty, counterpartyAta, lookalike, lookalikeAta };
}

export function payoutIxs(desk: DeskFixture, destinationAta: PublicKey, amount: bigint): TransactionInstruction[] {
  return [createTransferCheckedInstruction(desk.vaultAta, desk.mint, destinationAta, desk.vaultPda, amount, USDC_DECIMALS)];
}

/** Payout with a hidden authority takeover and nonce advance (Drift-style). Never executed. */
export function driftStyleIxs(desk: DeskFixture, amount: bigint): TransactionInstruction[] {
  const attacker = Keypair.generate().publicKey;
  return [
    ...payoutIxs(desk, desk.counterpartyAta, amount),
    createSetAuthorityInstruction(desk.vaultAta, desk.vaultPda, AuthorityType.AccountOwner, attacker),
    SystemProgram.nonceAdvance({ noncePubkey: Keypair.generate().publicKey, authorizedPubkey: desk.vaultPda }),
  ];
}

export async function proposePayout(connection: Connection, desk: DeskFixture, ixs: TransactionInstruction[]): Promise<Proposed> {
  const proposer = desk.members[0];
  const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, desk.multisigPda, "confirmed");
  const transactionIndex = BigInt(ms.transactionIndex.toString()) + 1n;
  const { blockhash } = await connection.getLatestBlockhash();
  const transactionMessage = new TransactionMessage({ payerKey: desk.vaultPda, recentBlockhash: blockhash, instructions: ixs });
  await confirm(
    connection,
    multisig.rpc.vaultTransactionCreate({
      connection, feePayer: proposer, multisigPda: desk.multisigPda, transactionIndex,
      creator: proposer.publicKey, vaultIndex: 0, ephemeralSigners: 0, transactionMessage,
    }),
  );
  await confirm(
    connection,
    multisig.rpc.proposalCreate({ connection, feePayer: proposer, creator: proposer, multisigPda: desk.multisigPda, transactionIndex }),
  );
  const [transactionPda] = multisig.getTransactionPda({ multisigPda: desk.multisigPda, index: transactionIndex });
  const [proposalPda] = multisig.getProposalPda({ multisigPda: desk.multisigPda, transactionIndex });
  return { transactionIndex, transactionPda, proposalPda };
}

export async function approve(connection: Connection, desk: DeskFixture, transactionIndex: bigint, count = 3) {
  for (const member of desk.members.slice(0, count)) {
    await confirm(
      connection,
      multisig.rpc.proposalApprove({ connection, feePayer: member, member, multisigPda: desk.multisigPda, transactionIndex }),
    );
  }
}

/** Message accounts Squads expects after [multisig, proposal, transaction, member]. */
export async function executeRemainingAccounts(
  connection: Connection,
  desk: DeskFixture,
  transactionIndex: bigint,
): Promise<AccountMeta[]> {
  const { instruction } = await multisig.instructions.vaultTransactionExecute({
    connection, multisigPda: desk.multisigPda, transactionIndex, member: desk.executorPda,
  });
  return instruction.keys.slice(4);
}
```

- [ ] **Step 2: Write the fixture test**

`tests/squads_fixture.ts`:

```ts
import * as anchor from "@anchor-lang/core";
import * as multisig from "@sqds/multisig";
import { Keypair } from "@solana/web3.js";
import { expect } from "chai";
import { approve, createDesk, payoutIxs, proposePayout, usdc } from "./helpers/squads";

describe("squads desk fixture", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const payer = (provider.wallet as anchor.Wallet).payer as Keypair;
  const guardId = (anchor.workspace.wysiwysGuard as anchor.Program).programId;

  it("creates an Active payout proposal", async () => {
    const desk = await createDesk(provider.connection, payer, guardId);
    const p = await proposePayout(provider.connection, desk, payoutIxs(desk, desk.counterpartyAta, usdc(500_000)));
    const proposal = await multisig.accounts.Proposal.fromAccountAddress(provider.connection, p.proposalPda, "confirmed");
    expect(proposal.status.__kind).to.equal("Active");
  });

  it("a human member cannot execute even after 3 of 3", async () => {
    const desk = await createDesk(provider.connection, payer, guardId);
    const p = await proposePayout(provider.connection, desk, payoutIxs(desk, desk.counterpartyAta, usdc(1)));
    await approve(provider.connection, desk, p.transactionIndex);
    const human = desk.members[0];
    let failed = false;
    try {
      await multisig.rpc.vaultTransactionExecute({
        connection: provider.connection, feePayer: human, multisigPda: desk.multisigPda,
        transactionIndex: p.transactionIndex, member: human.publicKey,
      });
    } catch (e) {
      failed = String(e).includes("Unauthorized") || JSON.stringify((e as any).logs ?? []).includes("Unauthorized");
    }
    expect(failed).to.equal(true);
  });
});
```

- [ ] **Step 3: Run it**

Run: `anchor test`
Expected: smoke + 2 fixture tests pass. If the second test fails because the error text differs, print the error and match the Squads `Unauthorized` code from the logs instead; do not weaken the assertion to "any error".

- [ ] **Step 4: Checkpoint**

```bash
git add tests/helpers/squads.ts tests/squads_fixture.ts
git commit -m "test: squads desk fixture"
```

---

### Task 4: `initialize_guard`

**Files:**
- Create: `programs/wysiwys_guard/src/instructions/mod.rs`, `programs/wysiwys_guard/src/instructions/initialize_guard.rs`, `tests/helpers/guard.ts`, `tests/initialize_guard.ts`
- Modify: `programs/wysiwys_guard/src/lib.rs`

**Interfaces:**
- Consumes: `logic::parse_multisig`, `logic::check_sole_executor`, `GuardConfig`, `createDesk`.
- Produces:
  - Instruction `initialize_guard(forwarder_program: Pubkey, forwarder_state: Pubkey, policy_hash: [u8; 32])`, accounts `multisig, create_key (signer), config (init), executor, payer (signer, mut), system_program`.
  - TS helpers in `tests/helpers/guard.ts`: `guardProgram()`, `configPda(multisig)`, `reviewPda(multisig, txIndex)`, `executorPda(multisig)`, `POLICY_HASH: Uint8Array`, `randomHash(): Uint8Array`, `expectError(p, ...names)`, `chainNow(connection): Promise<bigint>`, `guardEvents(sig): Promise<{ name: string; data: any }[]>`, `statusOf(review): string`, `type GuardedDesk = DeskFixture & { config: PublicKey }`, `setupGuardedDesk(opts?: { forwarderProgram?: PublicKey; forwarderState?: PublicKey; desk?: DeskOptions }): Promise<GuardedDesk>`.

- [ ] **Step 1: Write the TS helpers**

`tests/helpers/guard.ts`:

```ts
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { expect } from "chai";
import { SEEDS, txIndexSeed } from "@wysiwys/shared";
import type { WysiwysGuard } from "../../target/types/wysiwys_guard";
import { createDesk, DeskFixture, DeskOptions } from "./squads";

export const provider = () => anchor.getProvider() as anchor.AnchorProvider;
export const payer = () => (provider().wallet as anchor.Wallet).payer as Keypair;
export const guardProgram = () => anchor.workspace.wysiwysGuard as Program<WysiwysGuard>;

export const POLICY_HASH = new Uint8Array(32).fill(7);
export const randomHash = () => crypto.getRandomValues(new Uint8Array(32));

export const configPda = (multisig: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from(SEEDS.config), multisig.toBuffer()], guardProgram().programId)[0];
export const reviewPda = (multisig: PublicKey, txIndex: bigint) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.review), multisig.toBuffer(), Buffer.from(txIndexSeed(txIndex))],
    guardProgram().programId,
  )[0];
export const executorPda = (multisig: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from(SEEDS.executor), multisig.toBuffer()], guardProgram().programId)[0];

export async function expectError(p: Promise<unknown>, ...names: string[]) {
  let err: any;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  if (!err) expect.fail(`expected failure with one of: ${names.join(", ")}`);
  const text = [String(err), JSON.stringify(err.logs ?? err.transactionLogs ?? []), err.error?.errorCode?.code ?? ""].join("\n");
  expect(names.some((n) => text.includes(n)), `expected ${names.join("|")}, got:\n${text}`).to.equal(true);
}

/** Validator clock (unix_timestamp is at offset 32 of the Clock sysvar). */
export async function chainNow(connection: Connection): Promise<bigint> {
  const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed");
  return info!.data.readBigInt64LE(32);
}

export async function guardEvents(sig: string): Promise<{ name: string; data: any }[]> {
  const program = guardProgram();
  const tx = await program.provider.connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const parser = new anchor.EventParser(program.programId, new anchor.BorshCoder(program.idl));
  return [...parser.parseLogs(tx!.meta!.logMessages!)];
}

export const statusOf = (review: { status: object }) => Object.keys(review.status)[0];

export type GuardedDesk = DeskFixture & { config: PublicKey };

export async function setupGuardedDesk(
  opts: { forwarderProgram?: PublicKey; forwarderState?: PublicKey; desk?: DeskOptions } = {},
): Promise<GuardedDesk> {
  const desk = await createDesk(provider().connection, payer(), guardProgram().programId, opts.desk);
  const config = configPda(desk.multisigPda);
  await guardProgram()
    .methods.initializeGuard(
      opts.forwarderProgram ?? Keypair.generate().publicKey,
      opts.forwarderState ?? Keypair.generate().publicKey,
      Array.from(POLICY_HASH),
    )
    .accountsPartial({
      multisig: desk.multisigPda,
      createKey: desk.createKey.publicKey,
      config,
      executor: desk.executorPda,
      payer: payer().publicKey,
    })
    .signers([desk.createKey])
    .rpc({ commitment: "confirmed" });
  return { ...desk, config };
}
```

- [ ] **Step 2: Write the failing tests**

`tests/initialize_guard.ts`:

```ts
import * as anchor from "@anchor-lang/core";
import { Keypair } from "@solana/web3.js";
import { expect } from "chai";
import { createDesk } from "./helpers/squads";
import { POLICY_HASH, configPda, executorPda, expectError, guardProgram, payer, setupGuardedDesk } from "./helpers/guard";

describe("initialize_guard", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = guardProgram();

  const init = (multisig: anchor.web3.PublicKey, createKey: Keypair) =>
    program.methods
      .initializeGuard(Keypair.generate().publicKey, Keypair.generate().publicKey, Array.from(POLICY_HASH))
      .accountsPartial({ multisig, createKey: createKey.publicKey, config: configPda(multisig), executor: executorPda(multisig), payer: payer().publicKey })
      .signers([createKey])
      .rpc();

  it("stores forwarder, policy hash and bumps", async () => {
    const forwarderProgram = Keypair.generate().publicKey;
    const forwarderState = Keypair.generate().publicKey;
    const desk = await setupGuardedDesk({ forwarderProgram, forwarderState });
    const cfg = await program.account.guardConfig.fetch(desk.config);
    expect(cfg.multisig.toBase58()).to.equal(desk.multisigPda.toBase58());
    expect(cfg.forwarderProgram.toBase58()).to.equal(forwarderProgram.toBase58());
    expect(cfg.forwarderState.toBase58()).to.equal(forwarderState.toBase58());
    expect(Buffer.from(cfg.policyHash).equals(Buffer.from(POLICY_HASH))).to.equal(true);
    expect(executorPda(desk.multisigPda).toBase58()).to.equal(desk.executorPda.toBase58());
  });

  it("rejects a second initialization for the same multisig", async () => {
    const desk = await setupGuardedDesk();
    await expectError(init(desk.multisigPda, desk.createKey), "already in use");
  });

  it("rejects an account not owned by Squads", async () => {
    const fake = Keypair.generate();
    await expectError(init(payer().publicKey, fake), "NotSquadsAccount");
  });

  it("rejects a create_key that did not create the multisig", async () => {
    const desk = await createDesk(program.provider.connection, payer(), program.programId);
    await expectError(init(desk.multisigPda, Keypair.generate()), "WrongMultisig");
  });

  it("rejects a multisig where a human can execute", async () => {
    const desk = await createDesk(program.provider.connection, payer(), program.programId, { humanExecute: true });
    await expectError(init(desk.multisigPda, desk.createKey), "InvalidMultisigConfig");
  });

  it("rejects a multisig without the executor", async () => {
    const desk = await createDesk(program.provider.connection, payer(), program.programId, { executor: "absent" });
    await expectError(init(desk.multisigPda, desk.createKey), "InvalidMultisigConfig");
  });

  it("rejects an executor that can also vote", async () => {
    const desk = await createDesk(program.provider.connection, payer(), program.programId, { executor: "with-vote" });
    await expectError(init(desk.multisigPda, desk.createKey), "InvalidMultisigConfig");
  });

  it("rejects a controlled multisig (config authority set)", async () => {
    const desk = await createDesk(program.provider.connection, payer(), program.programId, { configAuthority: payer().publicKey });
    await expectError(init(desk.multisigPda, desk.createKey), "InvalidMultisigConfig");
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `anchor test`
Expected: FAIL, `program.methods.initializeGuard is not a function` (or TS type errors are ignored by tsx and the call fails at runtime).

- [ ] **Step 4: Implement the instruction**

`src/instructions/mod.rs`:

```rust
pub mod initialize_guard;

pub use initialize_guard::*;
```

`src/instructions/initialize_guard.rs`:

```rust
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::GuardError;
use crate::logic;
use crate::state::GuardConfig;

#[derive(Accounts)]
pub struct InitializeGuard<'info> {
    /// CHECK: Squads multisig. Owner checked here; discriminator, PDA and members in the handler.
    #[account(owner = SQUADS_PROGRAM_ID @ GuardError::NotSquadsAccount)]
    pub multisig: UncheckedAccount<'info>,
    /// The Squads create_key. Signing proves the caller created this multisig (no front-running).
    pub create_key: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + GuardConfig::INIT_SPACE,
        seeds = [CONFIG_SEED, multisig.key().as_ref()],
        bump
    )]
    pub config: Account<'info, GuardConfig>,
    /// CHECK: PDA signer for the Squads execute CPI. Holds no data.
    #[account(seeds = [EXECUTOR_SEED, multisig.key().as_ref()], bump)]
    pub executor: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_guard(
    ctx: Context<InitializeGuard>,
    forwarder_program: Pubkey,
    forwarder_state: Pubkey,
    policy_hash: [u8; 32],
) -> Result<()> {
    let multisig = ctx.accounts.multisig.key();
    let (expected, _) = Pubkey::find_program_address(
        &[b"multisig", b"multisig", ctx.accounts.create_key.key().as_ref()],
        &SQUADS_PROGRAM_ID,
    );
    require_keys_eq!(expected, multisig, GuardError::WrongMultisig);

    let info = logic::parse_multisig(&ctx.accounts.multisig.try_borrow_data()?)?;
    logic::check_sole_executor(&info, &ctx.accounts.executor.key())?;

    let config = &mut ctx.accounts.config;
    config.multisig = multisig;
    config.forwarder_program = forwarder_program;
    config.forwarder_state = forwarder_state;
    config.policy_hash = policy_hash;
    config.bump = ctx.bumps.config;
    config.executor_bump = ctx.bumps.executor;
    Ok(())
}
```

`src/lib.rs`: add `pub mod instructions;` and `pub use instructions::*;`, and replace the program module with:

```rust
#[program]
pub mod wysiwys_guard {
    use super::*;

    pub fn initialize_guard(
        ctx: Context<InitializeGuard>,
        forwarder_program: Pubkey,
        forwarder_state: Pubkey,
        policy_hash: [u8; 32],
    ) -> Result<()> {
        instructions::initialize_guard::handle_initialize_guard(ctx, forwarder_program, forwarder_state, policy_hash)
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p wysiwys_guard --lib && anchor test`
Expected: all pass (smoke, fixture, 8 initialize tests).

- [ ] **Step 6: Checkpoint**

```bash
git add programs/wysiwys_guard tests
git commit -m "feat(guard): initialize_guard with sole-executor check"
```

---

### Task 5: `request_review`

**Files:**
- Create: `programs/wysiwys_guard/src/instructions/request_review.rs`, `tests/request_review.ts`
- Modify: `programs/wysiwys_guard/src/instructions/mod.rs`, `programs/wysiwys_guard/src/lib.rs`, `tests/helpers/guard.ts`

**Interfaces:**
- Consumes: `logic::{parse_vault_transaction, parse_proposal, tx_index_seed_from, sha256}`, `Review`, `ReviewRequested`.
- Produces:
  - Instruction `request_review(settlement_intent_hash: [u8; 32], trade_ref_hash: [u8; 32])`, accounts `multisig, vault_transaction, proposal, review (init), payer, system_program`.
  - TS helper `requestReview(desk: DeskFixture, p: Proposed, hashes?: { sih?: Uint8Array; trh?: Uint8Array }): Promise<{ review: PublicKey; sig: string; sih: Uint8Array; trh: Uint8Array }>` in `tests/helpers/guard.ts`.

- [ ] **Step 1: Add the TS helper**

Append to `tests/helpers/guard.ts`:

```ts
import type { Proposed } from "./squads";

export async function requestReview(
  desk: DeskFixture,
  p: Proposed,
  hashes: { sih?: Uint8Array; trh?: Uint8Array } = {},
) {
  const sih = hashes.sih ?? randomHash();
  const trh = hashes.trh ?? randomHash();
  const review = reviewPda(desk.multisigPda, p.transactionIndex);
  const sig = await guardProgram()
    .methods.requestReview(Array.from(sih), Array.from(trh))
    .accountsPartial({
      multisig: desk.multisigPda,
      vaultTransaction: p.transactionPda,
      proposal: p.proposalPda,
      review,
      payer: payer().publicKey,
    })
    .rpc({ commitment: "confirmed" });
  return { review, sig, sih, trh };
}
```

(Move the `import type { Proposed }` line to the top of the file with the other imports.)

- [ ] **Step 2: Write the failing tests**

`tests/request_review.ts`:

```ts
import * as anchor from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";
import { expect } from "chai";
import { createDesk, payoutIxs, proposePayout, usdc, DeskFixture } from "./helpers/squads";
import { expectError, guardEvents, guardProgram, payer, requestReview, reviewPda, statusOf, randomHash } from "./helpers/guard";

describe("request_review", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = guardProgram();
  const connection = program.provider.connection;
  let desk: DeskFixture;

  before(async () => {
    desk = await createDesk(connection, payer(), program.programId);
  });

  const propose = () => proposePayout(connection, desk, payoutIxs(desk, desk.counterpartyAta, usdc(500_000)));

  /** Review PDA the program derives from raw bytes 72..80 of whatever is passed as vault_transaction. */
  async function derivedReviewFor(multisig: PublicKey, account: PublicKey) {
    const data = (await connection.getAccountInfo(account))?.data ?? Buffer.alloc(0);
    const idx = data.length >= 80 ? data.readBigUInt64LE(72) : 0n;
    return reviewPda(multisig, idx);
  }

  const rawRequest = (multisig: PublicKey, vaultTransaction: PublicKey, proposal: PublicKey, review: PublicKey) =>
    program.methods
      .requestReview(Array.from(randomHash()), Array.from(randomHash()))
      .accountsPartial({ multisig, vaultTransaction, proposal, review, payer: payer().publicKey })
      .rpc();

  it("creates a Pending review with msg_hash computed on-chain", async () => {
    const p = await propose();
    const { review, sih, trh } = await requestReview(desk, p);
    const r = await program.account.review.fetch(review);
    const vtData = (await connection.getAccountInfo(p.transactionPda))!.data;
    expect(Buffer.from(r.msgHash).toString("hex")).to.equal(Buffer.from(sha256(vtData)).toString("hex"));
    expect(Buffer.from(r.settlementIntentHash).equals(Buffer.from(sih))).to.equal(true);
    expect(Buffer.from(r.tradeRefHash).equals(Buffer.from(trh))).to.equal(true);
    expect(r.vaultTransaction.toBase58()).to.equal(p.transactionPda.toBase58());
    expect(r.proposal.toBase58()).to.equal(p.proposalPda.toBase58());
    expect(r.multisig.toBase58()).to.equal(desk.multisigPda.toBase58());
    expect(BigInt(r.txIndex.toString())).to.equal(p.transactionIndex);
    expect(statusOf(r)).to.equal("pending");
    expect(r.createdAt.toNumber()).to.be.greaterThan(0);
  });

  it("emits ReviewRequested with the stored fields", async () => {
    const p = await propose();
    const { review, sig, sih } = await requestReview(desk, p);
    const ev = (await guardEvents(sig)).find((e) => e.name === "reviewRequested");
    expect(ev, "ReviewRequested event").to.not.equal(undefined);
    expect(ev!.data.review.toBase58()).to.equal(review.toBase58());
    expect(ev!.data.multisig.toBase58()).to.equal(desk.multisigPda.toBase58());
    expect(BigInt(ev!.data.txIndex.toString())).to.equal(p.transactionIndex);
    expect(Buffer.from(ev!.data.settlementIntentHash).equals(Buffer.from(sih))).to.equal(true);
  });

  it("rejects a second review for the same tx index", async () => {
    const p = await propose();
    await requestReview(desk, p);
    await expectError(requestReview(desk, p), "already in use");
  });

  it("rejects a vault_transaction not owned by Squads", async () => {
    const p = await propose();
    const fake = payer().publicKey;
    await expectError(
      rawRequest(desk.multisigPda, fake, p.proposalPda, await derivedReviewFor(desk.multisigPda, fake)),
      "NotSquadsAccount",
    );
  });

  it("rejects a Squads Proposal passed as the vault transaction", async () => {
    const p = await propose();
    await expectError(
      rawRequest(desk.multisigPda, p.proposalPda, p.proposalPda, await derivedReviewFor(desk.multisigPda, p.proposalPda)),
      "NotSquadsAccount",
    );
  });

  it("rejects a vault transaction from another multisig", async () => {
    const other = await createDesk(connection, payer(), program.programId);
    const theirs = await proposePayout(connection, other, payoutIxs(other, other.counterpartyAta, usdc(1)));
    await expectError(
      rawRequest(desk.multisigPda, theirs.transactionPda, theirs.proposalPda, reviewPda(desk.multisigPda, theirs.transactionIndex)),
      "WrongMultisig",
    );
  });

  it("rejects a proposal for a different tx index", async () => {
    const a = await propose();
    const b = await propose();
    await expectError(
      rawRequest(desk.multisigPda, a.transactionPda, b.proposalPda, reviewPda(desk.multisigPda, a.transactionIndex)),
      "WrongTxIndex",
    );
  });

  it("works for many sequential tx indexes (Demo mode reruns)", async () => {
    const reviews = [];
    for (let i = 0; i < 3; i++) reviews.push((await requestReview(desk, await propose())).review.toBase58());
    expect(new Set(reviews).size).to.equal(3);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `anchor test`
Expected: FAIL, `requestReview is not a function`.

- [ ] **Step 4: Implement the instruction**

`src/instructions/request_review.rs`:

```rust
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::GuardError;
use crate::events::ReviewRequested;
use crate::logic;
use crate::state::{Review, ReviewStatus};

/// Review PDA seed from the raw vault transaction bytes; validated in the handler.
fn tx_index_seed(account: &AccountInfo) -> [u8; 8] {
    account.try_borrow_data().map(|d| logic::tx_index_seed_from(&d)).unwrap_or([0u8; 8])
}

#[derive(Accounts)]
pub struct RequestReview<'info> {
    /// CHECK: Squads multisig. The vault transaction and proposal must name it.
    #[account(owner = SQUADS_PROGRAM_ID @ GuardError::NotSquadsAccount)]
    pub multisig: UncheckedAccount<'info>,
    /// CHECK: Squads VaultTransaction. Owner here; discriminator, multisig and index in the handler.
    #[account(owner = SQUADS_PROGRAM_ID @ GuardError::NotSquadsAccount)]
    pub vault_transaction: UncheckedAccount<'info>,
    /// CHECK: Squads Proposal. Owner here; discriminator, multisig and index in the handler.
    #[account(owner = SQUADS_PROGRAM_ID @ GuardError::NotSquadsAccount)]
    pub proposal: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Review::INIT_SPACE,
        seeds = [REVIEW_SEED, multisig.key().as_ref(), &tx_index_seed(&vault_transaction)],
        bump
    )]
    pub review: Account<'info, Review>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_request_review(
    ctx: Context<RequestReview>,
    settlement_intent_hash: [u8; 32],
    trade_ref_hash: [u8; 32],
) -> Result<()> {
    let multisig = ctx.accounts.multisig.key();
    let (vault_tx, msg_hash) = {
        let data = ctx.accounts.vault_transaction.try_borrow_data()?;
        (logic::parse_vault_transaction(&data)?, logic::sha256(&data))
    };
    require_keys_eq!(vault_tx.multisig, multisig, GuardError::WrongMultisig);
    let proposal = logic::parse_proposal(&ctx.accounts.proposal.try_borrow_data()?)?;
    require_keys_eq!(proposal.multisig, multisig, GuardError::WrongMultisig);
    require!(proposal.transaction_index == vault_tx.index, GuardError::WrongTxIndex);

    let vault_transaction = ctx.accounts.vault_transaction.key();
    let proposal_key = ctx.accounts.proposal.key();
    let review = &mut ctx.accounts.review;
    review.version = REVIEW_VERSION;
    review.multisig = multisig;
    review.vault_transaction = vault_transaction;
    review.proposal = proposal_key;
    review.tx_index = vault_tx.index;
    review.msg_hash = msg_hash;
    review.settlement_intent_hash = settlement_intent_hash;
    review.trade_ref_hash = trade_ref_hash;
    review.status = ReviewStatus::Pending;
    review.reason = 0;
    review.policy_hash = [0u8; 32];
    review.expires_at = 0;
    review.created_at = Clock::get()?.unix_timestamp;
    review.bump = ctx.bumps.review;

    emit!(ReviewRequested {
        review: review.key(),
        multisig,
        tx_index: vault_tx.index,
        msg_hash,
        settlement_intent_hash,
        trade_ref_hash,
    });
    Ok(())
}
```

In `src/instructions/mod.rs` add `pub mod request_review;` and `pub use request_review::*;`. In the `#[program]` module add:

```rust
    pub fn request_review(
        ctx: Context<RequestReview>,
        settlement_intent_hash: [u8; 32],
        trade_ref_hash: [u8; 32],
    ) -> Result<()> {
        instructions::request_review::handle_request_review(ctx, settlement_intent_hash, trade_ref_hash)
    }
```

If Anchor rejects the function call inside `seeds` (IDL seed parsing), keep the seeds and pass `review` explicitly from clients (the helpers already do). Record what happened in `docs/spikes.md`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `anchor test`
Expected: all request_review tests pass, earlier tests still pass.

- [ ] **Step 6: Checkpoint**

```bash
git add programs/wysiwys_guard tests
git commit -m "feat(guard): request_review"
```

---

### Task 6: Test forwarder and `on_report`

**Files:**
- Create: `programs/test_forwarder/Cargo.toml`, `programs/test_forwarder/src/lib.rs`, `programs/wysiwys_guard/src/instructions/on_report.rs`, `tests/helpers/forwarder.ts`, `tests/on_report.ts`
- Modify: `Anchor.toml`, `programs/wysiwys_guard/src/instructions/mod.rs`, `programs/wysiwys_guard/src/lib.rs`

**Interfaces:**
- Consumes: `logic::{verify_forwarder, decode_report, intent_hash}`, `setupGuardedDesk`, `requestReview`, `encodeReportPayload`, `intentHash`.
- Produces:
  - Instruction `on_report(metadata: Vec<u8>, report: Vec<u8>)`, accounts `forwarder_state, forwarder_authority, config, review (mut)`.
  - Test program `test_forwarder` with `init_state()` and `forward(seed_program: Pubkey, metadata: Vec<u8>, report: Vec<u8>)`.
  - TS in `tests/helpers/forwarder.ts`: `forwarderProgram()`, `createForwarderState(): Promise<PublicKey>`, `forwarderAuthority(state, seedProgram?)`, `approvePayload(review: PublicKey, overrides?: Partial<ReportPayload>): Promise<Uint8Array>`, `deliverReport(review: PublicKey, payload: Uint8Array, opts?: { state?: PublicKey; seedProgram?: PublicKey }): Promise<string>`, `type ForwardedDesk = GuardedDesk & { forwarderState: PublicKey }`, `setupForwardedDesk(): Promise<ForwardedDesk>`.

- [ ] **Step 1: Create the test forwarder program**

`programs/test_forwarder/Cargo.toml`: copy `programs/wysiwys_guard/Cargo.toml`, set `name = "test_forwarder"` in `[package]` and `[lib]`, `description = "Local-test stand-in for the Keystone forwarder CPI. Never deployed."`, and keep only `anchor-lang = "1.2.0"` under `[dependencies]`.

`programs/test_forwarder/src/lib.rs`:

```rust
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

declare_id!("<TEST_FORWARDER_ID from anchor keys sync>");

/// Anchor discriminator of global:on_report, as used by the Keystone and mock forwarders.
const ON_REPORT_DISCRIMINATOR: [u8; 8] = [214, 173, 18, 221, 173, 148, 151, 208];

/// Local-test stand-in for the Keystone forwarder: same CPI shape, same authority PDA scheme.
/// `seed_program` lets tests sign an authority derived for the wrong receiver.
#[program]
pub mod test_forwarder {
    use super::*;

    pub fn init_state(_ctx: Context<InitState>) -> Result<()> {
        Ok(())
    }

    pub fn forward(ctx: Context<Forward>, seed_program: Pubkey, metadata: Vec<u8>, report: Vec<u8>) -> Result<()> {
        let state = ctx.accounts.state.key();
        let (authority, bump) =
            Pubkey::find_program_address(&[b"forwarder", state.as_ref(), seed_program.as_ref()], &crate::ID);
        require_keys_eq!(authority, ctx.accounts.authority.key());

        let mut data = ON_REPORT_DISCRIMINATOR.to_vec();
        metadata.serialize(&mut data)?;
        report.serialize(&mut data)?;

        let mut metas = vec![AccountMeta::new_readonly(state, false), AccountMeta::new_readonly(authority, true)];
        let mut infos = vec![ctx.accounts.state.to_account_info(), ctx.accounts.authority.to_account_info()];
        for acc in ctx.remaining_accounts.iter() {
            metas.push(AccountMeta { pubkey: *acc.key, is_signer: false, is_writable: acc.is_writable });
            infos.push(acc.clone());
        }
        infos.push(ctx.accounts.receiver_program.to_account_info());

        let ix = Instruction { program_id: ctx.accounts.receiver_program.key(), accounts: metas, data };
        invoke_signed(&ix, &infos, &[&[b"forwarder", state.as_ref(), seed_program.as_ref(), &[bump]]])?;
        Ok(())
    }
}

#[account]
pub struct ForwarderState {
    pub reserved: u8,
}

#[derive(Accounts)]
pub struct InitState<'info> {
    #[account(init, payer = payer, space = 8 + 1)]
    pub state: Account<'info, ForwarderState>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Forward<'info> {
    /// CHECK: any forwarder state; the receiver verifies it.
    pub state: UncheckedAccount<'info>,
    /// CHECK: PDA signed by this program.
    pub authority: UncheckedAccount<'info>,
    /// CHECK: receiver program.
    pub receiver_program: UncheckedAccount<'info>,
}
```

Run: `anchor build && anchor keys sync`. Ensure `test_forwarder` appears only under `[programs.localnet]` in `Anchor.toml` (delete it from `[programs.devnet]` if `keys sync` added it). Rebuild.

- [ ] **Step 2: Write the forwarder helpers**

`tests/helpers/forwarder.ts`:

```ts
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { ReportPayload, SEEDS, VERDICT, encodeReportPayload, intentHash } from "@wysiwys/shared";
import type { TestForwarder } from "../../target/types/test_forwarder";
import { GuardedDesk, POLICY_HASH, chainNow, guardProgram, payer, setupGuardedDesk } from "./guard";

export const forwarderProgram = () => anchor.workspace.testForwarder as Program<TestForwarder>;

export async function createForwarderState(): Promise<PublicKey> {
  const state = Keypair.generate();
  await forwarderProgram()
    .methods.initState()
    .accountsPartial({ state: state.publicKey, payer: payer().publicKey })
    .signers([state])
    .rpc({ commitment: "confirmed" });
  return state.publicKey;
}

export const forwarderAuthority = (state: PublicKey, seedProgram = guardProgram().programId) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.forwarder), state.toBuffer(), seedProgram.toBuffer()],
    forwarderProgram().programId,
  )[0];

export type ForwardedDesk = GuardedDesk & { forwarderState: PublicKey };

export async function setupForwardedDesk(): Promise<ForwardedDesk> {
  const forwarderState = await createForwarderState();
  const desk = await setupGuardedDesk({ forwarderProgram: forwarderProgram().programId, forwarderState });
  return { ...desk, forwarderState };
}

/** Approve payload that echoes the Review's stored hashes, valid for 10 minutes. */
export async function approvePayload(review: PublicKey, overrides: Partial<ReportPayload> = {}): Promise<Uint8Array> {
  const r = await guardProgram().account.review.fetch(review, "confirmed");
  const now = await chainNow(guardProgram().provider.connection);
  return encodeReportPayload({
    verdict: VERDICT.APPROVE,
    reason: 0,
    msgHash: Uint8Array.from(r.msgHash),
    intentHash: intentHash(Uint8Array.from(r.settlementIntentHash), Uint8Array.from(r.tradeRefHash)),
    policyHash: POLICY_HASH,
    expiresAt: now + 600n,
    ...overrides,
  });
}

export async function deliverReport(
  desk: ForwardedDesk,
  review: PublicKey,
  payload: Uint8Array,
  opts: { state?: PublicKey; seedProgram?: PublicKey } = {},
): Promise<string> {
  const state = opts.state ?? desk.forwarderState;
  const seedProgram = opts.seedProgram ?? guardProgram().programId;
  return forwarderProgram()
    .methods.forward(seedProgram, Buffer.alloc(64), Buffer.from(payload))
    .accountsPartial({ state, authority: forwarderAuthority(state, seedProgram), receiverProgram: guardProgram().programId })
    .remainingAccounts([
      { pubkey: desk.config, isSigner: false, isWritable: false },
      { pubkey: review, isSigner: false, isWritable: true },
    ])
    .rpc({ commitment: "confirmed" });
}
```

- [ ] **Step 3: Write the failing tests**

`tests/on_report.ts`:

```ts
import * as anchor from "@anchor-lang/core";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { VERDICT } from "@wysiwys/shared";
import { payoutIxs, proposePayout, usdc } from "./helpers/squads";
import { chainNow, expectError, guardEvents, guardProgram, randomHash, requestReview, setupGuardedDesk, statusOf } from "./helpers/guard";
import {
  ForwardedDesk, approvePayload, createForwarderState, deliverReport, forwarderAuthority, forwarderProgram, setupForwardedDesk,
} from "./helpers/forwarder";

describe("on_report", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = guardProgram();
  const connection = program.provider.connection;
  let desk: ForwardedDesk;

  before(async () => {
    desk = await setupForwardedDesk();
  });

  async function pendingReview() {
    const p = await proposePayout(connection, desk, payoutIxs(desk, desk.counterpartyAta, usdc(500_000)));
    return (await requestReview(desk, p)).review;
  }

  it("records an approval from the forwarder and emits DecisionRecorded", async () => {
    const review = await pendingReview();
    const payload = await approvePayload(review);
    const sig = await deliverReport(desk, review, payload);
    const r = await program.account.review.fetch(review, "confirmed");
    expect(statusOf(r)).to.equal("approved");
    expect(r.reason).to.equal(0);
    expect(r.expiresAt.toNumber()).to.be.greaterThan(Number(await chainNow(connection)));
    const ev = (await guardEvents(sig)).find((e) => e.name === "decisionRecorded");
    expect(ev?.data.review.toBase58()).to.equal(review.toBase58());
    expect(ev?.data.verdict).to.equal(VERDICT.APPROVE);
  });

  it("records a rejection with its reason", async () => {
    const review = await pendingReview();
    await deliverReport(desk, review, await approvePayload(review, { verdict: VERDICT.REJECT, reason: 12 }));
    const r = await program.account.review.fetch(review, "confirmed");
    expect(statusOf(r)).to.equal("rejected");
    expect(r.reason).to.equal(12);
  });

  it("rejects a forwarder state other than the configured one", async () => {
    const review = await pendingReview();
    const otherState = await createForwarderState();
    await expectError(deliverReport(desk, review, await approvePayload(review), { state: otherState }), "InvalidForwarder");
  });

  it("rejects a forwarder state not owned by the configured forwarder program", async () => {
    // Guard configured with the System program as forwarder program; the real state is owned by test_forwarder.
    const forwarderState = await createForwarderState();
    const odd = await setupGuardedDesk({ forwarderProgram: SystemProgram.programId, forwarderState });
    const p = await proposePayout(connection, odd, payoutIxs(odd, odd.counterpartyAta, usdc(1)));
    const { review } = await requestReview(odd, p);
    await expectError(deliverReport({ ...odd, forwarderState }, review, await approvePayload(review)), "InvalidForwarder");
  });

  it("rejects an authority derived for another receiver", async () => {
    const review = await pendingReview();
    await expectError(
      deliverReport(desk, review, await approvePayload(review), { seedProgram: PublicKey.unique() }),
      "InvalidForwarder",
    );
  });

  it("rejects an unsigned authority (direct call)", async () => {
    const review = await pendingReview();
    await expectError(
      program.methods
        .onReport(Buffer.alloc(64), Buffer.from(await approvePayload(review)))
        .accountsPartial({ forwarderState: desk.forwarderState, forwarderAuthority: forwarderAuthority(desk.forwarderState), config: desk.config, review })
        .rpc(),
      "InvalidForwarder",
    );
  });

  it("rejects a msg_hash mismatch", async () => {
    const review = await pendingReview();
    await expectError(deliverReport(desk, review, await approvePayload(review, { msgHash: randomHash() })), "HashMismatch");
  });

  it("rejects an intent hash mismatch", async () => {
    const review = await pendingReview();
    await expectError(deliverReport(desk, review, await approvePayload(review, { intentHash: randomHash() })), "IntentMismatch");
  });

  it("rejects a policy hash different from the config", async () => {
    const review = await pendingReview();
    await expectError(deliverReport(desk, review, await approvePayload(review, { policyHash: randomHash() })), "PolicyMismatch");
  });

  it("rejects malformed payloads", async () => {
    const review = await pendingReview();
    const good = await approvePayload(review);
    await expectError(deliverReport(desk, review, good.slice(0, 106)), "InvalidPayload");
    await expectError(deliverReport(desk, review, Uint8Array.from([...good, 0])), "InvalidPayload");
    const badVerdict = Uint8Array.from(good);
    badVerdict[0] = 3;
    await expectError(deliverReport(desk, review, badVerdict), "InvalidPayload");
    const now = await chainNow(connection);
    await expectError(deliverReport(desk, review, await approvePayload(review, { expiresAt: now - 1n })), "InvalidPayload");
  });

  it("rejects a second report once decided", async () => {
    const review = await pendingReview();
    await deliverReport(desk, review, await approvePayload(review));
    await expectError(
      deliverReport(desk, review, await approvePayload(review, { verdict: VERDICT.REJECT, reason: 2 })),
      "InvalidStatusTransition",
    );
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `anchor test`
Expected: FAIL, the guard has no `on_report` (the forwarder CPI fails with `InstructionFallbackNotFound` / `onReport is not a function`).

- [ ] **Step 5: Implement `on_report`**

`src/instructions/on_report.rs`:

```rust
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::GuardError;
use crate::events::DecisionRecorded;
use crate::logic;
use crate::state::{GuardConfig, Review, ReviewStatus};

/// Account order is fixed by the Keystone forwarder: [forwarder_state, forwarder_authority, ...receiver accounts].
#[derive(Accounts)]
pub struct OnReport<'info> {
    /// CHECK: verified against config in logic::verify_forwarder.
    pub forwarder_state: UncheckedAccount<'info>,
    /// CHECK: PDA and signer flag verified in logic::verify_forwarder (custom error instead of Anchor's).
    pub forwarder_authority: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED, review.multisig.as_ref()], bump = config.bump)]
    pub config: Account<'info, GuardConfig>,
    #[account(
        mut,
        seeds = [REVIEW_SEED, review.multisig.as_ref(), &review.tx_index.to_le_bytes()],
        bump = review.bump
    )]
    pub review: Account<'info, Review>,
}

pub fn handle_on_report(ctx: Context<OnReport>, _metadata: Vec<u8>, report: Vec<u8>) -> Result<()> {
    let state = &ctx.accounts.forwarder_state;
    let authority = &ctx.accounts.forwarder_authority;
    logic::verify_forwarder(&state.key(), state.owner, &authority.key(), authority.is_signer, &ctx.accounts.config)?;

    let config_policy_hash = ctx.accounts.config.policy_hash;
    let review = &mut ctx.accounts.review;
    require!(review.status == ReviewStatus::Pending, GuardError::InvalidStatusTransition);

    let payload = logic::decode_report(&report, Clock::get()?.unix_timestamp)?;
    require!(payload.msg_hash == review.msg_hash, GuardError::HashMismatch);
    require!(
        payload.intent_hash == logic::intent_hash(&review.settlement_intent_hash, &review.trade_ref_hash),
        GuardError::IntentMismatch
    );
    require!(payload.policy_hash == config_policy_hash, GuardError::PolicyMismatch);

    review.status = if payload.verdict == VERDICT_APPROVE { ReviewStatus::Approved } else { ReviewStatus::Rejected };
    review.reason = payload.reason;
    review.policy_hash = payload.policy_hash;
    review.expires_at = payload.expires_at;

    emit!(DecisionRecorded {
        review: review.key(),
        verdict: payload.verdict,
        reason: payload.reason,
        policy_hash: payload.policy_hash,
        expires_at: payload.expires_at,
    });
    Ok(())
}
```

In `src/instructions/mod.rs` add `pub mod on_report;` and `pub use on_report::*;`. In the `#[program]` module add:

```rust
    pub fn on_report(ctx: Context<OnReport>, metadata: Vec<u8>, report: Vec<u8>) -> Result<()> {
        instructions::on_report::handle_on_report(ctx, metadata, report)
    }
```

If Anchor will not resolve `review.multisig` in the `config` seeds because `review` is declared later, replace the `config` seeds with `constraint = config.multisig == review.multisig @ GuardError::WrongMultisig` (the config is still guard-owned and only created by `init`).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `anchor test`
Expected: all on_report tests pass. Check the CU used by the approve test in the logs (`consumed N of M compute units`); it must be well under 290,000.

- [ ] **Step 7: Checkpoint**

```bash
git add Anchor.toml programs tests
git commit -m "feat(guard): on_report with forwarder checks"
```

---

### Task 7: `guarded_execute`

**Files:**
- Create: `programs/wysiwys_guard/src/instructions/guarded_execute.rs`, `tests/guarded_execute.ts`
- Modify: `programs/wysiwys_guard/src/instructions/mod.rs`, `programs/wysiwys_guard/src/lib.rs`

**Interfaces:**
- Consumes: `logic::{is_advance_nonce, check_executable, sha256}`, `Executed` event, `executeRemainingAccounts`, `deliverReport`, `approvePayload`, `approve`.
- Produces: instruction `guarded_execute()` (no args), accounts `config, review (mut), multisig, proposal (mut), vault_transaction, executor, squads_program, instructions_sysvar`, then the Squads message accounts as remaining accounts.

- [ ] **Step 1: Write the failing tests**

`tests/guarded_execute.ts`:

```ts
import * as anchor from "@anchor-lang/core";
import * as multisig from "@sqds/multisig";
import {
  ComputeBudgetProgram, Keypair, NONCE_ACCOUNT_LENGTH, PublicKey, SYSVAR_CLOCK_PUBKEY, SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram, Transaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount } from "@solana/spl-token";
import { expect } from "chai";
import { VERDICT } from "@wysiwys/shared";
import { approve, executeRemainingAccounts, payoutIxs, proposePayout, usdc, Proposed, SQUADS_PROGRAM_ID } from "./helpers/squads";
import { chainNow, expectError, guardEvents, guardProgram, payer, requestReview, statusOf } from "./helpers/guard";
import { ForwardedDesk, approvePayload, deliverReport, setupForwardedDesk } from "./helpers/forwarder";

describe("guarded_execute", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = guardProgram();
  const connection = program.provider.connection;
  const AMOUNT = usdc(500_000);
  let desk: ForwardedDesk;

  before(async () => {
    desk = await setupForwardedDesk();
  });

  type Flow = { p: Proposed; review: PublicKey };

  async function flow(opts: { votes?: number; verdict?: "approve" | "reject" | "none"; expiresIn?: bigint } = {}): Promise<Flow> {
    const p = await proposePayout(connection, desk, payoutIxs(desk, desk.counterpartyAta, AMOUNT));
    const { review } = await requestReview(desk, p);
    if ((opts.votes ?? 3) > 0) await approve(connection, desk, p.transactionIndex, opts.votes ?? 3);
    const verdict = opts.verdict ?? "approve";
    if (verdict !== "none") {
      const expiresAt = (await chainNow(connection)) + (opts.expiresIn ?? 600n);
      const overrides = verdict === "reject" ? { verdict: VERDICT.REJECT, reason: 12, expiresAt } : { expiresAt };
      await deliverReport(desk, review, await approvePayload(review, overrides));
    }
    return { p, review };
  }

  async function executeIx(f: Flow, overrides: Record<string, PublicKey> = {}, remaining?: anchor.web3.AccountMeta[]) {
    return program.methods
      .guardedExecute()
      .accountsPartial({
        config: desk.config,
        review: f.review,
        multisig: desk.multisigPda,
        proposal: f.p.proposalPda,
        vaultTransaction: f.p.transactionPda,
        executor: desk.executorPda,
        squadsProgram: SQUADS_PROGRAM_ID,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        ...overrides,
      })
      .remainingAccounts(remaining ?? (await executeRemainingAccounts(connection, desk, f.p.transactionIndex)))
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]);
  }

  const execute = async (f: Flow, overrides: Record<string, PublicKey> = {}, remaining?: anchor.web3.AccountMeta[]) =>
    (await executeIx(f, overrides, remaining)).rpc({ commitment: "confirmed" });

  const reviewStatus = async (review: PublicKey) => statusOf(await program.account.review.fetch(review, "confirmed"));

  it("executes an approved 3 of 3 payout", async () => {
    const f = await flow();
    const before = (await getAccount(connection, desk.counterpartyAta)).amount;
    const sig = await execute(f);
    expect((await getAccount(connection, desk.counterpartyAta)).amount - before).to.equal(AMOUNT);
    expect(await reviewStatus(f.review)).to.equal("executed");
    const proposal = await multisig.accounts.Proposal.fromAccountAddress(connection, f.p.proposalPda, "confirmed");
    expect(proposal.status.__kind).to.equal("Executed");
    const ev = (await guardEvents(sig)).find((e) => e.name === "executed");
    expect(ev?.data.review.toBase58()).to.equal(f.review.toBase58());
    expect(BigInt(ev!.data.txIndex.toString())).to.equal(f.p.transactionIndex);
  });

  it("refuses a Pending review", async () => {
    await expectError(execute(await flow({ verdict: "none" })), "NotApproved");
  });

  it("refuses a Rejected review", async () => {
    await expectError(execute(await flow({ verdict: "reject" })), "NotApproved");
  });

  it("refuses after expiry", async () => {
    const f = await flow({ expiresIn: 3n });
    const expiresAt = BigInt((await program.account.review.fetch(f.review, "confirmed")).expiresAt.toString());
    while ((await chainNow(connection)) <= expiresAt) await new Promise((r) => setTimeout(r, 500));
    await expectError(execute(f), "Expired");
  });

  it("refuses a second execution", async () => {
    const f = await flow();
    await execute(f);
    await expectError(execute(f), "AlreadyExecuted");
  });

  it("refuses a report after execution", async () => {
    const f = await flow();
    await execute(f);
    await expectError(deliverReport(desk, f.review, await approvePayload(f.review)), "InvalidStatusTransition");
  });

  it("refuses a durable nonce transaction", async () => {
    const f = await flow();
    const nonce = Keypair.generate();
    const rent = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
    await anchor.web3.sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.createNonceAccount({ fromPubkey: payer().publicKey, noncePubkey: nonce.publicKey, authorizedPubkey: payer().publicKey, lamports: rent }),
      ),
      [payer(), nonce],
      { commitment: "confirmed" },
    );
    const { nonce: nonceValue } = (await connection.getNonce(nonce.publicKey, "confirmed"))!;
    const guardIx = await (await executeIx(f)).instruction();
    const tx = new Transaction({ feePayer: payer().publicKey, nonceInfo: {
      nonce: nonceValue,
      nonceInstruction: SystemProgram.nonceAdvance({ noncePubkey: nonce.publicKey, authorizedPubkey: payer().publicKey }),
    } }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), guardIx);
    tx.sign(payer());
    await expectError(connection.sendRawTransaction(tx.serialize()), "DurableNonceDetected");
    expect(await reviewStatus(f.review)).to.equal("approved");
  });

  it("refuses a fake instructions sysvar", async () => {
    await expectError(execute(await flow(), { instructionsSysvar: SYSVAR_CLOCK_PUBKEY }), "InvalidInstructionsSysvar");
  });

  it("refuses a CPI target other than Squads", async () => {
    await expectError(execute(await flow(), { squadsProgram: TOKEN_PROGRAM_ID }), "InvalidSquadsProgram");
  });

  it("refuses a review from another multisig", async () => {
    const other = await setupForwardedDesk();
    const p = await proposePayout(connection, other, payoutIxs(other, other.counterpartyAta, usdc(1)));
    const { review } = await requestReview(other, p);
    const mine = await flow();
    await expectError(execute({ ...mine, review }), "WrongMultisig");
  });

  it("refuses accounts that do not match the review", async () => {
    const a = await flow();
    const b = await flow();
    await expectError(execute(a, { vaultTransaction: b.p.transactionPda, proposal: b.p.proposalPda }), "ReviewMismatch");
  });

  it("2 of 3 votes: Squads refuses, review stays Approved, executes after the third vote", async () => {
    const f = await flow({ votes: 2 });
    await expectError(execute(f), "InvalidProposalStatus");
    expect(await reviewStatus(f.review)).to.equal("approved");
    const third = desk.members[2];
    await multisig.rpc.proposalApprove({ connection, feePayer: third, member: third, multisigPda: desk.multisigPda, transactionIndex: f.p.transactionIndex });
    await new Promise((r) => setTimeout(r, 1000));
    await execute(f);
    expect(await reviewStatus(f.review)).to.equal("executed");
  });

  it("truncated remaining accounts: Squads refuses and the review stays Approved", async () => {
    const f = await flow();
    const remaining = await executeRemainingAccounts(connection, desk, f.p.transactionIndex);
    await expectError(execute(f, {}, remaining.slice(0, -1)), "InvalidNumberOfAccounts", "Error");
    expect(await reviewStatus(f.review)).to.equal("approved");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `anchor test`
Expected: FAIL, `guardedExecute is not a function`.

- [ ] **Step 3: Implement `guarded_execute`**

`src/instructions/guarded_execute.rs`:

```rust
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

use crate::constants::*;
use crate::errors::GuardError;
use crate::events::Executed;
use crate::logic;
use crate::state::{GuardConfig, Review, ReviewStatus};

/// Remaining accounts: the Squads message accounts, in the order Squads expects
/// (see @sqds/multisig accountsForTransactionExecute). They are passed through unchanged.
#[derive(Accounts)]
pub struct GuardedExecute<'info> {
    #[account(
        seeds = [CONFIG_SEED, multisig.key().as_ref()],
        bump = config.bump,
        has_one = multisig @ GuardError::WrongMultisig
    )]
    pub config: Account<'info, GuardConfig>,
    /// Multisig, PDA and account bindings checked in the handler, in a fixed order.
    #[account(mut)]
    pub review: Account<'info, Review>,
    /// CHECK: Squads multisig, bound by config.has_one; Squads re-validates it.
    #[account(owner = SQUADS_PROGRAM_ID @ GuardError::NotSquadsAccount)]
    pub multisig: UncheckedAccount<'info>,
    /// CHECK: must equal review.proposal (handler); Squads re-validates it.
    #[account(mut, owner = SQUADS_PROGRAM_ID @ GuardError::NotSquadsAccount)]
    pub proposal: UncheckedAccount<'info>,
    /// CHECK: must equal review.vault_transaction and still hash to review.msg_hash (handler).
    #[account(owner = SQUADS_PROGRAM_ID @ GuardError::NotSquadsAccount)]
    pub vault_transaction: UncheckedAccount<'info>,
    /// CHECK: executor PDA, signs only the Squads CPI below.
    #[account(seeds = [EXECUTOR_SEED, multisig.key().as_ref()], bump = config.executor_bump)]
    pub executor: UncheckedAccount<'info>,
    /// CHECK: must be exactly the Squads program.
    #[account(address = SQUADS_PROGRAM_ID @ GuardError::InvalidSquadsProgram)]
    pub squads_program: UncheckedAccount<'info>,
    /// CHECK: address checked in the handler before it is read.
    pub instructions_sysvar: UncheckedAccount<'info>,
}

pub fn handle_guarded_execute<'info>(ctx: Context<'info, GuardedExecute<'info>>) -> Result<()> {
    // Security rule 4: verify the sysvar address, then refuse durable-nonce transactions.
    let ix_sysvar = ctx.accounts.instructions_sysvar.to_account_info();
    require_keys_eq!(*ix_sysvar.key, solana_instructions_sysvar::ID, GuardError::InvalidInstructionsSysvar);
    let first = solana_instructions_sysvar::load_instruction_at_checked(0, &ix_sysvar)
        .map_err(|_| error!(GuardError::InvalidInstructionsSysvar))?;
    require!(!logic::is_advance_nonce(&first.program_id, &first.data), GuardError::DurableNonceDetected);

    let multisig_key = ctx.accounts.multisig.key();
    let proposal_key = ctx.accounts.proposal.key();
    let vault_tx_key = ctx.accounts.vault_transaction.key();
    let current_hash = logic::sha256(&ctx.accounts.vault_transaction.try_borrow_data()?);
    let now = Clock::get()?.unix_timestamp;

    let (review_key, tx_index) = {
        let review = &mut ctx.accounts.review;
        require_keys_eq!(review.multisig, multisig_key, GuardError::WrongMultisig);
        let expected = Pubkey::create_program_address(
            &[REVIEW_SEED, multisig_key.as_ref(), &review.tx_index.to_le_bytes(), &[review.bump]],
            &crate::ID,
        )
        .map_err(|_| error!(GuardError::ReviewMismatch))?;
        require_keys_eq!(expected, review.key(), GuardError::ReviewMismatch);
        require_keys_eq!(review.vault_transaction, vault_tx_key, GuardError::ReviewMismatch);
        require_keys_eq!(review.proposal, proposal_key, GuardError::ReviewMismatch);
        logic::check_executable(review.status, review.expires_at, now)?;
        require!(current_hash == review.msg_hash, GuardError::HashMismatch);

        // Security rule 6: Executed is written before the CPI.
        review.status = ReviewStatus::Executed;
        (review.key(), review.tx_index)
    };
    anchor_lang::AccountsExit::exit(&ctx.accounts.review, &crate::ID)?;

    let a = &ctx.accounts;
    let mut metas = vec![
        AccountMeta::new_readonly(multisig_key, false),
        AccountMeta::new(proposal_key, false),
        AccountMeta::new_readonly(vault_tx_key, false),
        AccountMeta::new_readonly(a.executor.key(), true),
    ];
    let mut infos = vec![
        a.multisig.to_account_info(),
        a.proposal.to_account_info(),
        a.vault_transaction.to_account_info(),
        a.executor.to_account_info(),
    ];
    for acc in ctx.remaining_accounts.iter() {
        metas.push(AccountMeta { pubkey: *acc.key, is_signer: false, is_writable: acc.is_writable });
        infos.push(acc.clone());
    }
    infos.push(a.squads_program.to_account_info());

    let ix = Instruction {
        program_id: SQUADS_PROGRAM_ID,
        accounts: metas,
        data: VAULT_TRANSACTION_EXECUTE_DISCRIMINATOR.to_vec(),
    };
    let bump = [a.config.executor_bump];
    let executor_seeds: &[&[u8]] = &[EXECUTOR_SEED, multisig_key.as_ref(), &bump];
    // Security rule 2: the only invoke_signed in the guard.
    invoke_signed(&ix, &infos, &[executor_seeds])?;

    emit!(Executed { review: review_key, multisig: multisig_key, tx_index });
    Ok(())
}
```

In `src/instructions/mod.rs` add `pub mod guarded_execute;` and `pub use guarded_execute::*;`. In the `#[program]` module add:

```rust
    pub fn guarded_execute<'info>(ctx: Context<'info, GuardedExecute<'info>>) -> Result<()> {
        instructions::guarded_execute::handle_guarded_execute(ctx)
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p wysiwys_guard --lib && anchor test`
Expected: all pass. If "truncated remaining accounts" fails for a reason other than a Squads error, print the logs, then tighten the expected name to the actual Squads error (`InvalidNumberOfAccounts` or `InvalidAccount`) and drop the generic `"Error"` fallback.

- [ ] **Step 5: Checkpoint**

```bash
git add programs/wysiwys_guard tests/guarded_execute.ts
git commit -m "feat(guard): guarded_execute with Squads CPI"
```

---

### Task 8: Structural security tests, IDL in shared, first devnet deploy

**Files:**
- Create: `tests/structure.ts`, `packages/shared/idl/wysiwys_guard.json`
- Modify: `docs/spikes.md`, `README.md` (Security section)

**Interfaces:**
- Consumes: the built IDL `target/idl/wysiwys_guard.json`, `GuardErrorCode`.
- Produces: `packages/shared/idl/wysiwys_guard.json` (listener and app parse events with it); guard deployed on devnet at the Task 0 program ID.

- [ ] **Step 1: Write the structural tests**

`tests/structure.ts`:

```ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";
import { GuardErrorCode } from "@wysiwys/shared";

const idl = JSON.parse(readFileSync("target/idl/wysiwys_guard.json", "utf8"));
const srcDir = "programs/wysiwys_guard/src";
const sources = [
  ...readdirSync(srcDir).filter((f) => f.endsWith(".rs")).map((f) => join(srcDir, f)),
  ...readdirSync(join(srcDir, "instructions")).map((f) => join(srcDir, "instructions", f)),
].map((path) => ({ path, text: readFileSync(path, "utf8") }));

describe("structure (security rules 2, 3, 8)", () => {
  it("exposes exactly the four frozen instructions (no config update path)", () => {
    expect(idl.instructions.map((i: any) => i.name).sort()).to.deep.equal(
      ["guarded_execute", "initialize_guard", "on_report", "request_review"],
    );
  });

  it("has exactly one invoke_signed, in guarded_execute", () => {
    const hits = sources.flatMap((s) => (s.text.match(/invoke_signed\(/g) ?? []).map(() => s.path));
    expect(hits).to.deep.equal([join(srcDir, "instructions", "guarded_execute.rs")]);
  });

  it("never uses init_if_needed", () => {
    expect(sources.some((s) => s.text.includes("init_if_needed"))).to.equal(false);
  });

  it("error codes match packages/shared", () => {
    for (const e of idl.errors) {
      expect(GuardErrorCode[e.name as keyof typeof GuardErrorCode], e.name).to.equal(e.code);
    }
    expect(idl.errors.length).to.equal(Object.keys(GuardErrorCode).length);
  });
});
```

Note: Anchor 1.x IDLs use snake_case instruction names; if the IDL shows camelCase, adjust the expected list to match the IDL, not the other way round.

- [ ] **Step 2: Run them**

Run: `anchor test`
Expected: all pass (these lock rules already implemented; a failure means a real violation, fix the program, not the test).

- [ ] **Step 3: Publish the IDL to shared**

```bash
mkdir -p packages/shared/idl
cp target/idl/wysiwys_guard.json packages/shared/idl/wysiwys_guard.json
```

Add to `packages/shared/README.md`: "`idl/wysiwys_guard.json` is copied from `target/idl` after every guard change (`anchor build`)."

- [ ] **Step 4: First devnet deploy (target: 22:00 day 1)**

```bash
anchor build -p wysiwys_guard
solana balance -u d    # deploy needs about 4 SOL on devnet
solana program deploy target/deploy/wysiwys_guard.so \
  --program-id keys/wysiwys_guard-program-keypair.json \
  -u <Helius devnet RPC URL> \
  --with-compute-unit-price 100000 --max-sign-attempts 50
solana program show <GUARD_PROGRAM_ID> -u d
```

If the deploy stops midway, resume from the printed buffer with `solana program deploy --buffer <BUFFER> ...`; recover the buffer keypair with `solana-keygen recover` using the printed seed phrase. Never deploy `test_forwarder` to devnet.

Expected: `solana program show` prints the program ID, the deployer as upgrade authority, and a recent slot.

- [ ] **Step 5: Document**

In `docs/spikes.md` add the devnet deploy signature and slot. In `README.md` add a "Security" section listing: the 12 checklist items with the test file that covers each, trust assumptions (Squads v4 audited, Chainlink forwarder, guard not audited), devnet only, upgrade authority held by the deployer during the event and moved to governance or made immutable before mainnet.

- [ ] **Step 6: Checkpoint**

```bash
git add tests/structure.ts packages/shared docs/spikes.md README.md
git commit -m "chore(guard): structural security tests, shared IDL, first devnet deploy"
```

---

## Not in this plan (next plans)

- `scripts/bootstrap-devnet.ts` and `scripts/e2e-devnet.ts` (guard plan v3 Task 6): needs the devnet program from Task 8. Bootstrap must keep the Squads `create_key` keypair in `keys/` because `initialize_guard` requires its signature.
- Real CRE run through the mock forwarder (guard plan v3 Task 7, with Teammate A). The workflow must pass `[forwarderState, forwarderAuthority, config, review]` and a 107-byte payload.
- Possible follow-up worth raising with the team: two different Squads proposals for the same trade can both be approved and executed (the guard does not track `trade_ref_hash` uniqueness; the workflow's `TRADE_ALREADY_SETTLED` check has a race). A `["settled", multisig, trade_ref_hash]` PDA created with `init` in `guarded_execute` would close it on-chain.
