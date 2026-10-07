# Wysiwys repository audit, 7 October 2026

Audited local main at 827d191. Compared current sources, shared contracts, architecture.md, architecture_diagram.png, whatsnext.md, the critical-path plan, tests and saved Devnet/CRE evidence. This supersedes the current-status findings of the 6 October audit; retain that file as historical evidence.

No implementation fix, dependency installation, deployment, broadcast, commit or push was performed. The new findings below are inspection results, not completed fixes. Private environment files, signing keys and the private policy document were not opened.

## Main result

The combined simulator-driven treasury flow now exists. The repo is substantially beyond the independent preflights described in the last audit. Guard initialization, policy hashing, actual CRE review/report delivery, runner endpoints and real Squads frontend integration are implemented. Recorded Devnet successes exist, but remaining code and verification gaps prevent calling the full MVP accepted yet.

## Completed or substantially implemented

| Component | Evidence and current behavior |
| --- | --- |
| Guard config | deployments/devnet.json now contains a guard block. Fresh finalized public Devnet reads confirmed the config exists, is Guard-owned and its policy hash matches the record. |
| Shared contracts | Payload v2 is 117 bytes and uses a domain-separated destination_hash. Guard, shared codec, IDL and consumers use this layout. Policy commitment is implemented in packages/shared/src/policy.ts and scripts/policy-hash.ts. |
| CRE review | workflow/confidential-preflight/review has an HTTP handler, Review/transaction/config reads, 2-of-3 provider matching, txHash check, decoder integration, private policy secret, recipient sanctions screening and Solana writeReport. |
| Policy decision | Narrow SOL/legacy TransferChecked rules, vault source/authority, allowed mint and decimals, per-payment cap, recipient whitelist, destination token owner/state and unsafe-instruction rejection are implemented. Summaries are deterministic text. |
| Report delivery | Saved native broadcast logs show clean approval, lookalike rejection and authority-change rejection delivered through the simulator forwarder. Fresh chain reads confirm the clean Review is Executed, lookalike Rejected reason 8 and drift Rejected reason 6. |
| Runner | CreRunner spawns the simulator without a shell, serializes runs, shares identical in-flight work, limits output, times out and redacts URLs. Authenticated POST /review, settlement instruction preparation, guarded group preparation, history and status endpoints exist. Listener uses the simulation runner in-process when configured. |
| Frontend | Wallet Standard integration, actual Squads operations, Guard request/execute preparation, on-chain review display, runner history/status, guarded treasury creation and deposits exist. Production mock state has been removed. Standard groups are opt-in and documented as unguarded. |
| Devnet application path | evidence/e2e/2026-10-07-ui-treasury-devnet.md records the app's builders creating a guarded treasury, depositing mUSD, proposing/requesting review, listener-triggered CRE approval, three votes and payout. Test keypairs stand in for browser wallets. |
| Scenario scripts | Propose/finish helpers, scenario builders and e2e-devnet.ts exist. The generic end-to-end reviewer is explicitly a local stand-in, separate from actual CRE evidence. |

Fresh read-only verification also confirmed the recorded Guard program and Squads multisig exist, and the configured forwarder state belongs to the simulator mock-forwarder program. This did not re-verify the deployed program binary or every treasury permission.

## Priority findings

### 1. Treat unsuccessful report delivery as a failed workflow

Locations: review/workflow.ts around lines 196-218; services/runner/src/cre.ts around lines 53-59 and 101-106; services/runner/src/listener.ts around lines 116-125.

After writeReport resolves, onReview returns its status, signature and error without checking for unsuccessful transaction or receiver execution. CreRunner judges success solely from process exit code and timeout. A capability response describing failed delivery can therefore be returned normally while the runner marks the trigger sent and stops automatic retries.

Guard remains fail closed if no valid report arrives. The gap is reliable review delivery and truthful operational success, not proof that an invalid payout can execute.

Required follow-up: validate the actual SDK success/receiver statuses, require a signature for a successful broadcast, handle dry-run semantics separately and confirm accepted Review state from chain. Add transport-result and runner tests for failure statuses, receiver rejection and missing broadcast signature.

### 2. Carry freshness and validated-provider state into destination reads

Locations: review/workflow.ts lines 76-87, 94-116 and 175.

The initial read validates Devnet genesis and finalized slots and sets minContextSlot. The subsequent destination read uses healthCheck=false, no minContextSlot and normalization floor 0. It also retries all endpoints, including any excluded by the first health check.

Required follow-up: preserve the common floor and usable provider identities for every policy-relevant read, or revalidate them within the capability budget. Add a stale destination-owner fixture and provider-exclusion test. Guard's execution-time destination recheck exists, but is not a reason to omit correct review-time freshness.

### 3. Enforce three independent configured providers in the actual review workflow

Locations: review/workflow.ts readAccounts and RPC secret handling; compare the original confidential-check/rpc-workflow.ts endpoint validation.

The review uses three named secret references but does not check distinct endpoints/hosts or provider identities. Copied endpoint values can be counted multiple times. This is a configuration-validation gap; the saved real-provider logs do not prove duplicate misconfiguration is rejected.

Required follow-up: validate independent HTTPS source configuration before requests and test duplicates without logging credential-bearing URLs. Preserve legitimate per-provider endpoint formats.

### 4. Expand actual handler and negative-path coverage

The 19 review tests exercise pure decision/parsing/payload logic and normalization/quorum. They do not invoke onReview or cover the real write-result handling. Original sanctions preflight tests cover API error schemas, but those tests do not automatically cover the separate screening implementation in review/workflow.ts.

Add tests around the actual combined handler: sanctioned recipient, malformed/empty screening response, API outage, policy mismatch, hash mismatch, elapsed deadline, no quorum, transport failure and receiver rejection. Confirm screening cannot be accidentally disabled for a demo claiming that control; current config screening=true is correct, but the schema permits false.

Broader wallet-risk scoring is still not implemented. Current Scorechain integration is sanctions screening; keep that distinction in product claims or separately agree the additional capability.

### 5. Improve runner readiness reporting

Listener.health and GET /status currently describe subscription and backfill freshness. They do not establish simulator configuration, login/capability readiness or successful recent review delivery. If neither simulator nor HTTP trigger is configured, LogTrigger still logs and returns successfully.

Required follow-up: distinguish listener health from review-runner readiness; do not mark log-only requests delivered. Verify retry exhaustion and restart behavior, and ensure queued reviews stay within their on-chain report deadline.

## Test results from this audit

| Check | Result |
| --- | --- |
| New review Bun tests | 19 passed. Pure logic/quorum coverage only. |
| Original confidential/RPC preflight Bun tests | 54 passed. |
| Starter Bun tests | 3 passed. |
| Review typecheck | Failed: installed local @chainlink/cre-sdk is unresolved for this new project; TextEncoder/TextDecoder declarations consequently remain unresolved. Restore its pinned dependencies and retest before identifying any remaining source issue. |
| Root npm test | Failed. Initial decoder suites passed, then missing @sqds/multisig/tsx and other local dependencies blocked the broader suite. Sandbox child-process errors were retried outside the sandbox; missing dependencies remain. |
| Root typecheck | Decoder/shared checks passed; runner/app checks failed with missing dependencies/workspace links and consequential type errors. |
| Runtime | Node is 22.12.0 here, below the runner's declared >=22.13 requirement. Bun is 1.4.2. |

76 Bun tests passed across the three projects. This is not a passing full-repository verification. No dependency install was performed, so the audit preserves the distinction between missing local setup and genuine code defects.

Native API/broadcast runs were not repeated. No new Anchor run, full app production build or browser suite was run because the current dependency setup blocks a meaningful complete verification. Existing evidence is useful but cannot replace reproducible checks of this checkout.

## Remaining acceptance work

- Repair the local dependency/toolchain setup, then run the full workspace checks, review typecheck/native dry run, app production build/browser tests and relevant Guard tests.
- Fix the delivery/freshness/provider-validation findings with tests before calling review processing reliable.
- Expand full CRE coverage of the negative acceptance matrix. e2e-devnet.ts uses scripts/lib/local-review.ts, a stand-in that has no multi-RPC quorum or Scorechain screening. Its larger scenario matrix must not be described as having all passed through CRE.
- The saved actual CRE broadcasts cover clean, lookalike and drift. Record actual CRE-path evidence for the remaining agreed cases and payment failure/replay behavior.
- Exercise the complete flow with real browser wallet signing. The current UI treasury evidence uses test keypairs invoking the app's builders and explicitly excludes real browser wallet signing.
- Verify the hosted frontend/runner setup and persistent service restart behavior. No public hosted URL, infrastructure deployment evidence, deck or video was established by this scan; assets may exist elsewhere.

## Document and contract cleanup

- whatsnext.md and the 6 October audit still state guard=null, missing review workflow/runner, mock UI and a 181-byte report. They are now outdated status descriptions. Convert the plan into a completed/remaining checklist using this audit.
- Current report is 117-byte payload v2. The actual raw report budget includes 109 bytes of forwarder metadata, 32 account-hash bytes and a 4-byte length, yielding 262 bytes. The previous 64+181 calculation was insufficient; use the current interface spec and saved spike evidence.
- architecture.md now has an implementation-status note explicitly superseding RequestHead/generation/pause/admin proposals. The illustration remains a design reference, not evidence of live DON BFT or attestation.
- guard-cre-interface.md still has an early row saying Guard config is not created. Its later section resolves the values, and the deployment/chain now show initialization.
- The critical-path plan retains old frontend/config gap descriptions even though several are resolved. Decoder INTEGRATION_BOUNDARY.md still says no workflow source exists.
- Cross-component type ownership remains incomplete: decoder actions and runner request types are still owned outside packages/shared. Reconcile this deliberately without unapproved frozen-interface changes.

## Simulation trust boundary

The configured simulator mock forwarder does not verify DON signatures and simulator metadata uses a common default owner. This demo configuration does not establish exclusive intended-workflow provenance and is not a production authorization boundary. Live DON consensus and real enclave attestation are still absent, as expected for the user's simulation-only scope.

Private policy is supplied through a secret inside the simulated TEE. No independent encrypted-policy-source/decryption service was found; do not claim a separate policy decryption system merely from the comment. No private policy values or signing/environment files were inspected for this audit.

## Recommended next action

Restore reproducible local checks, then address report-delivery success handling and follow-up RPC freshness first. Finish the actual CRE negative-path tests and real-browser demo evidence. Update whatsnext.md's completion state, then verify hosting and submission artifacts. The original implementation backlog is no longer a list of wholly missing components.
