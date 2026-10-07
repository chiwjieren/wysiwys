# Wysiwys

What You See Is What You Sign: a treasury payment firewall for Solana. A Squads v4 payment executes only with human approval AND a matching, current, unexpired, unused Guard review from a Chainlink CRE workflow. Design: `docs/plans/architecture.md`.

## Security (guard program)

The guard (`programs/wysiwys_guard`) holds the only Execute permission on the treasury's Squads v4 multisig. A payment runs only through `guarded_execute`, after a Chainlink CRE report approved that exact vault transaction and its destination, and only while that destination is unchanged.

| # | Check | Covered by |
|---|---|---|
| 1 | CPI target is exactly Squads `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` (`InvalidSquadsProgram`) | `tests/guarded_execute.ts` |
| 2 | The executor PDA signs only the Squads `vault_transaction_execute` and `config_transaction_execute` CPIs (one `invoke_signed` in each execute handler) and may not appear in the vault transaction, so its signature cannot reach inner instructions (`ExecutorInMessage`) | `tests/structure.ts`, `tests/guarded_execute.ts` |
| 3 | `GuardConfig` is immutable: the program exposes only `initialize_guard`, `request_review`, `on_report`, `guarded_execute`, `guarded_config_execute` | `tests/structure.ts` |
| 4 | Instructions sysvar address checked before the durable-nonce check (`InvalidInstructionsSysvar`, `DurableNonceDetected`) | `tests/guarded_execute.ts` |
| 5 | Owner, discriminator and seed checks on every account; `has_one = multisig` (`NotSquadsAccount`, `WrongMultisig`, `WrongTxIndex`) | `tests/request_review.ts`, `tests/guarded_execute.ts` |
| 6 | Review bound to its vault transaction and proposal; `tx_hash = sha256("wysiwys:tx:v1" \|\| vault_transaction \|\| data)` computed on-chain at review and recomputed at execute (`ReviewMismatch`, `HashMismatch`) | `tests/request_review.ts`, `tests/guarded_execute.ts`, `programs/wysiwys_guard/src/logic.rs` |
| 7 | One-way status Pending → Approved or Rejected; Approved → Executed; Executed written before the CPI (`InvalidStatusTransition`, `AlreadyExecuted`, `NotApproved`) | `tests/on_report.ts`, `tests/guarded_execute.ts` |
| 8 | `on_report` accepts only the configured Keystone forwarder state, owner and signed authority PDA, reports whose metadata names the configured CRE workflow owner, and matching `tx_hash`, `policy_hash` (`InvalidForwarder`, `InvalidWorkflow`, `HashMismatch`, `PolicyMismatch`) | `tests/on_report.ts`, `logic.rs` |
| 9 | Expiry uses `Clock::get()` (`Expired`) | `tests/guarded_execute.ts` |
| 10 | Report payload v2 is exactly 117 bytes (fits CRE's 265-byte Solana raw report): version 2, verdict 1 or 2, reason <= 13, approve names a destination kind (SOL or SPL) with a non-zero `destination_hash`, `issued_at` at most 60 s ahead, `expires_at` in the future and at most `max_review_lifetime` after `issued_at` (`InvalidPayload`) | `logic.rs`, `tests/on_report.ts` |
| 11 | `init` only, never `init_if_needed` | `tests/structure.ts` |
| 12 | `initialize_guard` needs the Squads `create_key` signature and an autonomous multisig where the executor PDA is the only Execute member (`InvalidMultisigConfig`) | `tests/initialize_guard.ts` |
| 13 | Only the vault transaction's creator can call `request_review`, so nobody else can claim the single Review slot (`NotProposer`) | `tests/request_review.ts` |
| 14 | A report must arrive within `review_deadline_secs` of `request_review` (`ReviewDeadlinePassed`); both durations must be positive at init (`InvalidConfig`) | `tests/on_report.ts`, `tests/initialize_guard.ts` |
| 15 | `guarded_execute` recomputes `destination_hash` from the passed destination account: same account and, for SPL, still a legacy Token account with the reviewed mint and owner, not frozen (`DestinationChanged`) | `tests/guarded_execute.ts`, `logic.rs` |
| 16 | `guarded_config_execute` runs a voted Squads config transaction only if every action is a safe membership change (add a voter without Execute, remove a member other than the executor, change threshold, set time lock); spending limits, rent collector and unknown actions are refused, and after the CPI the executor must still be the sole Execute member (`ConfigActionNotAllowed`, `InvalidMultisigConfig`) | `tests/guarded_config.ts`, `logic.rs` |

**Trust assumptions**
- Squads v4 (audited) enforces the 3 of 3 vote; the guard never replaces it.
- Chainlink CRE and the Keystone forwarder deliver the verdict. On devnet the demo uses Chainlink's simulator mock forwarder, which skips DON signature checks.
- The guard program itself is not audited.

**Deployment**
- Devnet only. Test keys only.
- The upgrade authority stays with the deployer key during the hackathon. Before any mainnet use it moves to governance or the program is made immutable, after an audit.
