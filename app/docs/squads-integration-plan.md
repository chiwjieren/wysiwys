# Squads frontend SDK integration

Historical reference: Privy was replaced by direct Wallet Standard connection. See [current app workflow](../README.md).
Current behavior is documented in [Figma and SDK restoration](figma-sdk-restoration.md), including the user-approved Squads-first decision. Earlier Guard-only restrictions below are historical for new standard groups.

Historical plan. The current frontend requirements and verification are tracked in [Privy and live Squads implementation](privy-live-plan.md). Production mock screens and Wallet Standard session handling have been replaced by live states and Privy authentication.

Goal: make the existing frontend interact with Squads v4 on devnet, independently of the official Squads UI. All edits stay in app on frontend. No commit or push.

Architecture: an app-local SDK adapter reads Multisig, Proposal and VaultTransaction accounts through a restricted server RPC proxy. Wallet Standard signs in the browser; keys remain in the wallet. A live provider supplies chain state to the dashboard, transaction and member screens. The existing sample screens remain explicitly labelled when deployment configuration is absent. Live read errors never fall back to sample records.

Guard boundary: no direct Squads execution is exposed. Existing deployment addresses are loaded from deployments/devnet.json through a configured absolute path. Because shared guard contracts, IDL and deployment records are absent in this branch, a configured settlement service must provide the approved-ticket instructions and guard instruction. SDK creates the VaultTransaction and active Proposal atomically with request_review. Guarded execution accepts a single guard instruction only. This frontend does not redefine guard seeds, hashes, report payloads or reason codes. Live functionality fails closed when the boundary is unavailable.

Scope covers treasury balances, member permissions, threshold, timelock, proposal pagination, account inspection, connected-wallet voting, rejection, cancellation, guarded trade proposal and execution, transaction confirmation, refresh and explorer links. Config changes, arbitrary transfers, swaps, staking, batches and rent reclamation are outside OmniCounter scope.

- [x] Tests first: permissions, duplicate votes, bigint indices, SDK-generated proposal instructions, execution bypass rejection and RPC method restrictions.
- [x] SDK adapter: finalized account reads, owner and PDA checks, voting/cancellation, atomic payout proposal and guarded execution builders.
- [x] Server boundary: deployment config, restricted RPC proxy and settlement instruction adapter with server-only credentials.
- [x] UI: Wallet Standard connection, live dashboard/transactions/members/settings, explicit loading/error/confirmation states.
- [x] Verify: app unit suite, TypeScript, formatting, production build and browser regressions, then review app-only diff.

Process ruling: the user's explicit request authorizes this implementation. Existing plan restrictions on wallet/RPC changes are superseded. Native execution keeps changes in this session; no automated commits. Deployment and guard integration require the owning components to supply their existing contracts, rather than inventing frozen interfaces here.

Sources: https://docs.squads.so/main/development/typescript/overview, https://docs.squads.so/main/development/typescript/accounts/proposal, https://docs.squads.so/main/development/reference/permissions, https://docs.squads.so/main/development/typescript/instructions/execute-vault-transaction, and the installed @sqds/multisig TypeScript declarations.

Final review: two important findings were reproduced and fixed. Proposal page reads now fetch all 20 account pairs in one finalized RPC call, verified by an SDK-serialized account test. Pending wallet actions use a connection epoch checked before and after signing; connect, disconnect, account selection, account events, unregister and unmount invalidate the epoch. The browser race test emits an account change while the signature response is pending and verifies that RPC submission never occurs. No minor findings were deferred.

Owning-component limitation: deployment addresses, guard Review decoding/summary and an approved-ticket settlement adapter are absent on this branch. The frontend transport boundary is implemented and fails closed; actual devnet guarded settlement remains unverified until those components are supplied. Frozen guard and runner contracts have not been changed.

Verification: npm test, npm run typecheck, npm run format:check and default npm run build pass. All 10 Chromium browser tests pass, including both reviewer regression cases. Final git diff whitespace checks pass. Changes remain uncommitted on frontend and all tracked/untracked deliverables are under app.
