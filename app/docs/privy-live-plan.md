# Privy and live Squads implementation

Historical reference: Privy was replaced by direct Wallet Standard connection. See [current app workflow](../README.md).
Current behavior is documented in [Figma and SDK restoration](figma-sdk-restoration.md), including the user-approved Squads-first decision. Earlier Guard-only restrictions below are historical for new standard groups.

Scope: frontend branch, changes only inside app. No commits or pushes.

The user confirmed that the funded member deposits into the Squads vault. Human members retain Initiate and Vote permissions. The executor PDA alone has Execute permission; every payout goes through the existing guard. Deployment addresses come from deployments/devnet.json at runtime.

1. Add failing authentication tests, then verify ES256 Privy access tokens using the app's public JWKS. Require authentication for transaction submission and settlement preparation. The app secret is unnecessary for this flow and must not enter client bundles or tracked files.
2. Add failing SDK tests for exact decimal deposits, token ownership, and threshold instructions. Implement SOL and classic SPL deposits into the configured vault. Add config transaction reading and threshold proposals. A controlled multisig's existing config authority can set its threshold directly; ordinary config proposals cannot be executed by the current payout-only guard. Preserve that security constraint and explain it in settings.
3. Connect Privy wallet login, session refresh, linked Solana account selection, logout and transaction signing. Invalidate pending signing when the session or account changes. Use finalized devnet state and authenticated same-origin server routes.
4. Remove production mock records, fake signer identities, sample providers, scenario screens and simulated settlement actions. Missing deployment or integration produces an honest empty or unavailable state.
5. Verify unit tests, browser empty/error/auth boundaries, typecheck, formatting and production build. Request one read-only final review under the executing-plans skill, fix material findings, and report remaining deployment prerequisites.

Ruling: keep this plan and progress record inside app to respect the user's directory restriction. No root plans or shared contracts are edited.

Progress: planning and dependency installation started. Existing live SDK integration retained.

User flow update: replace the deployment placeholder with Create group and Open group. Groups are created on devnet with SDK multisigCreateV2, a selected threshold, and wallet-address invitations. No human receives Execute permission. The user reconfirmed that payouts for new groups remain locked until guard integration. Persist only public group addresses and names locally; membership, permissions and balances remain chain-owned. Share group links so invited wallets can open the same group. Subsequent membership changes are SDK governance proposals and must not receive a human execution bypass.

Review fixes: transaction-only entries are validated and skipped until proposalCreate; configured guard executors must be off-curve; session identity is rechecked after token refresh and before signing. Regression tests failed before each fix and now pass.
