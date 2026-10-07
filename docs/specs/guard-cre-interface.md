# Guard to CRE interface (handoff for the CRE workflow)

What the CRE workflow must read and produce so the Wysiwys guard accepts its report. The guard is deployed on devnet; this is the contract it enforces today. Source of truth for encoders: `packages/shared` (use these, do not re-implement).

## Deployed guard

| Item | Value |
|---|---|
| Cluster | Solana devnet |
| Guard program | `9wCcjb74o2cWcFx8GimQQMcR1nJay9X86v1JiyV9kwya` |
| IDL | `packages/shared/idl/wysiwys_guard.json` |
| Squads v4 | `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` |
| Multisig, vault, mUSD mint, recipients | Created by `scripts/bootstrap-devnet.ts`; read them from `deployments/devnet.json`, never hardcode |
| Guard config | Not created yet: needs the values in section 7, then a bootstrap run |

## 1. Trigger: `ReviewRequested`

Emitted by `request_review` (Anchor event, parse with the IDL):

```
ReviewRequested { review: Pubkey, multisig: Pubkey, tx_index: u64, tx_hash: [u8; 32] }
```

The runner sends the workflow identifiers only (`multisig`, `txIndex`). Re-read everything else from chain at `finalized`.

PDAs (all under the guard program):

| Account | Seeds |
|---|---|
| GuardConfig | `["config", multisig]` |
| Review | `["review", multisig, tx_index as u64 LE]` |
| Executor | `["executor", multisig]` |

Squads accounts: `multisig.getTransactionPda({ multisigPda, index })` (the `VaultTransaction`) and `getProposalPda`.

## 2. What the workflow must check

1. **Review is Pending** (`status` 0) and was created less than `review_deadline_secs` ago (`created_at` on the Review, `review_deadline_secs` on GuardConfig). After the deadline the guard refuses any report.
2. **tx_hash**: recompute from the `VaultTransaction` account bytes and compare with `Review.tx_hash`:

   ```ts
   import { txHash } from "@wysiwys/shared";
   const h = txHash(vaultTransactionPda.toBytes(), accountInfo.data); // sha256("wysiwys:tx:v1" || pda || data)
   ```

   Mismatch → reject with `TX_HASH_MISMATCH`.
3. **Decode every instruction** of the stored message. Approve only a single System SOL transfer or a single legacy SPL Token `TransferChecked` from the vault. Anything else → reject (reason codes below).
4. **Destination** (bound into the report as `destination_hash`; the guard recomputes it from the live account at execution):
   - SOL: `destinationHash(ACTION_KIND.SOL, recipientWallet, recipientWallet, zero32)`.
   - SPL: `destinationHash(ACTION_KIND.SPL, destinationTokenAccount, ownerWallet, mint)`, where owner wallet = bytes 32..64 and mint = bytes 0..32 of the token account data. The token account must be owned by `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`, initialized and not frozen, or the payout fails at execution with `DestinationChanged`.
5. **Policy** (confidential): whitelist check on the owner wallet, mint allowlist, per-payment cap, screening.

## 3. Report: metadata + payload

The forwarder calls `on_report(metadata: Vec<u8>, report: Vec<u8>)`.

**Size budget (verified in Chainlink source).** CRE caps the Solana raw report at 265 bytes (`ReportSizeLimit = '265b'` in `chainlink-common` `cresettings/defaults.toml`; the CLI simulator enforces the same). The raw report is `forwarder metadata (109) | Borsh{ account_hash [32], payload Vec<u8> (4 + n) }`, so the payload can be at most **120 bytes**. Payload v2 is 117 (raw report 262).

**Metadata the guard receives (64 bytes)**: `workflow_cid 32 | workflow_name 10 | workflow_owner 20 | report_id 2` (the forwarder passes `raw_report[45..109]`). The guard requires `workflow_owner` (bytes 42..62) to equal GuardConfig's.

**Payload v2 (117 bytes, little-endian)**. Build it with `encodeReportPayload` from `@wysiwys/shared`:

| Offset | Field | Type | Guard rule |
|---|---|---|---|
| 0 | version | u8 | must be 2 |
| 1 | verdict | u8 | 1 approve, 2 reject |
| 2 | reason | u16 | 0..13 (table below) |
| 4 | tx_hash | [32] | must equal `Review.tx_hash` |
| 36 | policy_hash | [32] | must equal `GuardConfig.policy_hash` (section 7) |
| 68 | action_kind | u8 | 0 none (reject only), 1 SOL, 2 SPL |
| 69 | destination_hash | [32] | `destinationHash(...)` from section 2; 32 zero bytes when action_kind is 0, non-zero otherwise |
| 101 | issued_at | i64 | unix seconds; at most 60 s ahead of the chain clock |
| 109 | expires_at | i64 | `> now` and `expires_at - issued_at <= max_review_lifetime` (GuardConfig) |

```ts
import { ACTION_KIND, VERDICT, destinationHash, encodeReportPayload } from "@wysiwys/shared";
const payload = encodeReportPayload({
  verdict: VERDICT.APPROVE, reason: 0, txHash, policyHash, actionKind: ACTION_KIND.SPL,
  destinationHash: destinationHash(ACTION_KIND.SPL, destAta.toBytes(), ownerWallet.toBytes(), mint.toBytes()),
  issuedAt, expiresAt,
});
```

A reject may use `action_kind = 0` with a zero `destination_hash`, but it still needs a valid `tx_hash`, `policy_hash` and a future `expires_at`.

## 4. Reason codes (`ReviewReason`, u16)

| Code | Name | Code | Name |
|---|---|---|---|
| 0 | WITHIN_POLICY | 7 | DURABLE_NONCE_DETECTED |
| 1 | RPC_NO_QUORUM | 8 | DESTINATION_NOT_WHITELISTED |
| 2 | TX_HASH_MISMATCH | 9 | DESTINATION_OWNER_UNRESOLVED |
| 3 | UNKNOWN_PROGRAM | 10 | MINT_NOT_ALLOWED |
| 4 | UNEXPECTED_INSTRUCTION | 11 | AMOUNT_OVER_CAP |
| 5 | UNSUPPORTED_FEATURE (ALT, account creation, Token-2022, ephemeral signers) | 12 | SCREENING_REJECTED |
| 6 | AUTHORITY_CHANGE_BLOCKED | 13 | POLICY_STALE |

## 5. Write target (`on_report` accounts)

Order fixed by the Keystone forwarder: `[forwarder_state, forwarder_authority (signer PDA)]`, then the receiver accounts:

| # | Account | Writable |
|---|---|---|
| 1 | GuardConfig `["config", multisig]` | no |
| 2 | Review `["review", multisig, tx_index LE]` | yes |

The guard checks: `forwarder_state` equals GuardConfig's, is owned by GuardConfig's forwarder program, and `forwarder_authority` equals PDA `["forwarder", forwarder_state, guard_program_id]` under that program and signed. Values in section 7.

Budget: the full forwarder transaction used well under 290,000 CU in local tests.

## 6. Guard errors you may see (Anchor codes from 6000)

`HashMismatch` (tx_hash), `PolicyMismatch`, `InvalidPayload` (length, version, ranges, times, destination rules), `ReviewDeadlinePassed`, `InvalidStatusTransition` (review already decided), `InvalidForwarder`, `InvalidWorkflow` (metadata owner or length). Full list: `packages/shared/src/guard.ts`.

## 7. Guard config values

| Variable | Value | Evidence |
|---|---|---|
| `GUARD_FORWARDER_PROGRAM` | `7kuEAA3mSC1Tz8gQjnvH7bKFda9xSPRRin9SZbH49cNK` (simulator mock forwarder) | CRE Solana onchain-write guide; `chainlink-solana` `mock-forwarder` `declare_id!`; executable on devnet |
| `GUARD_FORWARDER_STATE` | `5Tipz3yhTBdVsDbaBxZkrp7Gjf3brGq5SKkxReefPMP7` | Same guide; owned by the mock forwarder on devnet |
| `GUARD_WORKFLOW_OWNER` | `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` | Simulator default owner (`chainlink` `core/services/workflows/cmd/cre/utils/standalone_engine.go`, `defaultOwner`); confirmed on CLI v1.33.0 / SDK 1.23.0: `evidence/cre/2026-10-07-solana-report-owner-spike.log` (metadata[42..62] = `aa` x 20, raw report 262 of 265 bytes, payload intact) |
| `GUARD_POLICY_HASH` | `f2e827b5a16156d3f46c99da48297dddd83bd29e8182a0e5e0f7174668afb44a` for the current private `workflow/policy.json` (recompute with `npx tsx scripts/policy-hash.ts`); treasuries created earlier keep `402f...` | `policyHash` in `packages/shared` (below) |

Live (deployed workflow) forwarder on devnet, for a future config: program `CXsKEJcs25TQEYU2e5jZ8QTPE3ffMLZhH6BWHrdcCCB5`, state `8QoomCQyPSkJ8WopJbX9B4HyvrFzziwvJdU8hZE6DCr9`. GuardConfig is immutable, so switching means a new multisig and config.

**Trust boundary in simulation.** The mock forwarder does not verify DON signatures, and every simulator reports the same owner, so with this config anyone on devnet could deliver an approval. Demo approvals are simulated, not trust-bearing. Say so in the demo.

**policy_hash.** `sha256("wysiwys:policy:v1" || u32le(len(decoder_version)) || decoder_version || sha256(canonicalJson(policy)))`, with `decoder_version = "@wysiwys/decoder@<package version>"`. `canonicalJson` sorts keys at every level, no whitespace, safe integers only (amounts as decimal strings). The policy must have a numeric `version` and a random hex `salt` of at least 16 bytes so the hash cannot be confirmed by guessing whitelist entries. Template: `workflow/policy.example.json`; the real `workflow/policy.json` is gitignored and goes to CRE as a secret. The workflow must compute the same hash from the same document and put it in every report.

**Policy v1 and the registry.** Every document is validated by `parsePolicy` (`packages/shared`): `version`, `salt`, `allowedPrograms`, `allowedInstructions`, `allowedMints`, `maxAmountPerPayment`, `destinationWhitelist`, optional `screening`; unknown keys are rejected, and the workflow enforces every field (program allowlist `UNKNOWN_PROGRAM`, instruction allowlist `UNEXPECTED_INSTRUCTION`, screening only when the policy has it). The secret `POLICY_DOCUMENT` holds one document or an array (registry); the workflow uses the entry whose hash equals the treasury's `GuardConfig.policy_hash`, so treasuries keep working after another treasury changes policy. No match is `POLICY_STALE`, a malformed or duplicate entry `POLICY_INVALID`; both fail closed without a report. If no secret entry matches, the workflow fetches the document by hash from the runner's policy store (`GET /cre/policies/:hash` with the secret `POLICY_STORE_TOKEN`; config `policyStoreUrl`), parses it and uses it only if its hash matches; the store can only withhold a document (POLICY_STALE), never substitute one. The registry script (`npx tsx scripts/policy-hash.ts --registry`) is optional.

**Voted policy changes.** `policy_hash` changes only through `apply_policy_change`: members vote a Squads proposal whose only instruction is the guard's policy change marker (new hash, expected current hash), and after `max(time lock, 300 s)` anyone applies it. From then on `guarded_execute` refuses approvals issued under the old hash, and the next review fetches the new document by its hash.

**Simulate with broadcast** needs `CRE_SOLANA_PRIVATE_KEY` (base58 keypair, pays the transaction) and `CRE_ETH_PRIVATE_KEY` (required by the CLI even for Solana-only workflows) in the CRE project's `.env`. Solana devnet chain selector: `16423721717087811551`. `computeConfig.computeLimit` must be > 0.
