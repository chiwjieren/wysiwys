# OmniCounter frontend

Next.js frontend for the OTC settlement firewall. The app integrates the [Squads v4 TypeScript SDK](https://docs.squads.so/main/development/typescript/overview) (`@sqds/multisig`) and Wallet Standard. Work in this directory with workspaces disabled; dependencies and generated files stay under `app/`.

```bash
npm install --workspaces=false
npm run dev
npm test
npm run typecheck
npm run format:check
npm run build
npm run test:e2e
```

Browser tests use port 3105 to avoid an unrelated app on port 3000. Install Playwright Chromium or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an existing Chromium executable.

## Squads integration

When deployment configuration is available, the dashboard, transactions, proposal inspection, members and settings screens use finalized Solana account reads. SDK reads validate owners, account discriminators, PDA derivation and proposal/transaction binding. The app derives the vault and proposal addresses with the SDK. Proposal indices remain bigint/string values; they are never rounded through JavaScript numbers.

Wallet Standard provides wallet discovery, connection, account selection, disconnect and transaction signing. The wallet must support `solana:devnet` and version 0 transactions. The app creates SDK approval, rejection and cancellation instructions, rereads permissions before signing, simulates via RPC preflight, submits and polls for finalized confirmation. It does not count a local click as a vote. A signed transaction whose message changes is rejected before submission. Wallet connection changes invalidate pending actions, including a signature returned after account switching or disconnect.

SOL and classic SPL token balances, member permissions, threshold, timelock, stored payout instructions and voter addresses come from chain. Mint addresses and token amounts are displayed without fabricated prices or token labels. Config transactions are omitted from payout listings. Pagination scans 20 transaction indices per page in one batched account read. Address Lookup Tables remain unsupported.

If no deployment file exists, the original Figma sample screens remain explicitly labelled Sample data. Sample proposals never sign or submit transactions. Invalid configured deployments and failed live RPC reads show errors, disable actions and never fall back to sample balances or approval records. `/squad` shows the integration configuration and links to the [Squads backup kit](https://docs.squads.so/main/additional-resources/what-if-the-squads-app-goes-down).

## Server configuration

All environment variables below are server-only. No private keys, RPC credentials or service tokens are sent to the browser.

| Variable                       | Purpose                                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `OMNICOUNTER_DEPLOYMENT_PATH`  | Absolute path to the bootstrap-owned `deployments/devnet.json`. Defaults to `../deployments/devnet.json` from the app directory.         |
| `SOLANA_RPC_URL`               | Devnet RPC URL, including provider authentication if required. Defaults to the public Solana devnet endpoint.                            |
| `OMNICOUNTER_SETTLEMENT_URL`   | Base URL of the backend frontend adapter for approved-ticket and guard instructions. Required for payout creation and guarded execution. |
| `OMNICOUNTER_SETTLEMENT_TOKEN` | Optional bearer credential for the settlement adapter.                                                                                   |

The deployment reader currently expects public `multisig`, `guardProgram`, `executor` fields and optional `vaultIndex` (default 0). Point it at the existing bootstrap output when that component is supplied. Do not create replacement addresses in frontend source. At runtime the deployment file must be present on the server; dynamic deployment paths are excluded from automatic build tracing.

The RPC proxy accepts only the methods needed by the frontend. Reads require finalized commitment. Browser writes require a matching Origin, request sizes are bounded and an instance-wide ceiling limits request volume. Provider error details are redacted. The app checks the devnet genesis identifier before live reads and submissions, and rejects a Squad that grants Execute to anyone except the configured executor.

## Guard integration boundary

This frontend does not expose direct Squads vault execution. Approved trade tickets and guard contracts belong to their existing components. The current branch does not contain the shared guard implementation, guard IDL or `deployments/devnet.json`, so a real guarded settlement cannot be verified from this branch alone.

The backend adapter must use the real shared contracts and finalized guard state. Its frontend preparation endpoints are separate from the frozen runner `POST /review` API:

- `POST <base>/frontend/propose`: input `{ multisig, txIndex, member, tradeId }`; return `{ payoutInstructions, guardInstruction }`. The service fetches the approved ticket, derives the exact classic SPL `TransferChecked` payout, computes hashes with `packages/shared` and builds the guard's `request_review` instruction for that index.
- `POST <base>/frontend/execute`: input `{ multisig, txIndex, member }`; return `{ guardInstruction }`. The service reads the actual Review and builds `guarded_execute`, including the required Squads CPI accounts. It must reject missing, rejected, expired or otherwise ineligible reviews.

Each instruction is serialized as `{ programId, keys: [{ pubkey, isSigner, isWritable }], data }`, where `data` is base64. These are app adapter transport records, not redefinitions of guard payloads, hashes, seeds or runner API types. The frontend verifies the guard program, selected multisig, transaction and proposal accounts and allowed signer before requesting a wallet signature.

For creation, the frontend combines SDK `vaultTransactionCreate`, active `proposalCreate` and the prepared guard review instruction in one transaction. Creation fails atomically if the guard request fails. Execution submits only the prepared guard instruction, so on-chain guard checks still gate the CPI into Squads. The SDK currently limits `proposalCreate` to safe integer indices and rejects larger values; reads and voting preserve the full u64 range.

Until the guard adapter is connected, live proposal screens explicitly say the guard verdict is unavailable. They do not fabricate a policy decision, client-leg proof, trade status or settlement summary. Payout creation and execution stay disabled without the adapter. A live devnet end-to-end test, guard verdict rendering and trade-system settlement evidence still require the owning backend components.

Config changes, generic treasury transfers, swaps, staking, batches, spending limits and rent reclamation are outside the settlement app's scope. They are not added merely because the SDK supports them.

## Verification

Unit tests cover permissions, duplicate votes, stale proposals, u64 indices, SDK proposal construction, guard bypass rejection, account ownership, signed-message integrity, deployment parsing, Origin checks and RPC restrictions. Browser tests exercise the existing sample design, live RPC failure behavior, Wallet Standard discovery and a signed approval using SDK-serialized accounts and ephemeral test keys. These tests do not claim that a deployed guard or CRE workflow has been exercised.
