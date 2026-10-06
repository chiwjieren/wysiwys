# Wysiwys repository and architecture audit

Audited local main after merge 421fa4e against docs/plans/architecture.md, docs/plans/architecture_diagram.png, AGENTS.md, the Guard interface, implementation sources, tests and CRE evidence. No application code, frozen interface, policy or deployment was changed. No commit or push was made for this audit.

## Overall finding

The repository contains substantial component implementations, not a working complete treasury firewall yet. Guard and decoder code, a listener/history service, a mock frontend and independent CRE diagnostics exist. The connections between them and the actual confidential policy/report decision remain unfinished.

The older statement that no multisig exists is now outdated: main contains deployments/devnet.json, and a fresh read-only finalized public Devnet RPC check confirmed the program, multisig, mint and vault token account exist. The recorded Guard config PDA has no account. The deployment record has guard=null. This verification establishes account presence and expected program ownership, not byte-for-byte deployed program equivalence or a fresh check of every multisig permission.

## Architecture coverage

| Stage | Implemented | Remaining or unverified |
| --- | --- | --- |
| 1. Propose payment | Next.js screens, dialogs and sample proposal interactions; bootstrap creates Squads infrastructure | App uses MockSettlementProvider, timers and sessionStorage. No actual wallet signing, Squads proposal creation, request-review transaction or authoritative chain reads are wired into the app. |
| 2. Guard request review | Four Guard instructions, Review state, proposer check, domain-separated hash, event and shared IDL | Guard config is absent on Devnet. No demonstrated application-to-Guard review request in the integrated demo. |
| Event adapter | Finalized WebSocket listener, cursor-based paginated backfill, event dedupe, SQLite history, outbound HTTP trigger and status/history endpoints | No authenticated POST /review simulation runner endpoint. Current CRE preflights use cron, so the outbound trigger has no matching review workflow. No verified deployed service evidence inspected. |
| 3. Multi-RPC / CRE | Three real providers passed native network-probe simulation. Per-node whole-snapshot 2-of-3 selection and outer consensusIdenticalAggregation are implemented. Failure cases are fixture-tested. | Default config has no account addresses and runs network-probe. No saved live Guard/Squads account quorum evidence. Need required-account discovery, expected owner/PDA/role checks, an observation hash, identifiers-only HTTP trigger and integration with decoding. |
| 4. Decode | Pure TS decoder supports payment and authority/nonce instruction descriptions, rejects malformed/unknown/unsupported inputs, and has real Devnet fixtures plus browser/CRE compatibility checks | Not imported by either current CRE preflight or the app. Upstream Review hash verification, downstream narrow-payment policy and destination token owner/mint resolution remain caller integration work. Decoder success alone is not policy approval. |
| 4. Confidential policy | Real Scorechain sanctions adapter; response validation; simulated TEE secret/API path; DON crossover; researched policy design | No private policy loader/decryption, wallet whitelist evaluator, allowed-mint/decimal/source-authority checks, payment caps, instruction allowlist decision, stable bound verdict or deterministic summary. Broader wallet-risk scoring is not supplied by the sanctions adapter. No policy.json or canonical policy-plus-decoder commitment implementation found. |
| 5. Report / receiver | Shared 181-byte payload codec, 64-byte metadata helpers, txHash, reasons and Guard receiver validation | CRE diagnostic report is EVM ABI-encoded screening text, not the shared Solana Guard payload. No Solana write/report delivery callback, receiver bindings, simulator mock-forwarder delivery evidence or combined approve/reject report. Actual intended-workflow provenance still needs proof. |
| 6. Human approval | Bootstrap and Guard test helpers implement Squads permissions and votes; multisig exists on Devnet | App votes are mock state. Real three-signer approval UI and integrated evidence are missing. |
| 7. Guarded payout | Guard checks approval, hash, expiry, destination facts and durable nonce; sole executor CPI and atomic execution status are implemented with tests | No initialized Devnet Guard config, integrated accepted report or real UI execution. No scripts/e2e-devnet.ts or recorded complete clean/lookalike/takeover/ownership-change demo through CRE. |

## Current Chainlink implementation

- Scorechain: workflow/confidential-preflight/confidential-check/scorechain-workflow.ts. Screening is real HTTPS but its address is configured independently of a decoded payout. It returns paymentAuthorized=false.
- RPC: workflow/confidential-preflight/confidential-check/rpc-workflow.ts and rpc-quorum.ts. Native evidence demonstrates all three providers' Devnet identity and finalized-slot connectivity. Account agreement tests use fixtures.
- Both callbacks use simulated TEE handlers; the RPC callback uses usingTheDons and a node-mode callback. This proves supported local composition, not a complete combined policy workflow, live DON quorum or enclave attestation.
- Generic account normalization validates a syntactically valid owner but does not check that each account has its expected Guard/Squads/Token owner and role. Downstream integration must do that before any approval.
- Whole-snapshot comparison returns canonical account contents but no distinct source observation hash yet. Payment tx_hash is a separate shared domain-separated binding and is not currently checked by these preflights.
- Scorechain and RPC remain separate diagnostic entry points. Neither can authorize treasury execution.

## Shared interfaces and security boundaries

packages/shared/src/report.ts owns the real Guard report format and txHash; the shared IDL and error/reason definitions exist. DecodedAction currently lives in packages/decoder and its consumer-boundary document explicitly marks the type provisional. Runner API types currently live in services/runner/src/store.ts. Those cross-component contracts still need reconciliation with the shared ownership rule before full integration.

Guard verifies workflow_owner in authenticated forwarder metadata. That is not a demonstrated guarantee that only one intended workflow under that owner can issue accepted reports. Prove the deployed forwarder provenance semantics before enabling live approvals; do not silently expand the frozen Guard interface.

LogTrigger treats a log-only action as successful, and listener health does not establish workflow availability. Configure and verify a real receiver, idempotency and authenticated trigger delivery before calling the runner connected. Server currently exposes GET /status and GET /reviews only. Local CRE endpoint variables use CRE_* names in the preflight environment file; the runner reads different root environment names. They are not automatically connected.

## Documentation differences to resolve

1. architecture.md and the diagram still propose RequestHead, generations/superseding and pause/admin behavior. AGENTS.md and the migration plan explicitly choose one permanent Review per transaction, immutable config and no pause/admin instruction. These are deliberate MVP decisions, not features to add without approval.
2. Some old implementation plan examples still use OTC hashes and a 107-byte payload. The current shared codec and Guard use the 181-byte treasury payload. Use shared code and the current interface spec, not stale examples.
3. guard-cre-interface.md and docs/spikes.md say no multisig exists. deployments/devnet.json and the live check show one now exists, while Guard config remains absent.
4. Decoder INTEGRATION_BOUNDARY.md says the repository has no CRE source/config. Preflights now exist, but decoder integration is still missing.
5. workflow/README.md describes the intended complete orchestration without indicating that current runnable entry points are independent diagnostics. AGENTS.md's bare workflow simulation command does not select either actual project/target.
6. App sample data and interaction rules still describe OTC trades/client-leg settlement. The current treasury architecture has no required Tron/Ethereum client-leg proof.

## Verification performed and limits

- Fresh finalized public Devnet getMultipleAccounts: Guard program executable and upgradeable-loader owned; multisig Squads-owned; mint and vault token account legacy-Token-owned; Guard config missing.
- Post-merge CRE verification already passed 54 confidential/RPC tests plus 3 starter tests, and both standalone TypeScript checks. Existing native logs prove real Scorechain requests, simulated diagnostic reporting and the three-provider network probe. These API simulations were not rerun during this audit.
- npm test was attempted across all root workspaces. Initial decoder suites passed, then the real-Devnet suite stopped because @sqds/multisig is missing locally. Shared, runner and app tests could not start because tsx is missing. Do not label the whole repository test suite passing.
- npm run typecheck: decoder and shared checks passed; runner/app failed on missing modules and workspace links. The host Node version reported by the run is 22.12.0, below the runner's declared >=22.13 requirement. This is a local setup verification blocker; source correctness is not settled by those failures.
- Anchor/local-validator security tests were not rerun in this audit. docs/spikes.md records 57 Guard tests passing before deployment. No new browser test, app production build, deployed binary comparison, hosted URL, deck/video or live DON/TEE check was performed.

## Recommended implementation order

1. Restore the current root/app dependencies and the runner's supported Node environment so integrated verification can run. Align stale docs with frozen MVP decisions without changing contracts.
2. Use the recorded Devnet identities for actual three-provider account reads. Add expected account ownership/PDA checks, discovery and observation hash; verify the Review hash before decoding.
3. Integrate @wysiwys/decoder into the actual CRE project. Define the supported single-payment policy adapter and destination facts using the existing shared report contract.
4. Implement the private policy loader and deterministic evaluator; add actual institution-approved policy values and real Scorechain screening of the decoded recipient wallet. Test clean, sanctioned, unlisted, excessive, wrong-mint, unknown-action and unavailable-service paths.
5. Replace cron-only diagnostics with authenticated review HTTP handling and connect the runner. Preserve distinct mock and live forwarder settings.
6. Encode the shared Guard payload, simulate the Solana delivery path, settle workflow owner/forwarder identity/policy commitment, then initialize Guard config only with approved exact values. Keep non-broadcast simulation as the current default; an actual delivery/write requires separate authorization.
7. Wire the UI to real chain/runner state and Squads actions. Prove and record all end-to-end scenarios. Live confidential access is needed for real TEE execution, not local simulation.
