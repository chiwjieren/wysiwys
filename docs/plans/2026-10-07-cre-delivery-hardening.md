# CRE delivery and read-consistency hardening

Scope: harden the existing Wysiwys treasury workflow without changing the frozen guard, report payload, policy layers or runner HTTP contracts. The OTC trade-ticket/client-leg extension is outside this change.

## Implementation order

1. Add and run failing tests covering the complete confidential handler: provider identity/eligibility, shared slot floor, quorum failure, screening errors and sanctions, policy/hash mismatch, write failure and missing signature. Use public account fixtures and dummy secrets only.
2. Establish a DON-aggregated read context before reading accounts: median slot floor and identical eligible-provider set. Reuse it for both reads. Validate the three configured provider domains so one provider cannot receive two votes through duplicate URLs. Account contents still use identical aggregation after the application-level two-of-three comparison. Budget: six health requests, three initial reads, three destination reads, one screening request, at most thirteen HTTP calls.
3. Check the pinned SDK's Solana transaction and receiver execution enums and require a 64-byte signature for report submission. Add a receiver-free `local-simulation` target that performs the real reads and policy evaluation, then exits before report generation or write submission.
4. Require the runner's broadcast path to observe a finalized, guard-owned, correctly bound, decided Review before acknowledging delivery. A dry run must never acknowledge a listener trigger. Failed verification remains retryable. Validate this independently from CLI exit codes and logs.
5. Update the architecture markdown and a code-native diagram to show the whole confidential handler, DON crossover, source quorum versus network consensus, and simulation versus live trust boundaries. Keep the original PNG as a historical reference.
6. Run review and runner tests, workspace checks, and a native non-broadcast local simulation. Save sanitized evidence. No deployment, broadcast, commit or push is part of this change.

## Acceptance

- No quorum, stale destination, unavailable screening, mismatched policy/transaction or failed report delivery can authorize a payment or be acknowledged as successful delivery.
- The destination read uses the same agreed minimum context slot and eligible providers as the initial read. This is a freshness lower bound, not an atomic snapshot across requests; the guard still rechecks the live destination.
- Simulation evidence makes no claim of real DON BFT, enclave attestation or live forwarder signature verification.
- Existing 117-byte payload v2 and on-chain security tests remain unchanged.

## Verification status

Implementation complete; native runtime verification is pending private inputs.

- Review tests: 46 passed, including the full handler with mocked capability I/O. These tests are not live DON/TEE evidence.
- Runner tests: 68 passed under temporary Node 22.23.3. The installed global Node 22.12.0 is below the runner's minimum; it was not changed globally.
- Root workspace tests and root/workflow TypeScript checks passed. A pre-existing app `BufferSource` type error was resolved by copying encoded request bytes into an ArrayBuffer-backed Uint8Array; signed-proof tests passed. The stale npm lockfile was reconciled during dependency installation.
- The final workflow compiled to WASM through pinned SDK 1.23.0 and cached Javy 8.1.0. Compiler evidence: `evidence/cre/2026-10-07-review-hardening-compile.log`.
- Native local simulation was attempted without broadcast. It compiled but could not start the handler because `CRE_POLICY_DOCUMENT` is unavailable. The gitignored `workflow/policy.json` is also absent. Restore the original private demo policy locally; it must match the existing GuardConfig commitment. Never replace the immutable commitment or invent a policy to pass verification.
- `scripts/simulate-review-local.ts` consumes local inputs opaquely, restricts the public payload to identifiers and invokes only `local-simulation`. Failed-attempt evidence: `evidence/cre/2026-10-07-review-delivery-hardening-local.log`.
- No deployment, broadcast, commit or push occurred. Frozen guard/report/shared interfaces were not changed. OTC client-leg verification remains a separate extension.
