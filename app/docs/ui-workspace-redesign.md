# Treasury workspace redesign

Work on the `ui` branch only. Refresh the full application shell, dashboard, transactions, members, settings, forms and review surfaces. Keep chain reads, decoder output, wallet signing and execution gates intact.

Use a graphite workspace with mint accents, compact navigation and calm cards. Preserve light mode. Use clear page titles, separate primary actions from contextual actions, and keep full decoded destinations visible in reviews. First use should explain creation, funding and review without showing balances or history from an unrelated treasury. Empty filtered results should offer a reset. Mobile navigation should include treasury switching.

Keep Radix focus handling and accessible labels. Add member fields individually, focus added fields and constrain dialogs to the viewport. Never infer a policy verdict from a successful decode. Avoid new fabricated financial data, private policy content or remote assets.

Validation: browser-first checks for onboarding, creation, mobile navigation, filters, desktop and light-mode screenshots; existing signing/decoder tests; source typecheck and production build. No commits or pushes without a user request.

Implemented the shared graphite and mint theme with light-mode tokens; redesigned the navigation, first-use dashboard, balance cards, transactions toolbar, member and preference panels, form fields and dialogs. Creation begins with one wallet field and focuses each added field. Filtered empty states reset search and status together. Review cards show exact amounts, full recipient wallets, token-account details and approval progress. Recipient rejection styling requires a successful single-payment preview plus the corresponding on-chain reason. The presentation helper does not authorize payments or infer private whitelist entries.

Verified 141 unit tests and 18 browser flows, including wallet-session changes, standard-group creation, proposal submission, execution, rejection details, mobile widths and light mode. Browser fixtures use SDK account serialization and the pinned Guard IDL, with ephemeral test keys and no real transactions. Existing signing tests now check the current compute-budget instructions and wait for actual execution rather than matching a progress label.
