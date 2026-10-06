# Wysiwys confidential payment policy proposal

Research date: 6 October 2026. Status: researched proposal, not implemented policy or an approved ABI change. Institution-specific thresholds, wallet entries, token identities and provider credentials have not been supplied.

## Research basis

Fireblocks describes institutional transaction controls across destinations and whitelisting, assets, amounts, origin accounts and approval requirements. These support a small treasury payment policy rather than a generic numeric score.

Sources:
- [Fireblocks transaction policy design](https://www.fireblocks.com/blog/designing-a-digital-asset-or-crypto-transaction-policy)
- [Fireblocks governance and policies](https://www.fireblocks.com/platforms/governance-and-policies)

Chainalysis Address Screening describes configurable category severities and exposure thresholds, direct and indirect exposure, and API rescreening. TRM describes wallet screening results containing risk attribution, volume percentages and screening timestamps. An institution's selected provider and methodology must define what a score means; different vendors' scores cannot be assumed interchangeable.

Sources:
- [Chainalysis Address Screening](https://www.chainalysis.com/product/address-screening/)
- [TRM Wallet Screening](https://www.trmlabs.com/blockchain-intelligence-platform/wallet-screening)
- [TRM screening API context](https://www.trmlabs.com/resources/blog/june-2025-product-highlights-upgrades-for-expanded-indirect-exposure-and-more)

## Proposed MVP rules

These are Wysiwys design recommendations based on the sources and the existing architecture, not a universal regulatory standard. All required checks must pass for approval; a whitelist does not bypass screening.

| Rule | Proposed deterministic check | Institution supplies |
| --- | --- | --- |
| Verified recipient whitelist | Exact chain and wallet match against an active approved record. For legacy SPL payments, validate the actual destination token-account owner authority and mint; do not compare only the token-account address. Pin the exact destination account when the policy requires it. | Approved wallet records and any destination-account restriction |
| Wallet risk and sanctions screening | Screen the verified recipient wallet using an explicitly supported provider/network. Block a confirmed sanctioned designation under the institution's configured screening policy; reject disallowed categories and exposure/risk levels. Keep direct and indirect exposure distinguishable. | Provider, supported network, category treatment, risk/exposure thresholds, accepted result age |
| Approved asset | Match the exact mint, token program and expected decimals. A symbol such as USDC is insufficient. Only explicitly permitted assets and programs qualify. | Allowed mint/program identities and decimals |
| Per-payment cap | Require a positive integer base-unit amount within the configured mint-specific cap and the approved payment amount where an authoritative payment record is part of the agreed flow. | Integer amount caps; authoritative payment-record source if used |
| Allowed payment actions | Permit only the supported transfer action and expected vault authority. Reject extra instructions, authority changes, nonce operations, unknown programs, unsupported token features and unresolved accounts. | Approved program/instruction set within the existing frozen policy layers |

The whitelist, asset and instruction rules already align with architecture.md. The SPL owner check and on-chain recheck are project security requirements, not claims about screening-provider functionality.

Do not invent sample live whitelist entries, a production USDC mint or a numeric risk-score cutoff. Demo fixtures will be explicitly synthetic. Screening a Devnet fixture is not proof of a provider's production risk coverage. Verify Solana support, endpoint schema, authentication, result scale, timestamp semantics and test-address behavior before integration.

## Validity and failures

These are validity requirements around the five rules, not additional approval shortcuts:

- Validate that a screening response is for the requested wallet and applicable network, from the configured provider, with a completed result and an acceptable timestamp. Missing, unknown, stale, future-dated or malformed required evidence cannot approve a payment.
- Compare timestamps against CRE's runtime time with an explicitly agreed tolerance, not a machine-local clock. Review expiry must respect policy validity and screening freshness, plus any authoritative payment expiry in the final contract.
- Load the policy version expected by the review/config binding. Do not silently apply a new policy to an old approval. A hash identifies rules but does not encrypt their contents or authenticate an arbitrary policy source.
- A timeout or unavailable screening service leaves the request blocked with an operational error. It must not manufacture a low-risk result or silently pass.
- Multiple applicable restrictions combine conservatively. An address being whitelisted never overrides a screening block or payment cap.

The enclave protects execution and confidential inputs. It does not establish that a screening vendor's classifications are correct, and the vendor necessarily receives whatever wallet is submitted to its API.

## Confidential execution boundary

Use the official handlerInTee/TeeRuntime path. Load policy data and screening credentials inside the confidential handler. Use the regular HTTPClient TeeRuntime overload for authenticated policy and screening calls. ConfidentialHTTPClient is a different feature and is not the client for a TEE handler.

Only the minimal non-sensitive conclusion and agreed transaction/policy bindings may cross through usingTheDons() into report generation. Do not export the full whitelist, private thresholds, provider credentials, raw exposure data or sensitive rationale. Remove confidential-handler production logs.

Source code and the deployed workflow binary are visible to the DON. Keep institution-specific rules as private runtime data rather than hardcoded source constants. Triggers and chain I/O remain outside the enclave boundary. Prove the composition of DON-agreed observations and the confidential evaluator before describing the full architecture as implemented.

Sources:
- [Chainlink confidential execution boundaries](https://docs.chain.link/cre/concepts/confidential-workflows)
- [Chainlink confidential runtime API](https://docs.chain.link/cre/reference/sdk/confidential-workflows-client-ts)

## Component placement

- packages/decoder: one pure deterministic evaluator for the existing DecodedAction model, policy inputs and normalized screening evidence. No networking or Node APIs.
- workflow: TEE policy loading, provider adapter, input validation, confidential evaluation orchestration and safe report handoff.
- packages/shared: any cross-component policy/evidence contract and reason/report schema, after explicit agreement. Do not redefine them inside the workflow.
- programs/omnicounter_guard: authenticate the forwarder, check current approved bindings and expiry, prevent replay, revalidate mutable destination facts and enforce atomic execution.
- Squads: human votes, threshold and timelock. The confidential policy does not replace votes.

The existing frozen report does not contain all the destination/version/generation fields proposed in architecture.md. Reconcile this gap before real report delivery. This research does not modify that report, seeds, reasons, immutable configuration or security rules.

## Deliberately deferred controls

- Daily or rolling aggregate caps: require an authoritative atomic reservation/counter mechanism. Stateless concurrent enclave approvals cannot safely reserve a shared budget.
- Amount-dependent signer thresholds: human approval enforcement belongs in the agreed Squads/Guard design; the current example remains 3 of 3.
- Fiat-value caps: require a separate reliable price source and agreed valuation/freshness rules. The MVP uses mint-specific base-unit caps.
- Full customer onboarding, Travel Rule, jurisdiction-specific legal determinations and post-payment monitoring: separate institutional integrations; do not describe this payment firewall as a complete compliance system.

## Mock-first acceptance cases

Use fake inputs and a fake confidential runtime, with no claim of attestation:

1. Whitelisted wallet, current acceptable screening, exact allowed transfer within cap: approve.
2. Unlisted wallet with acceptable screening: block.
3. Whitelisted wallet with a sanctioned designation: block.
4. Whitelisted wallet above an institution-configured category/risk/exposure limit: block.
5. Missing, unsupported, stale or failed screening: no approval.
6. Token account owned by a different wallet despite an approved-looking address: block.
7. Wrong mint, excessive amount, changed source authority or additional instruction: block.
8. Wrong policy binding: no approval.
9. Logs and public report contain neither policy data nor raw screening response.

The current nine template tests prove only sample template mechanics, not these Wysiwys cases.

## Migration after access approval

Preserve the same evaluator and fixtures. Replace fake policy/screening adapters with the authenticated policy source and supported real screening API, used through TeeRuntime. Supply secrets through the approved CRE secret mechanism without exposing values to the agent. Confirm the accepted TEE constraints for the organization's actual deployment.

First complete non-broadcast native simulation with dummy inputs. Then validate actual bindings, expiry and receiver checks. Live DON execution needs CRE deployment access; live confidential execution additionally needs confidential-workflow enrollment. Use the live Devnet forwarder configuration for live DON reports, separately from the mock-forwarder configuration. Capture real execution evidence before claiming enclave attestation or multi-node consensus.

Sources:
- [Confidential-workflow access](https://docs.chain.link/cre/account/confidential-workflows-access)
- [CRE deployment access and registries](https://docs.chain.link/cre/guides/operations/deploying-workflows)
- [Solana receiver and forwarder path](https://docs.chain.link/cre/guides/workflow/using-solana-client/onchain-write-ts)

No deployment, activation, secret upload, report ABI change or policy implementation is authorized by this research document alone. Institution-specific policy values and a screening provider remain required decisions.
