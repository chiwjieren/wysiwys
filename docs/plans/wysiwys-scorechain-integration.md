# Wysiwys Scorechain integration and remaining controls

Research date: 6 October 2026. Status: implementation proposal, not a tested live integration. No request has been made using the credential shared in chat. Rotate that credential and supply its replacement through user-controlled secret storage.

## Verified Scorechain contract

The supplied official documentation specifies:

- Host: https://sanctions.api.scorechain.com
- Method/path: GET /v1/addresses/{address}
- Authentication header: x-api-key
- Limit: 100 requests per hour; excess requests return HTTP 429.
- The endpoint checks whether the address appears in an official sanctions list. Its documented example is an array with isSanctioned and nested details containing attribution, designation date and blockchain.

Sources:
- [Endpoint documentation](https://docs.scorechain.com/sanctioned-addresses/endpoints/sanction)
- [Sanctions API overview](https://docs.scorechain.com/sanctioned-addresses/getting-started)

The overview claims broad protocol coverage. Verify actual Solana address handling and Devnet test behavior before claiming a Solana integration is proven. This endpoint does not document a general wallet-risk score or direct/indirect exposure metrics. Scorechain offers broader screening separately; product coverage alone does not prove this API key has that entitlement.

## Verification gate before live use

1. User rotates the disclosed credential and stores the replacement without sending it to the agent.
2. Confirm the secret reference is available to the local simulation CLI. The agent must not read or print the value.
3. Confirm success, non-sanctioned, invalid-address, authentication-error and rate-limit behavior with the actual service. Use public test addresses or agreed fixtures, never actual funds.
4. Resolve the difference between the documentation's response table and its array/nested-details example. Confirm whether empty arrays mean no match or missing evidence. Until confirmed, empty/unknown responses cannot authorize a payment.
5. Validate the response against the requested wallet. Check relevant chain attribution when provided. Do not fabricate a timestamp: sanctionDate is a designation date, not the time the database was refreshed.
6. Record retrieval time using CRE runtime time. Provider freshness, any cache lifetime and review expiry must follow the agreed policy. A recent HTTP response alone does not prove the provider's underlying database was recently updated.
7. Fail closed on transport errors, non-success status, malformed data or missing required evidence. Bounded retry on 429/temporary failures must respect the provider quota; never retry indefinitely or substitute a clean result.

## How to fulfill the other policy controls

| Control | Input source | Evaluation inside confidential handler |
| --- | --- | --- |
| Recipient whitelist | Institution-owned approved-wallet records | Exact wallet and chain match, record active; compare legacy SPL destination account's actual wallet owner |
| Sanctions screening | Verified Scorechain sanctions adapter | Block a relevant sanctioned match; unknown/error is not a pass |
| Broader wallet risk | Licensed supported risk API, or explicitly labelled fake evidence during mock development | Apply institution-specific category, risk and exposure criteria using the selected provider's documented scale |
| Approved asset | Institution's allowed mint/program/decimals records plus decoded account facts | Exact identifiers match, no symbol-based authorization |
| Per-payment cap | Institution's mint-specific integer base-unit cap | Positive amount within cap; do not assume fiat value or token price |
| Allowed payment instructions | Existing program/instruction allowlists plus complete decoded action sequence | Only the approved transfer shape, expected authority and supported accounts; reject hidden or unknown operations |

Thresholds and whitelist entries come from the institution, not Scorechain. The policy evaluator consumes authenticated facts, never the proposer's claim or a memo as authority.

## Secret and confidentiality design

Use SCORECHAIN_SANCTIONS_API_KEY as a proposed secret identifier, mapped to a user-controlled environment reference for simulation and to the appropriate CRE secret mechanism for live execution. No credential values belong in config, source, tests, documents or logs.

For the small demo policy, a proposed POLICY_DOCUMENT secret can hold the institution's private policy JSON. Alternatively, load a versioned policy through authenticated HTTPS inside the enclave. Choose and validate one mechanism before implementation; the policy schema is not frozen here. The document must identify the intended institution/vault and expected policy version/commitment. A private input must still be authenticated and bound to the correct review.

Inside handlerInTee, obtain secrets using TeeRuntime.getSecret and call Scorechain using the regular HTTPClient's TeeRuntime overload. Evaluate the whitelist, sanctions response, supported risk evidence and transaction rules inside that handler. Export only the agreed bound verdict and safe reason using usingTheDons. Keep raw response data, private policy values and credentials inside the boundary. The third-party API still sees the wallet sent to it.

Source: [Official confidential runtime API](https://docs.chain.link/cre/reference/sdk/confidential-workflows-client-ts).

Current local execution is mocked or simulated, not a real enclave. Do not claim real sanctions coverage or real wallet-risk assessment from a fixture. Do not treat sanctions-only screening as equivalent to complete wallet-risk screening.

## Implementation order

1. Agree on policy schema and provider/evidence semantics without changing frozen interfaces.
2. Add deterministic mock tests for each of the institution's controls and failures.
3. Implement the evaluator once in packages/decoder; put any shared contract in packages/shared only after agreement.
4. Add the Scorechain sanctions adapter, first with fixtures matching its confirmed schema, then with the replacement key consumed opaquely by the runtime.
5. Supply approved demo wallets, deployment-owned mint/program identities, amount cap and screening validity settings. Do not invent live identities or thresholds.
6. Complete native confidential simulation and prove the DON-read/confidential-evaluation composition.
7. Reconcile the report ABI and Guard destination recheck requirements before report delivery.
8. After required access approvals, migrate secret references and adapters to live confidential execution and the live Devnet forwarder. Capture actual execution evidence.

The sanctions adapter now passes 22 tests, TypeScript checks and native local CRE simulation with a real Scorechain request. The supplied wallet returned SANCTIONED. Live testing confirmed a direct isSanctioned result object, now supported alongside the documentation's array example. The key is local and gitignored. This verifies sanctions lookup only; full wallet-risk coverage, other Wysiwys policies, multi-RPC reads and Guard integration remain pending. The original sample-template evidence remains historical.
