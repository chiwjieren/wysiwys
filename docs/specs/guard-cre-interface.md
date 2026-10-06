# Guard to CRE interface (handoff for the CRE workflow)

What the CRE workflow must read and produce so the Wysiwys guard accepts its report. The guard is deployed on devnet; this is the contract it enforces today. Source of truth for encoders: `packages/shared` (use these, do not re-implement).

## Deployed guard

| Item | Value |
|---|---|
| Cluster | Solana devnet |
| Guard program | `9wCcjb74o2cWcFx8GimQQMcR1nJay9X86v1JiyV9kwya` |
| IDL | `packages/shared/idl/wysiwys_guard.json` |
| Squads v4 | `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` |
| Guard config, multisig, mint, forwarder | Not created yet. `scripts/bootstrap-devnet.ts` will write them to `deployments/devnet.json`. Never hardcode them. |

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
4. **Destination facts** (these go into the report and the guard re-checks them at execution):
   - SOL: `destination` = recipient wallet, `destinationOwner` = same wallet, `mint` = 32 zero bytes.
   - SPL: `destination` = destination token account, `destinationOwner` = its token-account **owner wallet** (bytes 32..64 of the token account data), `mint` = its mint. The token account must be owned by `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`, initialized and not frozen, or the payout fails at execution with `DestinationChanged`.
5. **Policy** (confidential): whitelist check on the owner wallet, mint allowlist, per-payment cap, screening.

## 3. Report: metadata + payload

The forwarder calls `on_report(metadata: Vec<u8>, report: Vec<u8>)`. Raw report limit is 265 bytes; metadata 64 + payload 181 = 245.

**Metadata (64 bytes)**: `workflow_cid 32 | workflow_name 10 | workflow_owner 20 | report_id 2`. The guard requires `workflow_owner` to equal the 20-byte owner stored in GuardConfig. Tell Jun Heng the workflow owner address before bootstrap.

**Payload v1 (181 bytes, little-endian)**. Build it with `encodeReportPayload` from `@wysiwys/shared`:

| Offset | Field | Type | Guard rule |
|---|---|---|---|
| 0 | version | u8 | must be 1 |
| 1 | verdict | u8 | 1 approve, 2 reject |
| 2 | reason | u16 | 0..13 (table below) |
| 4 | tx_hash | [32] | must equal `Review.tx_hash` |
| 36 | policy_hash | [32] | must equal `GuardConfig.policy_hash` (commitment over `workflow/policy.json` and the decoder version) |
| 68 | action_kind | u8 | 0 none (reject only), 1 SOL, 2 SPL |
| 69 | destination | [32] | see section 2 |
| 101 | destination_owner | [32] | SOL: equal to destination |
| 133 | mint | [32] | SOL: zero; SPL: non-zero |
| 165 | issued_at | i64 | unix seconds; at most 60 s ahead of the chain clock |
| 173 | expires_at | i64 | `> now` and `expires_at - issued_at <= max_review_lifetime` (GuardConfig) |

```ts
import { ACTION_KIND, VERDICT, encodeReportPayload } from "@wysiwys/shared";
const payload = encodeReportPayload({
  verdict: VERDICT.APPROVE, reason: 0, txHash, policyHash, actionKind: ACTION_KIND.SPL,
  destination: destAta.toBytes(), destinationOwner: ownerWallet.toBytes(), mint: mint.toBytes(),
  issuedAt, expiresAt,
});
```

A reject may use `action_kind = 0` with zero destination fields, but it still needs a valid `tx_hash`, `policy_hash` and a future `expires_at`.

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

The guard checks: `forwarder_state` equals GuardConfig's, is owned by GuardConfig's forwarder program, and `forwarder_authority` equals PDA `["forwarder", forwarder_state, guard_program_id]` under that program and signed. The forwarder program and state used for the simulator mock forwarder must be confirmed and given to Jun Heng before bootstrap.

Budget: the full forwarder transaction used well under 290,000 CU in local tests.

## 6. Guard errors you may see (Anchor codes from 6000)

`HashMismatch` (tx_hash), `PolicyMismatch`, `InvalidPayload` (length, version, ranges, times, destination rules), `ReviewDeadlinePassed`, `InvalidStatusTransition` (review already decided), `InvalidForwarder`, `InvalidWorkflow` (metadata owner or length). Full list: `packages/shared/src/guard.ts`.

## 7. Open items for the CRE lead

- Workflow owner address (20 bytes) to store in GuardConfig.
- Simulator mock forwarder program and state for devnet (`cre workflow simulate --broadcast`).
- How `policy_hash` is computed from `workflow/policy.json` + decoder version (must be fixed before bootstrap; GuardConfig is immutable).
- Confirm the 265-byte raw report limit applies to metadata + payload together.
