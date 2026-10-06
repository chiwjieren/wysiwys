# Wysiwys CRE verification plan

Wysiwys means "what you see is what you sign". This plan covers the Chainlink integration described in architecture.md. It does not replace the frozen interfaces in AGENTS.md.

## Verification order

1. Verify the official project-local Chainlink skill, CRE CLI, authentication and TypeScript toolchain.
2. Generate an isolated official hello-world TypeScript workflow under workflow/cre and prove a non-broadcast simulation. Do not proceed if compilation or execution fails.
3. Generate the official confidential workflow template and prove simulation with dummy data only. This proves the API path, not hardware isolation or enclave attestation.
4. Prove a composed node callback can query three Solana RPC providers, normalize required account contents and require two matching valid observations. Test conflicting, missing, stale and malformed observations before integration.
5. Prove the installed SDK can compose DON-agreed reads with confidential policy evaluation. Confirm runtime boundaries rather than assuming the architecture diagram is an exact API call graph.
6. Integrate the shared decoder and report contract only after reconciling architecture.md with the frozen contracts. Obtain approval before changing frozen interfaces, security rules or policy layers.
7. Prove non-broadcast report delivery using actual Guard bindings and configured Devnet identities. Keep mock and live forwarder paths separate.
8. Live DON execution requires deployment approval. Live confidential execution additionally requires confidential workflow access, currently pending. Do not claim multi-node consensus or hardware attestation from simulation.

## Boundaries

- No deployment, activation, uploads, broadcast, commits or pushes in this setup task.
- Keep private policy data and real credentials out of committed configuration and logs.
- packages/shared owns cross-component contracts; packages/decoder owns deterministic decoding and policy evaluation; the runner owns listening, retry and trigger delivery.
- Store successful and failed simulation evidence in evidence/cre, after checking it for sensitive output.
- Three-provider agreement is application logic. Real DON consensus is supplied by CRE and cannot be proven by local simulation.

## Devnet RPC prerequisite verification

- Read the multisig together with the Guard Review, Squads VaultTransaction and destination token account. A wallet sanctions screening address is not automatically the multisig address.
- No deployments/devnet.json exists yet, so the actual multisig and review identities remain required inputs.
- QuickNode documents https://docs-demo.solana-devnet.quiknode.pro/ in https://www.quicknode.com/docs/solana/getSupply. A read-only getGenesisHash request succeeded and matched the official https://api.devnet.solana.com endpoint: EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG.
- Helius documents https://devnet.helius-rpc.com/?api-key=<your-key> at https://demo.helius.dev/sandbox. Its public demo proxy returned HTTP 403 from this environment; do not count it as a working provider.
- Alchemy documents https://solana-devnet.g.alchemy.com/v2/<your-api-key> at https://www.alchemy.com/docs/reference/solana-api-quickstart. An account API key is required before live verification.
- Provider servers are remote. Local setup means configuring endpoint secret references for the simulator, not installing RPC nodes.
- Endpoint discovery does not prove the three-provider callback or quorum. Two public endpoints tested successfully; the requested QuickNode, Helius and Alchemy trio still needs account credentials and implementation verification.

### Three-provider implementation result

The user subsequently provided account endpoints for all three providers and deferred the multisig. A separate diagnostic was added to the existing official-template project. Native local simulation passed with real requests to all three, checking Devnet genesis and finalized slots, through a simulated TEE-to-DON-to-node callback. The normalized whole-account 2-of-3 quorum is fixture-tested; actual multisig reads remain deferred. See wysiwys-multi-rpc-plan.md and evidence/cre/2026-10-06-wysiwys-three-provider-probe.log. No frozen contract changes, reports, payments or deployment occurred.

## Current prerequisites

- Official skill installed locally in .agents/skills/chainlink-cre-skill.
- CRE CLI v1.37.0 verified after checksum and Authenticode verification.
- CRE login verified for organization originshack; deployment access is not enabled.
- Bun 1.4.2 exceeds the skill's documented minimum of 1.2.21.
- RPC credentials, private policy inputs and final Guard bindings remain integration prerequisites. Do not invent them.

## Preflight result

- Official hello-world template generated under workflow/cre/preflight.
- Dependency installation pinned CRE SDK 1.23.0 in the generated Bun lockfile.
- Javy v8.1.0 installed by the official cre-setup tool with checksum verification.
- The generated tests were normalized to six-field cron expressions. Three tests and TypeScript checking passed.
- Non-broadcast local-simulation passed and logged "Hello world! Workflow triggered.".
- CLI v1.37.0 requires at least one RPC URL even for this cron-only target. The local target uses the public Sepolia RPC entry supplied by the official template; the handler performs no chain reads or writes.
- Evidence: evidence/cre/2026-10-06-wysiwys-preflight.log.
- Basic CRE preflight gate passed. No live TEE or multi-node DON evidence exists yet.

## Confidential preflight and mock-first direction

- Official hello-confidential-workflows-ts template generated under workflow/confidential-preflight/confidential-check.
- Its dependencies pin CRE SDK 1.18.0, as supplied by the official template.
- Official template tests use a fake TeeRuntime to exercise secret retrieval, outbound request injection, verdict evaluation and the DON report crossover.
- Nine mocked tests and TypeScript checking passed. This does not prove Wysiwys policy integration, real enclave isolation or DON consensus.
- The first native confidential simulation attempt was interrupted. A later non-broadcast run passed with a dummy token, the official sample policy and the live echo endpoint.
- User selected mocks first while live confidential workflow access is pending. Keep mock outputs explicitly labelled and use dummy data only.
- Pending private-beta enrollment blocks live confidential deployment. Official documentation explicitly permits local confidential simulation before approval.
- Before integrating this template into Wysiwys, replace its sample score calculation and echo endpoint with the agreed deterministic policy and prove the combined runtime boundary.

## Native confidential simulation result

- Command from workflow/confidential-preflight: cre workflow simulate confidential-check --target staging-settings --non-interactive --trigger-index 0.
- Exit code 0; workflow compiled and simulated TEE trigger ran with the template's AWS Nitro/us-west-2 constraint.
- Output: "REJECT (score: 332, secret reached API: true)". REJECT is a successfully evaluated sample-policy verdict, not an execution failure.
- The official template uses TeeRuntime secret retrieval, HTTPClient in the simulated enclave path and usingTheDons for report generation. The full callback completed successfully.
- Only a dummy token was used. No Scorechain request, real private policy, chain write, broadcast, deployment or secret upload occurred.
- Evidence: evidence/cre/2026-10-06-wysiwys-confidential-preflight.log.
- Next gate: deterministic Wysiwys policy fixtures and the three-provider agreement tests, then their combined runtime composition. Provider credentials and institution-specific policy inputs remain prerequisites for live screening.

## Scorechain sanctions adapter

- Replaced the sample scoring and echo endpoint with the documented Scorechain HTTPS sanctions endpoint and TeeRuntime secret-backed x-api-key header.
- User-supplied public Solana address configured in both local-simulation and report-preflight targets.
- Test-first implementation: missing adapter test failed, then 21 adapter/handler tests and TypeScript checks passed. The tests cover documented arrays, explicit no-match records, errors, rate limits, malformed data, secret handling and absence of private output.
- Initial native execution compiled but stopped because the secret reference was missing. The user subsequently explicitly authorized adding the supplied API key to the gitignored local .env file; no credential values were printed or added to source/config.
- Updated the secret mapping to workflow ID SCORECHAIN_SANCTIONS_API_KEY and environment reference CRE_SCORECHAIN_SANCTIONS_API_KEY to avoid the CLI's self-referencing-name warning.
- Native local-simulation now passes with a real Scorechain HTTPS request for the supplied Solana address. Its screening result is SANCTIONED and paymentAuthorized=false.
- Live testing exposed a direct-object response instead of the documentation's array example. Added a failing regression test before supporting the direct object; all 22 tests and TypeScript checking pass. Empty/unknown responses remain blocked.
- The staging-settings native simulation also passes: the same real sanctions result completes the TeeRuntime-to-DON diagnostic report handoff. No report is delivered on-chain.
- Evidence: evidence/cre/2026-10-06-wysiwys-scorechain-live-local.log and evidence/cre/2026-10-06-wysiwys-scorechain-report-preflight.log.
- Local mode produces a diagnostic result and no report. Staging tests a diagnostic report only, not the frozen Guard payload. Both outputs explicitly state paymentAuthorized=false.
- Whitelist, broader wallet risk, amount/asset/instruction policy and Guard integration are not implemented by this sanctions adapter.
