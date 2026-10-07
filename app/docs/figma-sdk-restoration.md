# Figma and Squads restoration

Historical reference: Privy was replaced by direct Wallet Standard connection. See [current app workflow](../README.md).
Restore approved Figma frames 3:2, 3:164, 3:337, 3:476 and review 4:52 using existing shadcn components, original SVG exports, Inter, dark neutral surfaces and mint actions. Keep 240px sidebar, 72px header, 40px desktop gutters and page-specific content. Use truthful empty states rather than Figma sample balances or people.

Keep Privy wallet authentication and server RPC relay. Preserve Devnet verification, wallet-session checks, Squads proposal permissions, finalized reads, guarded execution and governance. Add a native SOL / classic SPL payment proposal form with exact decimal parsing and a local human-readable preview. Label previews separately from unavailable on-chain Guard decisions. No bypass of protected groups, program deployment, secret exposure or changes outside app.

Verify pure payment/preview adapters with SDK fixtures, existing unit tests, typecheck and browser tests for page layouts, mobile navigation, Privy sign-in and finalized proposal voting. Compare desktop renders against Figma. Browser fixtures are test-only, never product demo mode.

## First-visit treasury selection (7 Oct 2026)

Start with no selected treasury even when deployment configuration exists. Keep deployment settings available for guarded creation and explicit opening of the deployed treasury. Only a `?group=` link, a saved browser selection or a user open/create action selects a treasury. Existing empty dashboard states offer open/create actions without showing the shared test treasury's balances or history. Wallet connection alone does not select a treasury. Verify first visit with a configured deployment, saved selection and explicit links in browser tests.

## Guarded creation service errors (7 Oct 2026)

Guarded creation requires a running settlement service and matching server-only credentials. Report missing configuration, unreachable service, rejected service authentication and malformed service responses with fixed public messages. Preserve instruction validation and never include upstream response text, URLs or credentials in browser errors. A preparation failure must not sign or submit treasury creation.

## Shared decoder previews (7 Oct 2026)

Replace the app's instruction-byte parser with `@wysiwys/decoder`. Preserve exact stored VaultTransaction bytes and their canonical hash from chain reads; verify the binding before decoding, and compare the Guard Review hash when available. Drafts use the Squads SDK serializer. Render payment messages from returned actions and expose the JSON in technical details. Keep live token owner, mint, decimal and ATA derivation checks; decoder success alone never authorizes unsupported payment actions or creates a policy verdict. Build the decoder before app development, builds, tests and type checks.

## Individual member wallet fields (7 Oct 2026)

The creation dialog starts with one optional wallet-address input. Add wallet creates another row, and each extra row can be removed. Ignore blank rows in member and default approval counts; preserve the guarded 12-wallet limit and the opt-in standard group limit. Keep the dialog scrollable on small screens. Submit the trimmed address array through the existing creation flow.

## Phantom signing and outer transaction fees (7 Oct 2026)

Before wallet signing, add an explicit zero-price Compute Budget instruction to unsigned outer transactions that have no existing compute limit or price. Phantom documents automatic fee enhancement for unsigned transactions without such instructions, which otherwise trips the exact-message check. Keep the byte-for-byte signed message check and all stored payment instructions unchanged. Preserve caller-supplied budgets and partially signed treasury creation messages. Verify with a Phantom-style fee injection test, existing tampering and session-change tests, and browser proposal signing.

Reference: [Phantom priority fee requirements](https://docs.phantom.com/developer-powertools/solana-priority-fees).

## Historical standard treasury setup

The user explicitly approved standard Squads groups before Guard deployment. New groups use `multisigCreateV2` with creator permissions 7 (Propose/Vote/Execute), invitee permissions 3 (Propose/Vote), null configuration authority and the selected threshold. Existing guarded configuration remains isolated. Standard creation no longer calls the Guard service. Existing standard groups are verified from finalized Devnet state.

Keep Create group visible in the empty dashboard’s existing action area. Payment and configuration execution use the SDK, current on-chain permissions, Approved status, threshold and timelock checks. Re-read payment owners and compare to the displayed preview before approval or execution. Clearly label standard Squads groups and pending Guard integration; do not claim policy protection.
