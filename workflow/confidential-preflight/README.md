# Wysiwys confidential and RPC preflights

This project uses the official Chainlink confidential workflow template as its foundation. Its current handler calls Scorechain's sanctions endpoint through the HTTPClient TeeRuntime overload. It never executes a payment or delivers a Guard report.

## Prerequisites

- Authenticated CRE CLI and Bun/Javy tooling.
- A user-supplied public Solana screening address in both target config files. The current address was supplied by the user.
- A Scorechain API key stored by the user in the gitignored project .env file under CRE_SCORECHAIN_SANCTIONS_API_KEY. Do not paste it into chat or put it into config/source. The agent never reads this file. The workflow-facing secret ID is SCORECHAIN_SANCTIONS_API_KEY; scorechain-secrets.yaml maps it to the distinct environment name.

The generated scorechain-secrets.yaml contains references only. A key previously disclosed in chat should be rotated before live use. Copy .env.example to .env only if no .env file already exists; preserve existing user configuration.

## Check and run

From confidential-check:

```powershell
bun test
bun run typecheck
```

From this project root:

```powershell
cre workflow simulate confidential-check --target local-simulation --non-interactive --trigger-index 0
```

The local target calls the real configured Scorechain endpoint, validates the response and returns a labelled screening conclusion. It returns before report generation. Do not add --broadcast.

After local screening passes, the staging-settings target tests the simulated DON report crossover:

```powershell
cre workflow simulate confidential-check --target staging-settings --non-interactive --trigger-index 0
```

Both targets are preflights only. No chain-write capability is invoked. Neither target is for deployment or activation.

## Result semantics

- SANCTIONED: a validated response contains a sanctions match.
- NO_SANCTIONS_MATCH: all validated entries explicitly contain isSanctioned=false. This is not a general wallet-risk clearance or payment approval.
- HTTP errors, missing credentials and unknown response schemas fail the execution. Empty arrays currently fail closed until Scorechain's no-match behavior has been verified.

The public result always contains paymentAuthorized=false. Attribution details, credentials and the raw response do not appear in logs or reports. There are no handler log statements. Provider errors are sanitized.

The official documentation shows an array example and describes a direct result object in its response table. Both shapes are supported with a required boolean isSanctioned. Live testing confirmed the direct object shape. Empty arrays and unknown formats still fail closed.

The simulated report is scoped to wysiwys:scorechain-sanctions-preflight:v1 and includes only the public wallet and screening conclusion. It is not the frozen Borsh Guard report and cannot authorize a payout.

## Limits and remaining work

Scorechain documents 100 requests/hour. This handler makes one request per invocation and disables response storage. It has no automatic retry loop. A five-minute cron is illustrative for preflight configuration; do not activate it as a production payment-review trigger. Normal Wysiwys reviews require their authenticated trigger and identifier bindings.

Local CRE uses a simulated TEE and single-node consensus model. This proves neither real enclave protection nor multi-node BFT. Wallet whitelisting, broader risk scoring, amount/mint/instruction policies and Guard integration are still separate work.

## Three-provider RPC diagnostic

The separate RPC entry point preserves the sanctions workflow. From this project root, run:

```powershell
cre workflow simulate confidential-check/rpc-preflight --target local-simulation --non-interactive --trigger-index 0
```

The default network-probe mode makes real HTTPS requests to QuickNode, Helius and Alchemy, checking the Devnet genesis hash and finalized slot on all three. It requires no multisig. Its output states accountQuorumVerified=false and paymentAuthorized=false. The native simulation passed with all three configured providers; evidence is in evidence/cre/2026-10-06-wysiwys-three-provider-probe.log.

rpc-secrets.yaml contains references only. The CLI resolves CRE_QUICKNODE_SOLANA_DEVNET_RPC_URL, CRE_HELIUS_SOLANA_DEVNET_RPC_URL and CRE_ALCHEMY_SOLANA_DEVNET_RPC_URL from the ignored local environment file. Never include the credential-bearing URLs in configuration or evidence.

For a subsequent actual account diagnostic, set operation to account-read and supply the required public account addresses in rpc-preflight/config.local-simulation.json. Missing required accounts fail closed. Two providers must match the entire ordered snapshot, including account address, owner, executable flag, lamports and canonical base64 data. RPC contexts may differ. Reads use finalized and a shared minContextSlot derived from the median validated finalized slot minus maxSlotLag, currently a configurable diagnostic preset of 32 slots. This is a relative provider freshness check, not a trusted independent clock or proof of malicious-provider tolerance beyond the assumed honest majority.

The workflow starts in a simulated TEE handler, obtains the regular runtime through usingTheDons, retrieves operational RPC secrets there and invokes runInNodeMode with consensusIdenticalAggregation. Real API connectivity and that runtime composition passed native simulation. Account quorum branches passed fixture-based tests; live multisig review remains deferred. No raw private policy or Scorechain credential crosses into the RPC callback. This preflight does not yet combine the RPC observations with Scorechain screening in a settlement decision.

Three RPC sources are independent provider checks inside each node callback. Local simulation runs that callback once. A live DON would aggregate node callback results; this run proves no multi-node BFT. No report, broadcast, chain write or payment execution exists in the RPC preflight.

[Scorechain documentation](https://docs.scorechain.com/sanctioned-addresses/endpoints/sanction)

Historical template simulation evidence remains in evidence/cre; it describes the former sample workflow, not the current Scorechain integration.
