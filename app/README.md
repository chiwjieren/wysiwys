# OmniCounter frontend

Frontend built from the approved [Figma design](https://www.figma.com/design/z3l7IfdoF1dX25wUUwAhxd) using Next.js App Router, Tailwind CSS and shadcn/ui. All implementation, dependencies, assets, tests and generated artifacts are contained in `app/`.

## Run

From `OmniCounter/app`:

```bash
npm install --workspaces=false --cache .cache/npm
npm run dev
```

Open http://localhost:3000. For a production preview, run `npm run build` and then `npm start`.

The app-local lockfile and installation keep the rest of the scaffold unchanged. Next.js and Playwright use app-local output directories.

## Pages

- Dashboard: holdings, pending payouts, recent activity and receive-assets dialog.
- Transactions: searchable payout proposals and approved trades.
- Review: decoding progress, client-payment evidence, plain-English transaction summary, claim comparison, guard checks, signer votes and payout execution status.
- Members: human signer permissions, the guard executor and the fixed threshold.
- Settings: treasury configuration, policy metadata, Helius/Alchemy/QuickNode status and appearance.
- Status and review states: infrastructure details, missing proof, destination mismatch, unavailable verification and separate execution/settlement states.

## Mock boundary and backend integration

`src/lib/mock/data.ts` contains clearly marked sample balances, trades, members, provider health, addresses and hashes. These are display fixtures, not deployment identifiers.

`src/lib/mock/types.ts` contains presentation models only. Use the existing `packages/shared` contracts when integrating backend data; this frontend does not redefine protocol payloads, reason codes or hashing.

`src/lib/mock/provider.tsx` is the replaceable adapter. It simulates decoding, confirmations and the listener's separate trade-settlement update. Sample proposals persist in session storage for this browser tab. Close the tab or remove `omnicounter.mock-payouts.v1` from session storage to reset them.

`src/lib/mock/settlement.ts` holds tested UI transition rules. Rejected, expired or unavailable reviews cannot execute. Execution requires verified evidence, a matching destination, an unexpired approval and all three votes. A trade with a confirming or executed payout cannot receive another payout.

The clock starts from the Figma fixture time, then advances while the page is open. During backend integration, replace fixtures, timers and session storage with authoritative chain and runner data. Refreshing currently resets the sample clock.

No wallet signing, transfers, RPC connections or backend endpoints are implemented. Provider indicators and explorer/detail dialogs show sample information. There is no Demo mode.

## Check

```bash
npm run test
npm run typecheck
npm run format:check
npm run build
PLAYWRIGHT_BROWSERS_PATH=.cache/browsers npx playwright install chromium
PLAYWRIGHT_BROWSERS_PATH=.cache/browsers npm run test:e2e
```

The browser suite covers page navigation, visible decoding before approval, execution and trade settlement, blocked reviews, unavailable verification, search and mobile navigation. Playwright reports and visual captures are ignored by Git.
