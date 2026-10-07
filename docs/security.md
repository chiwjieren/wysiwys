# Guard security checks

Wysiwys is a treasury payment firewall on Solana devnet. Its executor PDA holds the sole Execute permission in a guarded Squads v4 treasury. A payment executes only with the treasury's human approval and a matching, current, unexpired, unused APPROVED review.

This document retains the detailed checks previously listed in the root README, updated for the current governance and live CRE paths. See the [architecture](plans/architecture.md) and [production gaps](production-gaps.md) for context.

## Payment and report checks

| Check | Enforcement and coverage |
| --- | --- |
| Pinned CPI target | Guard execution calls the pinned Squads v4 program. No general-purpose CPI entry point. [Execution tests](../tests/guarded_execute.ts). |
| Restricted executor signature | The executor signs only Squads vault or config execution CPIs. A payment message cannot reference the executor PDA, preventing its signature from reaching inner instructions. [Structure tests](../tests/structure.ts), [execution tests](../tests/guarded_execute.ts). |
| Explicit instruction surface | Six instructions: `initialize_guard`, `request_review`, `on_report`, `guarded_execute`, `guarded_config_execute`, `apply_policy_change`. No admin or pause instruction. [Program](../programs/wysiwys_guard/src/lib.rs), [structure tests](../tests/structure.ts). |
| Restricted config changes | Guard configuration is immutable except for a voted, delayed policy commitment change. A changed commitment invalidates payment approvals under the old policy. [Policy tests](../tests/policy_change.ts). |
| Durable-nonce rejection | Validate the instructions sysvar address and reject `AdvanceNonceAccount` at instruction zero of the execution transaction. [Execution tests](../tests/guarded_execute.ts). |
| Account identity | Validate owners, discriminators, seeds, multisig, transaction index and proposal binding. [Request tests](../tests/request_review.ts), [execution tests](../tests/guarded_execute.ts). |
| Exact stored transaction | Compute `tx_hash` on-chain when requesting review and recompute it at execution: SHA-256 of the `wysiwys:tx:v1` domain, vault-transaction address and complete account data. [Shared contract](../packages/shared/), [Guard logic](../programs/wysiwys_guard/src/logic.rs). |
| Permanent replay protection | Pending becomes Approved or Rejected; Approved becomes Executed. Reviews are never closed. Write Executed before the Squads CPI; failure rolls back consumption and payout together. [Report tests](../tests/on_report.ts), [execution tests](../tests/guarded_execute.ts). |
| Authenticated report delivery | Require the configured forwarder state, its pinned program owner and the signed authority PDA. Metadata must name the configured CRE workflow owner; transaction and policy hashes must match. This does not bind a particular workflow ID. [Report tests](../tests/on_report.ts). |
| Clock-based expiry | Use the on-chain clock to reject expired reviews. [Execution tests](../tests/guarded_execute.ts). |
| Exact report layout | Payload v2 is exactly 117 bytes. Validate version, verdict, reason, destination kind/hash, issue time and expiry bounds. Approvals require a supported destination kind and nonzero destination hash. [Guard logic](../programs/wysiwys_guard/src/logic.rs), [report tests](../tests/on_report.ts). |
| Explicit initialization | Use `init`, never `init_if_needed`. [Structure tests](../tests/structure.ts). |
| Safe treasury initialization | Require the Squads create-key signature and an autonomous multisig whose only Execute member is the executor PDA. [Initialization tests](../tests/initialize_guard.ts). |
| Proposer-bound request | Only the stored vault transaction's creator can claim its single Review PDA. [Request tests](../tests/request_review.ts). |
| Bounded report window | Require positive lifetime/deadline values. A report must arrive within the request deadline, may be issued at most 60 seconds ahead, and must expire within the configured maximum lifetime. [Initialization tests](../tests/initialize_guard.ts), [report tests](../tests/on_report.ts). |
| Live destination binding | Recompute the reviewed destination hash at execution. SPL destinations must retain the same address, legacy token program, mint and wallet owner, and must not be frozen. [Execution tests](../tests/guarded_execute.ts), [Guard logic](../programs/wysiwys_guard/src/logic.rs). |
| Restricted Squads governance | Voted configuration changes may add voters without Execute, remove members other than the executor, or change threshold/timelock. Reject spending limits, rent-collector changes and unknown actions; verify the executor remains the sole Execute member after the CPI. [Configuration tests](../tests/guarded_config.ts). |
| Delayed policy governance | Apply a voted policy change only after the configured waiting period, with a five-minute minimum on devnet. Policy changes have a separate governance path from CRE-reviewed payments. [Policy tests](../tests/policy_change.ts). |

## Trust assumptions and evidence

- **Squads** enforces the human threshold and timelock. A CRE verdict cannot replace either.
- **Live CRE path:** the demonstrated treasury in [`deployments/devnet.live.json`](../deployments/devnet.live.json) receives DON reports through the production Keystone Forwarder. See [live evidence](../evidence/cre/2026-10-07-live-don-e2e.md).
- **Simulator path:** the original treasury in `deployments/devnet.json` uses a mock forwarder that skips DON signature verification. Simulation and mock delivery do not prove live consensus or TEE execution.
- **Confidentiality:** the current live DON evaluates policy without a TEE. The Confidential Workflow path is implemented and locally simulated; no live enclave attestation is claimed.
- **Data agreement:** every node uses the same QuickNode, Helius and Alchemy providers. Ten observed DON nodes do not represent thirty independent RPC sources.
- **Policy governance:** members who meet the voting threshold can change the policy after the wait. CRE does not screen the policy change itself.
- **Upgrade authority:** the deployer retains the Guard upgrade key during the hackathon. The Guard is unaudited. These assumptions must be addressed before production use.

These are checks in the current implementation, not an audit certification. See [production gaps](production-gaps.md) for operational risks, provenance limits and unsupported payment types.
