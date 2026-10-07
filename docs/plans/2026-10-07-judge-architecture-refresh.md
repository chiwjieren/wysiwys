# Judge architecture refresh, 7 October 2026

## Goal

Produce an editable, precise architecture diagram for judges, following the three-column layout of `somethinglikethis.png`, and distinguish verified live behavior from the simulated confidential execution path.

## Review scope

Trace the application and wallet actions, shared contracts and decoder, Guard instructions, runner listener/gateway/policy store, CRE node callbacks and consensus, Solana report delivery, treasury permissions, configuration changes, deployment files, tests and recorded evidence. Do not read secret values or submit transactions.

## Findings before authoring

- `review/config.live.json` selects `execution: "don"`, with the production Keystone forwarder on Solana devnet.
- Recorded live execution evidence describes 10 participating nodes. The workflow does not configure the node count or a numeric DON consensus threshold.
- Every node health-checks QuickNode, Helius and Alchemy. CRE aggregates the slot floor and per-provider health flags by median. Every account read uses the shared minimum context slot and eligibility mask, requires 2 of 3 exact normalized snapshots per node, then uses CRE identical aggregation.
- The private policy first resolves from a Vault DON secret registry. If its commitment is missing, nodes fetch the document by hash from the authenticated runner store and verify the commitment, with identical aggregation.
- The live policy evaluation and Scorechain screening run on the DON. Live confidential evaluation is not deployed; the `handlerInTee` path is simulated.
- Guard authenticates the forwarder and workflow owner, records a decision, then execution independently requires a matching current-policy, unexpired, unused approval and live destination facts. Squads still enforces votes and timelock.
- Current main includes guarded membership changes and voted, delayed policy changes. These are separate management paths, not CRE-reviewed payment flows.
- The public runner health endpoint reports live mode, a subscribed listener and the production forwarder. The locally authenticated CRE account returned no workflows, so current control-plane status and node membership cannot be freshly verified through this login.

## Deliverables

1. Read-only verification evidence with public chain/runner results and explicit evidence limits.
2. A judge diagram in SVG, PNG and standalone HTML, plus a concise fact/source companion.
3. A current implementation overview linked from the architectural design reference, preserving the old conceptual design as historical.

## Validation

- Run existing shared, decoder, runner and CRE review tests and relevant type checks.
- Verify report transactions and decided Review state against public finalized devnet RPC when reachable.
- Before generating the replacement, check that the old diagram does not describe the current live DON path; after generation, assert the new diagram contains ten node illustrations, both approval gates and an explicit simulated-TEE label.
- Render and inspect the final PNG at presentation size. Check text fit, connector routing, layer boundaries, and the absence of private values.
- Keep shared contracts, program code, workflow code and live deployment state unchanged. Do not commit or push.
