# Wysiwys three-provider diagnostic

Extend the existing official confidential-template project with a separate receiver-free RPC preflight. Preserve the proven Scorechain workflow. No frozen interface changes.

1. Store user-authorized endpoint URLs only in the ignored environment file; configuration contains secret IDs only.
2. Write and run failing tests for normalized account snapshots and 2-of-3 agreement, including missing accounts, malformed responses, wrong network, stale contexts, unsafe integers, one outage and conflicting data.
3. Each CRE node callback checks each provider's genesis hash and finalized slot. Read required accounts with finalized commitment and a common minimum context slot derived from the median provider slot. A diagnostic maximum lag of 32 slots is configurable and is not an institutional policy threshold.
4. Require two providers to match the entire ordered account snapshot. Never combine separately voted fields or include provider-specific context slots in the agreed snapshot. Check canonical base64 data, owner, executable, lamports and byte length. Fail closed on a missing required account.
5. Return canonical snapshot JSON through CRE consensusIdenticalAggregation. Local execution has one simulated node; source quorum is separate from DON consensus.
6. Until a real multisig address is supplied, run network-probe mode. This requires all three providers to pass identity/connectivity checks but does not claim account quorum, decoding, or payment authorization.
7. Run native non-broadcast CRE local simulation, save sanitized evidence. Then exercise account quorum against actual configured identities when available.

The three-provider callback is an isolated diagnostic alternative to the current AGENTS.md native-SolanaClient plus NOWNodes integration. It does not silently replace that production requirement. TEE composition and Guard bindings are subsequent gates.

Sources: https://docs.chain.link/cre/reference/sdk/http-client-ts and https://solana.com/docs/rpc/http/getmultipleaccounts. Devnet genesis hash was verified against the official public RPC and QuickNode on 2026-10-06: EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG.

## Verification result

- User supplied all three remote endpoints and explicitly deferred the Squads multisig for this phase.
- Pure snapshot tests first failed because the module did not exist, then passed after implementation. CRE callback tests likewise failed before implementation; the fake capability payload was corrected to match the installed SDK's protobuf bytes and duration representation.
- Native command from workflow/confidential-preflight: cre workflow simulate confidential-check/rpc-preflight --target local-simulation --non-interactive --trigger-index 0.
- Exit code 0. All three real providers returned the verified Devnet genesis hash and a valid finalized slot. Log: Devnet RPC probe passed: QuickNode, Helius, Alchemy. Account review not performed.
- Proven local composition: handlerInTee -> usingTheDons -> DON secret retrieval -> runInNodeMode -> three-provider HTTP requests -> consensusIdenticalAggregation -> simulated TEE result.
- Evidence: evidence/cre/2026-10-06-wysiwys-three-provider-probe.log. No credential-bearing URLs appear in it.
- Account snapshots and source disagreement are fixture-tested. No actual multisig account quorum, combined sanctions policy decision, live TEE attestation or live DON BFT is claimed.
