# Privy and live Squads implementation

Scope: frontend branch, changes only inside app. No commits or pushes.

The user confirmed that the funded member deposits into the Squads vault. Human members retain Initiate and Vote permissions. The executor PDA alone has Execute permission; every payout goes through the existing guard. Deployment addresses come from deployments/devnet.json at runtime.

1. Add failing authentication tests, then verify ES256 Privy access tokens using the app's public JWKS. Require authentication for transaction submission and settlement preparation. The app secret is unnecessary for this flow and must not enter client bundles or tracked files.
2. Add failing SDK tests for exact decimal deposits, token ownership, and threshold instructions. Implement SOL and classic SPL deposits into the configured vault. Add config transaction reading and threshold proposals. A controlled multisig's existing config authority can set its threshold directly; ordinary config proposals cannot be executed by the current payout-only guard. Preserve that security constraint and explain it in settings.
3. Connect Privy wallet login, session refresh, linked Solana account selection, logout and transaction signing. Invalidate pending signing when the session or account changes. Use finalized devnet state and authenticated same-origin server routes.
4. Remove production mock records, fake signer identities, sample providers, scenario screens and simulated settlement actions. Missing deployment or integration produces an honest empty or unavailable state.
5. Verify unit tests, browser empty/error/auth boundaries, typecheck, formatting and production build. Request one read-only final review under the executing-plans skill, fix material findings, and report remaining deployment prerequisites.

Ruling: keep this plan and progress record inside app to respect the user's directory restriction. No root plans or shared contracts are edited.

Progress: planning and dependency installation started. Existing live SDK integration retained.
