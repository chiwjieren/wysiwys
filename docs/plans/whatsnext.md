# Wysiwys next steps: complete the hackathon MVP

Date: 6 October 2026.

Status: planning only. Combine this with the other component plans before implementation begins. This document does not authorize bootstrap, broadcast, deployment, config creation, commits or pushes.

References:

- [Configuration handoff](isthiswhatuneed.md)
- [Repository audit](../repo-audit-2026-10-06.md)
- [Architecture](architecture.md)
- [Guard/CRE interface](../specs/guard-cre-interface.md)
- [Frozen Guard decisions](2026-10-06-wysiwys-guard-migration.md)

## Current state

- The Guard program, Squads multisig, mint and vault token account exist on Devnet according to the latest read-only audit.
- `deployments/devnet.json` records their identities and the expected config PDA. Its `guard` field is currently `null`; the audited config PDA has no account.
- `scripts/lib/bootstrap.ts` already supports `initialize_guard`. It skips initialization when none of the four required CRE environment values is supplied and rejects a partially supplied set.
- CRE screening and RPC diagnostics simulate successfully, but neither currently produces or delivers the shared Solana Guard report.
- Confidential deployment access is pending. Local confidential simulation does not require that approval.

## Required Guard inputs

These belong in the root local environment consumed by the bootstrap. Keep credentials out of this document and source control. Do not confuse the root bootstrap environment with the independent preflight project's environment.

| Variable | Required format | Resolution needed |
| --- | --- | --- |
| `GUARD_FORWARDER_PROGRAM` | Solana public key | Verify which simulator mock-forwarder program the installed CRE CLI uses for Solana Devnet delivery. |
| `GUARD_FORWARDER_STATE` | Solana public key | Verify the associated state account exists on Devnet and is owned by that forwarder program. |
| `GUARD_WORKFLOW_OWNER` | 20 bytes of hex, optional `0x` prefix | Establish the owner actually present in the simulator's Solana report metadata. Do not infer it from the organization name, screening key, RPC key or Solana payer. |
| `GUARD_POLICY_HASH` | 32 bytes of hex, optional `0x` prefix | Define and implement the exact commitment over the agreed policy and pinned decoder version, then record the demo policy's resulting hash. |

Candidate forwarder addresses from earlier notes, not approved configuration yet:

- Program: `7kuEAA3mSC1Tz8gQjnvH7bKFda9xSPRRin9SZbH49cNK`.
- State: `5Tipz3yhTBdVsDbaBxZkrp7Gjf3brGq5SKkxReefPMP7`.

Verify candidates against the current official Solana simulator documentation, installed CLI behavior and read-only chain evidence. Account existence alone does not prove the CLI uses that delivery path.

## Resolution work to plan

### 1. Prove the simulator forwarder path

- Inspect the pinned CRE SDK, CLI and official Solana write example for the report wrapper, receiver accounts and simulator forwarder settings.
- Verify the program is executable and the state owner matches it.
- Derive the authority PDA using the Guard's existing `["forwarder", state, guard_program_id]` rule and verify compatibility with the actual delivery path.
- Record the verified public identities, versions and supporting evidence. Keep simulator and live forwarder settings distinct.

### 2. Establish workflow owner metadata

- Determine how the local simulator constructs the 64-byte Solana metadata and which identity supplies its owner field.
- Confirm its 20-byte value agrees with the Guard's current owner slice at offsets 42 through 61, rather than assuming the diagnostic EVM report proves the Solana format.
- Document simulation ownership separately from any future deployed workflow ownership.
- Resolve the intended-workflow provenance gate: matching an owner does not by itself demonstrate exclusive authorization of one workflow belonging to that owner. Raise any necessary frozen-interface change for agreement before editing it.

### 3. Finalize policy and its commitment

- Agree on the actual narrow payment policy: private destination whitelist, allowed programs/instructions, mint and decimals, per-payment cap, source authority and screening behavior.
- Institution-provided whitelist entries and limits are still inputs to settle. Public demo recipient labels do not constitute a confidential policy implementation.
- Implement the policy loading/evaluation path and select the pinned decoder identity/version. `workflow/policy.json` and the canonical commitment implementation do not exist yet.
- Specify deterministic encoding, hash domain/algorithm, version binding and treatment of private inputs. Do not invent the commitment now or treat a hash as encryption.
- Add fixtures proving identical policy/version inputs reproduce the commitment and changed policy/version inputs change it. The workflow must include the same commitment in every Guard report.

### 4. Prove the shared report integration

- Import `txHash` and `encodeReportPayload` from `packages/shared`; do not duplicate their contracts.
- Use the current 181-byte payload, not historical OTC or 107-byte examples.
- Confirm the actual SDK/forwarder size accounting. The intended metadata plus payload is `64 + 181 = 245` bytes; verify how the 265-byte raw report limit applies to the selected path.
- Bind the report to re-read Review/transaction state and resolved destination facts, including issued time and expiry. Missing quorum, malformed decoding, missing policy and screening failures must never authorize execution.
- Prove compilation and receiver-free non-broadcast simulation first. A broadcast delivery test creates real Devnet state and requires separate explicit authorization.

## Existing timing defaults

| Variable | Current default | Meaning |
| --- | --- | --- |
| `GUARD_MAX_REVIEW_LIFETIME` | `3600` seconds | Maximum interval from report issuance to expiry. |
| `GUARD_REVIEW_DEADLINE_SECS` | `900` seconds | Report must arrive within this interval after the review request. |

Both must be positive. Select and record the final demo values before initialization; they are immutable along with the four required inputs. The report must also satisfy the Guard's chain-clock and future-time checks.

## Runner work is separate

Runner URL/token values are not arguments to `initialize_guard` and do not block creating its account once the Guard inputs are resolved.

The chosen approach is simulation only. Plan an authenticated, rate-limited `POST /review` endpoint that accepts identifiers and invokes the real review workflow through `cre workflow simulate`. It must use bounded execution, safe argument handling, deduplication and sanitized results. The current runner exposes only `GET /status` and `GET /reviews`; this simulation endpoint remains unimplemented.

Configure `CRE_TRIGGER_URL` to the actual simulation service endpoint and `CRE_TRIGGER_TOKEN` to its expected authentication once that service exists. A deployed DON HTTP endpoint is unnecessary for this approach. Do not assume a generic bearer token satisfies future deployed CRE trigger authentication without checking the official mechanism.

The preflights currently use cron triggers; the actual review workflow still needs its identifiers-only HTTP trigger, account discovery, hash verification, decoder and confidential policy integration.

## Preconditions for eventual config creation

- [ ] All four exact Guard values and both timing values are documented with verification evidence.
- [ ] Policy commitment and decoder version are finalized for this demo.
- [ ] Current shared Solana report and metadata integration have passed the relevant tests and simulation checks.
- [ ] Forwarder/workflow provenance limitations are resolved or explicitly bounded for the simulator demo.
- [ ] The bootstrap's existing multisig create-key signer is available opaquely to the CLI. Do not read or share its keypair.
- [ ] A funded Devnet payer and the supported local dependencies/toolchain are ready. The bootstrap currently requires at least 0.5 SOL before it proceeds.
- [ ] Multisig permissions and recorded deployment identities are rechecked before sending a transaction.
- [ ] Explicit authorization is obtained for creating immutable Devnet state after presenting the concrete resolved configuration.

Only then run the existing bootstrap, verify the config's on-chain values and update `deployments/devnet.json` through the bootstrap. Do not manually mark the Guard initialized.

Under the current frozen design, incorrect immutable values cannot be edited through an admin operation. Recovery requires a new multisig/config setup rather than overwriting the existing config. No recovery migration or frozen-interface change is authorized by this plan.

## Expected handoff result

A completed handoff must provide the four verified public Guard values, final timing values, exact policy commitment procedure, simulator provenance evidence, report-size evidence and the simulation-runner connection plan. Until then, the config account remains intentionally uninitialized. Implementation starts only after the combined plan is reviewed with the user.

## Full implementation worklist

These tasks extend the Guard configuration checklist into the full product plan. Component ownership below is proposed by role; assign actual teammates when compiling the final plan. The user owns the Chainlink work. Do not treat a task marked planned as implemented or verified.

| Task | Proposed owner | Dependencies | Verification environment |
| --- | --- | --- | --- |
| A. Restore local verification | Integration lead | Current lockfiles and supported toolchains | Local builds and tests |
| B. Reconcile contracts and docs | Integration lead with Guard, decoder and CRE owners | A; frozen MVP decisions | Source review and cross-component fixtures |
| C. Actual three-provider reads | CRE lead | A, B; recorded Devnet identities | Fixtures, real RPCs, native CRE simulation |
| D. Hash and decoder integration | CRE lead with decoder owner | B, C | Fixtures, real account bytes, native CRE simulation |
| E. Confidential policy | CRE lead; institution supplies approved policy values | B, D; policy inputs and Scorechain secret | Fixtures, real sanctions API, simulated TEE |
| F. Combined CRE review/report | CRE lead with Guard owner | C, D, E; verified forwarder and metadata scheme | Native non-broadcast simulation first |
| G. Initialize Guard config | Guard/bootstrap owner with CRE lead | F; configuration preconditions above | Authorized Devnet write and read-back |
| H. Simulation runner integration | Runner owner with CRE lead | F; authenticated HTTP workflow | Local service tests and real CRE process |
| I. Real frontend integration | Frontend owner with Guard/runner owners | B, G, H | Browser tests, real chain reads, authorized Devnet actions |
| J. End-to-end demo and submission | Integration lead and component owners | G, H, I | Integrated Devnet scenarios, hosted demo, video |

### A. Restore local verification

- Restore root workspace dependencies and links using the repository's lockfile. Install the app separately as specified by AGENTS.md without rewriting the root lockfile.
- Use a Node version meeting the runner's documented requirement and verify its SQLite support. Preserve the separately pinned CRE/Bun dependencies.
- Run root workspace tests/type checks, both CRE preflight checks, app checks, and the relevant Anchor/local-validator security tests when that environment is available.
- Record setup blockers separately from genuine code/test failures. Do not weaken security tests or claim all checks passed from the standalone CRE results.

Done: relevant commands run successfully with recorded outputs, or a specific blocker is recorded and dependent work remains gated.

### B. Reconcile contracts and documentation

- Keep the frozen treasury model: one permanent Review per transaction index, immutable config, the current shared tx_hash and 181-byte report, and no pause/admin instructions.
- Reconcile architecture.md and the diagram with those decisions. Mark historical OTC/report examples as obsolete rather than implementing their conflicting interfaces.
- Agree on decoder-facing actions, runner request/results and observation encoding ownership. Obtain approval before any frozen-contract change.
- Update the actual workflow entry-point commands and outdated statements about missing multisig/CRE source.

Done: the implementation plan, shared contracts and component consumers describe the same narrow payment flow.

### C. Actual three-provider account reads

- Accept identifiers only, derive expected Guard/Squads accounts, and read the recorded Devnet identities through QuickNode, Helius and Alchemy.
- Discover relevant source/destination token accounts and mint from agreed transaction data. Cross-check every additional read before using it in a decision.
- Validate expected owners, discriminators, PDAs, account roles, lengths and freshness. Compare the complete deterministic snapshot with 2-of-3 agreement.
- Return agreed contents and the agreed source observation hash through CRE aggregation. Keep this hash distinct from the payment tx_hash.
- Define bounded retry/no-quorum behavior for changing account state. Missing/error responses never count as matching absence of a required account.

Done: native simulation reads actual configured accounts, while fixtures prove conflicting, stale, absent and malformed responses cannot authorize payment. Review-specific tests may use explicit fixtures until an actual Review can be created; label them accordingly.

### D. Hash and decoder integration

- Recompute txHash with packages/shared and compare it with the re-read Review before invoking @wysiwys/decoder.
- Reject malformed/unsupported decoding and require exactly one supported MVP payment for approval. Describing authority, nonce or account-creation instructions does not allow them.
- Validate the vault source authority and, for SPL, token program, mint, decimals, account state and destination owner wallet. Do not equate program owner with wallet authority.
- Use only the agreed bytes downstream. Bind typed actions and destination facts to the transaction and Review.

Done: hash mismatch stops before policy; valid SOL/legacy TransferChecked fixtures produce correct facts; authority changes, nonce operations, extra instructions and unsupported features cannot pass.

### E. Confidential policy and screening

- Load the private destination whitelist and institution-approved limits inside the confidential handler; keep them out of public source, UI, logs and reports.
- Implement deterministic program/instruction allowlists, recipient whitelist, allowed mints/decimals, per-payment caps and source-authority checks.
- Screen the actual decoded recipient wallet through Scorechain. A sanctions no-match is one required check, not general wallet-risk clearance or automatic approval.
- Broader wallet-risk scoring requires a separately verified provider capability and schema if included in the final scope; the existing sanctions endpoint does not supply it. Do not invent risk scores or thresholds.
- Bind the policy/decoder commitment, deadline and expiry into the minimal result. Missing/stale policy, screening errors and unresolved destination facts fail closed.
- Generate deterministic public summaries from reason codes and decoded facts without exposing private policy inputs.

Done: policy fixtures cover allowed payment, unlisted recipient, excessive amount, wrong mint, sanctioned recipient, unsupported instruction and missing inputs; real screening is demonstrated in native confidential simulation. Hardware isolation is not claimed from that simulation.

### F. Combined review workflow and report

- Implement an authenticated identifiers-only HTTP review trigger instead of requiring manual cron configuration for each payment.
- Connect RPC agreement, shared hash verification, decoder, confidential evaluation and report encoding in one actual review workflow.
- Use the runtime boundaries proven by the installed SDK. Export only the minimal bound conclusion for report construction.
- Prove the shared Solana report/receiver accounts and metadata, report-size handling and simulator forwarder settings described above.
- Preserve receiver-free diagnostics. Add a separate explicit delivery target; do not turn every diagnostic run into a write.

Done: native simulation exercises the complete decision and shared payload path, including reject/error cases. Diagnostic EVM reports or unit mocks alone do not satisfy this task.

### G. Guard configuration and report delivery

Apply the earlier configuration preconditions. Initialization and simulator --broadcast delivery are real Devnet writes and require explicit authorization when concrete settings are ready.

Done: the config exists with the exact agreed values; a report through the configured mock forwarder records the intended on-chain Review status; incorrect hashes, owner/provenance inputs, forwarder, policy and times are rejected. Record mock delivery separately from any future live DON delivery.

### H. Runner/listener integration

- Add authenticated, rate-limited POST /review with strict identifier validation and safe CRE process arguments. Supply non-interactive handler/payload/target settings verified against the installed CLI.
- Bound runtime and concurrency; deduplicate requests; retry failures without duplicating accepted reports or extending approvals.
- Connect finalized events to the actual service. Do not mark log-only triggers as successful workflow delivery.
- Expose listener and simulation-runner health, including last failures, and sanitize logs/results. Avoid logging private inputs or credential-bearing URLs.
- Read authoritative Review state from chain when reporting results; SQLite remains history.

Done: duplicate/restart/retry tests pass, finalized requests start the intended workflow, missing authentication is rejected, and workflow failure leaves execution blocked.

### I. Frontend integration

- Replace mock sessionStorage/timer transitions with real Squads proposal creation, Guard request-review, three human votes and guarded execution.
- Add server-side chain/runner adapters and the chosen wallet-signing flow. Keep hosted test keys and service credentials outside browser bundles.
- Show actual votes, Review status, expiry, decoded payment and safe reason/summary. Clearly label any local preview and indeterminate state.
- Remove obsolete client-leg/trade-settlement gates from the treasury UI where they do not match the approved architecture.
- Verify destination selection, test mint, rate limits and demo amount caps. Display Devnet/test-key and simulated CRE/TEE boundaries honestly.

Done: browser actions produce actual configured Devnet transactions, refresh reconstructs state from authoritative services, and changing browser storage cannot authorize a payout.

### J. End-to-end acceptance and submission

Implement shared scenario builders and the missing end-to-end script. Test component failures first, then the full authorized Devnet path.

| Scenario | Required result |
| --- | --- |
| Clean whitelisted payment | Executes exactly once with both Guard approval and 3-of-3 Squads votes. |
| Votes before review / review before votes | Both arrival orders work; neither gate alone executes. |
| Lookalike or unlisted wallet | Policy denies; no transfer. |
| Sanctioned wallet | Screening blocks; no transfer. |
| Wrong mint, decimals, amount or source | Cannot receive an approved payment verdict. |
| Extra authority/nonce/unknown instruction | Denied; no transfer. |
| One conflicting RPC source | Two valid matching sources can produce the agreed snapshot. |
| No quorum, API error or missing policy | No approval fallback; on-chain execution stays blocked. |
| Destination owner changes after review | Guard execution fails. |
| Expired/late report, replay or consumed review | Cannot authorize another payout. |
| Wrong forwarder/workflow binding or hashes | Guard refuses the report. |
| Direct human execute, spending-limit bypass, durable-nonce execution | Blocked by the configured permissions and Guard checks. |
| Missing votes or failed transfer | Execution fails without permanently consuming the Review. |

Capture scenario signatures and sanitized CRE logs. Publish the working demo through the agreed hosting setup, verify the public URL, and prepare the deck with the embedded recorded demo video. Check the public repo excludes secrets and confidential policy values. Publishing, recording-dependent deployments, commits and pushes require the user's applicable authorization.

Done: the integrated acceptance matrix passes, the hosted demo works from a fresh browser, and the submission artifacts are ready.

## Definition of hackathon MVP complete

The product is complete for the agreed hackathon scope only when the actual flow works:

**Propose -> request review -> real RPC account agreement -> shared hash verification -> decode -> confidential policy simulation -> report through the simulator forwarder -> three human votes -> guarded Devnet payout.**

- [ ] The UI uses actual chain/runner state for payment authorization and outcomes.
- [ ] All required policy checks execute over the decoded payment, rather than a manually selected unrelated screening wallet.
- [ ] Valid payments execute once, and invalid or unavailable checks block payment.
- [ ] Human votes and Guard approval remain separate required gates.
- [ ] The end-to-end scenarios pass with saved evidence.
- [ ] Hosted demo, public repository and deck/video are ready.
- [ ] Simulation, real API calls and real Devnet writes are clearly distinguished in the demo and submission.

Simulation-only CRE operation is compatible with a Devnet hackathon demonstration: real RPC/API calls and explicitly authorized simulator broadcast can update real Devnet accounts, while DON consensus and the enclave are locally simulated. Non-broadcast simulation alone does not demonstrate an on-chain payment.

## Beyond this MVP

Production readiness is a separate project. It requires live DON deployment and membership/quorum verification, real confidential execution and attestation, verified intended-workflow provenance, security review/audit, protected authorities, reliable operations and incident recovery. These are not established by completing the local simulation demo. Daily/cumulative caps and other stretch features remain outside the frozen MVP unless separately agreed.
