# Wysiwys: verified live devnet architecture

Diagram: [PNG, 3840 x 2160](wysiwys-judge-architecture-live.png), [editable SVG](wysiwys-judge-architecture-live.svg), [standalone HTML](wysiwys-judge-architecture-live.html).

Reference layout: [somethinglikethis.png](../plans/somethinglikethis.png). Repo reviewed at `e3b8d2c`. Fresh verification: 7 October 2026, 11:55 UTC. Public results: [verification JSON](../../evidence/architecture/2026-10-07-live-verification.json).

## The explanation for judges

Three treasury members approve a payment in Squads. Independently, our Chainlink CRE workflow re-reads the stored payment: each node checks QuickNode, Helius and Alchemy and requires two matching account snapshots. CRE then reaches consensus over node outputs. The workflow verifies the exact transaction hash, decodes every instruction and checks the committed recipient, token, amount and sanctions policy. A DON-signed report reaches our Guard through the production Solana forwarder. The Guard can authorize Squads execution only while the review matches the transaction and current policy, is unexpired and unused, and the live recipient account still matches. Squads enforces the human votes and timelock. Review consumption and the payment succeed or roll back together.

## What was checked

| Claim | Basis | Scope |
| --- | --- | --- |
| A live workflow was deployed | `evidence/cre/2026-10-07-live-deploy.log` and subsequent redeploy logs; latest committed policy-fetch deployment names workflow ID `0007bda336f75bcb930240d5006341c6f4db26a868192ea8fc4377d1e43464d7`, Active, DON family `zone-a` | Recorded deployment evidence. This machine's authenticated CRE account returned no workflows; current control-plane status was not independently retrieved. |
| Ten participating nodes | `evidence/cre/2026-10-07-live-don-e2e.md` records health failures on 5 of 10 nodes, write-reply diagnostics on 10 of 10 nodes, and a successful run despite a provider failure on Node 8 | Ten nodes observed in recorded live runs. Current membership and a numeric BFT threshold were not re-enumerated. The diagram numbers are schematic, not operator identities. |
| Runner is serving the live path | Fresh `GET /status`: healthy, subscribed, `reviewPath.mode = live`, production forwarder | Live health read, not an SLA or proof every pending review will finish. |
| Production forwarder is configured for the live treasury | Finalized GuardConfig read for `deployments/devnet.live.json`; program and state match Chainlink's official Solana devnet directory | Fresh on-chain account read. |
| Clean payments actually executed | Live treasury Reviews at transaction indices 2 and 4 are `Executed`, reason 0 | Fresh finalized Review reads. |
| Lookalike payment was rejected | Live treasury Review at transaction index 3 is `Rejected`, reason 8 | Fresh finalized Review read. |
| Report receipts are finalized and successful | All three report signatures from the committed live evidence return `confirmationStatus = finalized` and no error | Fresh signature-status reads. The public app proxy does not expose `getTransaction`; CPI log details come from the recorded evidence. |
| Human approval and Guard execution are separate | Fresh live multisig read: threshold 3, three Vote members, executor PDA is the only Execute member, zero config authority | Fresh finalized Squads account read. |
| Live TEE execution is not enabled | `review/config.live.json` sets `execution: don`; `initWorkflow` selects `cre.handler` rather than `handlerInTee`; recorded live evidence explicitly states no TEE | Implementation/configuration and recorded evidence. No live enclave attestation is claimed. |

## Component and data flow

1. **Application and wallet.** Next.js uses Wallet Standard and the Squads SDK. For a guarded payment, it submits `vaultTransactionCreate`, `proposalCreate` and the runner-built `request_review` in one wallet-signed transaction. The payment itself stays stored until later execution. Off-chain claims and memo fields do not authorize it. The browser's decoder preview uses the same decoder package, but the on-chain Review is authoritative.
2. **Guard request.** `request_review` validates Squads account ownership and identity and requires the stored transaction's creator to sign. It creates one Review per multisig/index and hashes the full stored VaultTransaction account with its address. The Review is never closed.
3. **Event adapter.** The EC2 runner subscribes to finalized Guard logs, parses IDL events, backfills on startup and every minute, deduplicates events/reviews and retries failed triggers. SQLite stores activity history and private policy documents; its history cannot authorize execution. The active path is selected by an operator, and each treasury's on-chain forwarder determines which path can serve it.
4. **Authenticated CRE trigger.** `GatewayTrigger` sends JSON-RPC `workflows.execute` with `{ multisig, txIndex }`. Its JWT binds a digest of the canonical request and is signed by the configured EVM trigger key. The workflow's HTTP trigger uses `authorizedKeys`. These identifiers are not authoritative payment contents.
5. **Source health and context.** Each node checks the three provider domains, devnet genesis and finalized slots. CRE aggregates the shared minimum slot and each provider's 0/1 health flag by median. The resulting provider eligibility mask and minimum context slot are reused for the initial and destination reads. This median health aggregation is a change from the older diagram's identical eligibility-mask aggregation.
6. **Two agreement layers.** Per node, valid `getMultipleAccounts` responses are normalized into deterministic address/owner/data snapshots. At least two of three must match exactly. Failed transport/JSON-RPC responses do not count. CRE then applies identical aggregation to node outputs; this does not mean every node must respond or agree unanimously. The three providers are shared across all nodes, so there are three upstream provider fault domains, not thirty independent providers. A minimum slot is a freshness floor, not an atomic cross-provider snapshot.
7. **Decode and policy.** The workflow reads the Review, VaultTransaction and GuardConfig, verifies their identity and `tx_hash`, then uses `@wysiwys/decoder` and the review policy. The supported payment path is one System SOL transfer or one legacy SPL Token `TransferChecked`, to an existing valid destination token account. The policy checks program/instruction allowlists, vault authority, mint/decimals, per-payment caps and the recipient wallet whitelist. For SPL, the whitelist compares the token account's wallet-owner authority, not the owning Token program. Unknown or extra instructions fail closed.
8. **Policy resolution.** `POLICY_DOCUMENT` is a Vault DON secret containing a policy or registry. A matching commitment is selected using the treasury's current on-chain `policy_hash` and decoder version. If no entry matches, the workflow fetches `GET /cre/policies/:hash` from the authenticated runner store, verifies the commitment and requires identical aggregation in DON execution. Missing, wrong or unavailable documents cannot approve payment. The salted commitment is public; the policy content is not published by the application/report. Live DON node operators can nevertheless see it at execution time.
9. **Screening.** When configured by the policy and workflow, Scorechain sanctions screening runs in node mode and needs identical aggregated results. Unavailable or malformed screening responses cannot approve. The TEE variant performs its screening HTTP call and policy fetch inside the confidential handler.
10. **Report and receiver.** CRE produces a signed report and `SolanaClient.writeReport` submits it through the production Keystone forwarder. The 117-byte report payload contains verdict, reason, transaction/policy/destination hashes and issue/expiry times. Guard `on_report` authenticates the pinned forwarder state/program and signer PDA, the workflow owner, the Pending Review, the hashes and time bounds. It stores Approved or Rejected. It authenticates the configured owner, not a specific workflow ID.
11. **Execution.** Anyone may submit `guarded_execute`; the caller has no authority to change the stored payment. Guard verifies the instructions sysvar, rejects a durable-nonce wrapper, checks Review/PDA bindings, approval, current policy, time, exact transaction hash and live destination facts. It refuses executor or Guard accounts in the stored message. It writes Executed before signing the Squads CPI with the sole executor PDA. Squads enforces human approvals and timelock and signs for the vault. A failed CPI rolls everything back.

## Governance is a separate path

- **Policy changes:** members propose a strict marker transaction and vote in Squads. `apply_policy_change` checks approval, staleness, the expected old policy hash and the waiting period of `max(Squads timelock, 300 seconds)` on devnet. It updates only `policy_hash` and creates a permanent one-time PolicyChange record. It does not execute the marker through Squads, sign with the executor or ask CRE to approve the policy change. A payment approved under another policy hash cannot execute. The new policy is resolved by hash on subsequent reviews.
- **Membership, threshold and timelock:** voted config proposals use `guarded_config_execute`. Only permitted membership/threshold/time-lock actions pass. No added Execute members, executor removal, spending limits or rent-collector bypass. The sole executor is checked after CPI. Config changes are not CRE payment reviews.
- **Creation:** a new guarded treasury commits to its selected policy and initializes a multisig with human Initiate/Vote members and the Guard executor as the only Execute member. Standard groups remain an explicit opt-in feature outside the protected treasury path.

## Important treasury distinction for the demo

`deployments/devnet.live.json` identifies the verified live treasury. Its finalized GuardConfig matches the production forwarder and recorded workflow owner.

The original treasury named by `deployments/devnet.json` still has a **simulator forwarder on chain**, even though that file's `guard` initialization defaults now name the live forwarder. Its on-chain policy hash and workflow owner also differ from those file defaults. Those defaults are used for new initialization; they cannot change the existing treasury's configured forwarder. The active live runner correctly skips that old treasury. Open the verified live treasury or a new live guarded treasury for the judge demonstration. A runner mode switch does not migrate a treasury.

## Confidential path and remaining trust assumptions

The TEE implementation registers `onReview` with `handlerInTee` for AWS Nitro in `us-west-2`, uses `usingTheDons()` for public observations and report submission, and keeps policy evaluation and screening within the handler. It is built and locally simulated. Live Confidential Workflows require separate private-beta enrollment and attestation evidence. A private workflow registry is an authorization/management choice, not confidential execution. Source/binary and public outputs remain visible even in the current confidential model.

Guard is unaudited and its upgrade authority is controlled by the deployer during the hackathon. The receiver authenticates workflow owner rather than workflow ID. Policy changes are human-voted but are not screened by CRE. Per-payment caps do not impose cumulative budgets. Runner, policy store, shared RPC providers and screening API are availability dependencies; failures block payment. See [production gaps](../production-gaps.md).

## Validation

- CRE review: 82 tests passed; typecheck passed.
- Runner: 107 tests passed with Node 22's `--experimental-sqlite` flag. This machine runs Node 22.12, below the runner's declared minimum of 22.13. No runtime/dependency changes were made.
- Shared, decoder and runner typechecks passed; app typecheck passed.
- Shared: 37 tests passed. App: 149 tests passed. Decoder tests passed. No application or runtime source was changed.
- Guard local-validator tests and browser end-to-end tests were not rerun. Fresh public chain verification confirms the recorded live payment and rejection outcomes, rather than claiming a new end-to-end run.
- The old SVG failed the new ten-node-live-path content check before authoring. The replacement passed checks for ten schematic nodes, both agreement layers, execution gates, governance and explicit simulated-TEE/devnet labels.
- No live transactions, workflow updates, program upgrades, commits or pushes were performed for this review.

## Source map

| Component | Repository source |
| --- | --- |
| Wallet / stored proposal / guarded execution | `app/src/lib/squads/provider.tsx`, `payments.ts`, `execution.ts`, `decoded-preview.ts`; `app/src/app/api/squads/prepare/route.ts` |
| Shared hashes, report, policy, IDL | `packages/shared/src/report.ts`, `policy.ts`, `policy-change.ts`, `guard.ts`; `packages/shared/idl/wysiwys_guard.json` |
| Decoder | `packages/decoder/src/index.ts`, `packages/decoder/INTEGRATION_BOUNDARY.md` |
| CRE orchestration / consensus / decisions | `workflow/confidential-preflight/review/workflow.ts`, `rpc-quorum.ts`, `review-logic.ts`, `config.live.json`, `workflow.yaml` |
| Listener / trigger / acknowledgement / path selection | `services/runner/src/listener.ts`, `gateway.ts`, `delivery.ts`, `live-review.ts`, `mode.ts`, `path-filter.ts` |
| Private policy store / settlement preparation | `services/runner/src/store.ts`, `server.ts`, `settlement.ts`, `policy-seed.ts` |
| Guard enforcement / governance | `programs/wysiwys_guard/src/instructions/`, `logic.rs`, `constants.rs`, `state.rs` |
| Deployment / bootstrap / scenarios | `deployments/devnet.live.json`, `deployments/devnet.json`, `scripts/lib/bootstrap.ts`, `scripts/e2e-devnet.ts`, `deploy/ec2/` |
| Tests / recorded live evidence | `tests/`, package tests, runner tests, review workflow tests; `evidence/cre/2026-10-07-live-don-e2e.md` and deployment logs |

Official references: [CRE consensus](https://docs.chain.link/cre/concepts/consensus-computing), [Solana forwarder directory](https://docs.chain.link/cre/guides/workflow/using-solana-client/forwarder-directory-ts), [Confidential Workflows access](https://docs.chain.link/cre/account/confidential-workflows-access), [confidentiality boundary](https://docs.chain.link/cre/concepts/confidential-workflows).

## Rebuild

```powershell
node scripts/build-judge-architecture-live.mjs
node scripts/verify-live-architecture.mjs --app-proxy
```

The second command is read-only and requires network access. It reads public addresses and state; it never loads keys, environment files or policy documents. The builder uses saved brand assets whose source URLs are recorded in `assets/sources.json`.
