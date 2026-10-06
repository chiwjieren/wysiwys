# Figma and Squads restoration

Historical reference: Privy was replaced by direct Wallet Standard connection. See [current app workflow](../README.md).
Restore approved Figma frames 3:2, 3:164, 3:337, 3:476 and review 4:52 using existing shadcn components, original SVG exports, Inter, dark neutral surfaces and mint actions. Keep 240px sidebar, 72px header, 40px desktop gutters and page-specific content. Use truthful empty states rather than Figma sample balances or people.

Keep Privy wallet authentication and server RPC relay. Preserve Devnet verification, wallet-session checks, Squads proposal permissions, finalized reads, guarded execution and governance. Add a native SOL / classic SPL payment proposal form with exact decimal parsing and a local human-readable preview. Label previews separately from unavailable on-chain Guard decisions. No bypass of protected groups, program deployment, secret exposure or changes outside app.

Verify pure payment/preview adapters with SDK fixtures, existing unit tests, typecheck and browser tests for page layouts, mobile navigation, Privy sign-in and finalized proposal voting. Compare desktop renders against Figma. Browser fixtures are test-only, never product demo mode.

## Current Squads-first decision

The user explicitly approved standard Squads groups before Guard deployment. New groups use `multisigCreateV2` with creator permissions 7 (Propose/Vote/Execute), invitee permissions 3 (Propose/Vote), null configuration authority and the selected threshold. Existing guarded configuration remains isolated. Standard creation no longer calls the Guard service. Existing standard groups are verified from finalized Devnet state.

Keep Create group visible in the empty dashboard’s existing action area. Payment and configuration execution use the SDK, current on-chain permissions, Approved status, threshold and timelock checks. Re-read payment owners and compare to the displayed preview before approval or execution. Clearly label standard Squads groups and pending Guard integration; do not claim policy protection.
