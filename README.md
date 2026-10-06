# OmniCounter

An OTC pre-settlement firewall for Solana. No proof, no payout.

## Security (guard program)

The guard (`programs/omnicounter_guard`) holds the only Execute permission on the desk's Squads v4 multisig. A payout runs only through `guarded_execute`, after a Chainlink CRE report approved that exact vault transaction for that exact trade.

| # | Check | Covered by |
|---|---|---|
| 1 | CPI target is exactly Squads `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` (`InvalidSquadsProgram`) | `tests/guarded_execute.ts` |
| 2 | The executor PDA signs only the Squads `vault_transaction_execute` CPI (one `invoke_signed` in the program) | `tests/structure.ts` |
| 3 | `GuardConfig` is immutable: the program exposes only `initialize_guard`, `request_review`, `on_report`, `guarded_execute` | `tests/structure.ts` |
| 4 | Instructions sysvar address checked before the durable-nonce check (`InvalidInstructionsSysvar`, `DurableNonceDetected`) | `tests/guarded_execute.ts` |
| 5 | Owner, discriminator and seed checks on every account; `has_one = multisig` (`NotSquadsAccount`, `WrongMultisig`, `WrongTxIndex`) | `tests/request_review.ts`, `tests/guarded_execute.ts` |
| 6 | Review bound to its vault transaction and proposal; vault transaction re-hashed at execute (`ReviewMismatch`, `HashMismatch`) | `tests/guarded_execute.ts`, `programs/omnicounter_guard/src/logic.rs` |
| 7 | One-way status Pending → Approved or Rejected; Approved → Executed; Executed written before the CPI (`InvalidStatusTransition`, `AlreadyExecuted`, `NotApproved`) | `tests/on_report.ts`, `tests/guarded_execute.ts` |
| 8 | `on_report` accepts only the configured Keystone forwarder state, owner and signed authority PDA, and matching `msg_hash`, `intent_hash`, `policy_hash` (`InvalidForwarder`, `HashMismatch`, `IntentMismatch`, `PolicyMismatch`) | `tests/on_report.ts`, `logic.rs` |
| 9 | Expiry uses `Clock::get()` (`Expired`) | `tests/guarded_execute.ts` |
| 10 | Report payload is exactly 107 bytes, verdict 1 or 2, reason <= 22, `expires_at` in the future (`InvalidPayload`) | `logic.rs`, `tests/on_report.ts` |
| 11 | `init` only, never `init_if_needed` | `tests/structure.ts` |
| 12 | `initialize_guard` needs the Squads `create_key` signature and an autonomous multisig where the executor PDA is the only Execute member (`InvalidMultisigConfig`) | `tests/initialize_guard.ts` |

**Trust assumptions**
- Squads v4 (audited) enforces the 3 of 3 vote; the guard never replaces it.
- Chainlink CRE and the Keystone forwarder deliver the verdict. On devnet the demo uses Chainlink's simulator mock forwarder, which skips DON signature checks.
- The guard program itself is not audited.

**Deployment**
- Devnet only. Test keys only.
- The upgrade authority stays with the deployer key during the hackathon. Before any mainnet use it moves to governance or the program is made immutable, after an audit.
