# OmniCounter frontend implementation plan

Goal: implement the approved [Figma frontend](https://www.figma.com/design/z3l7IfdoF1dX25wUUwAhxd) in Next.js, Tailwind CSS and shadcn/ui.

Architecture: App Router pages share a persistent shell and a client mock settlement provider. Presentation models and sample records live in src/lib/mock; they are not shared protocol contracts. Replace this boundary with backend adapters later.

Constraints: modify app only; no Demo mode, wallet signing, RPC requests, secrets, protocol changes, commits or publishing. Match Figma colors, local Inter, 240px sidebar, 72px top bar, 40px desktop content insets, 16px dashboard section gaps and 24px review column gap. Mobile adapts navigation and tables.

- [x] Foundation: standalone app-local installation, design tokens, shadcn primitives, local Inter and original Figma SVG exports.
- [x] Mock behavior: tests first for approvals, rejection, expiry, voting, duplicate payout prevention and distinct execution/trade settlement states.
- [x] UI: dashboard, transactions, approved trades, members, settings, initiation/receive/status dialogs and review states.
- [x] Final verification: unit tests, TypeScript, formatting, production build, browser interactions, desktop comparison and mobile overflow.

Review fixes: derive status from current review state and expiry; block duplicate trade payouts; persist created proposals across navigation; begin mock decoding when its review becomes visible. Explicit local dev origins restore client hydration under Next.js dev mode.

Rulings: the approved Figma and explicit instruction to build authorize implementation. Plan, dependencies, artifacts and caches remain under app, overriding the repository's default plan location. npm runs with workspaces disabled to protect the root lockfile. The user's Helius/Alchemy/QuickNode and no-Demo-mode decisions supersede older repository wording.

Verification: 9 unit tests and 5 Chromium browser tests passed. TypeScript, formatting, production build and git diff whitespace checks passed. Screenshots were compared with Figma for dashboard, transactions, members, settings and review layouts. Seven desktop pages reported a 240px sidebar, loaded local assets and no horizontal overflow. Mobile navigation and review layout were checked at 390px. Browser tests also passed against the built production server.
