# @wysiwys/app

Next.js web app: dashboard, transactions, review (verdict + summary + claim vs decoded reality), members, settings and /status. Propose, request review, vote and guarded execute.

The `ui` branch refreshes the full treasury workspace: navigation, onboarding, balance cards, transaction filters, members, preferences, forms and payment reviews. Full decoded recipient addresses remain visible, rejected destinations are marked using the on-chain verdict, and mobile dialogs stay inside the viewport. See [UI redesign plan](docs/ui-workspace-redesign.md). Screenshots use isolated browser fixtures; the product never substitutes those for chain data.

## Run

```bash
npm install --workspaces=false
npm run dev
npm test
npm run typecheck
npm run format:check
npm run build
npm run test:e2e
```

Run these commands from `app/`. Browser tests use port 3105 and ephemeral test wallets. Install Playwright Chromium or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an existing Chromium executable. Generated files stay in this directory.

## Creating a guarded treasury

Click **Create treasury** (dashboard, or **Open or create a group**). Enter a name, the other member wallets (up to 10; every entry must be a wallet address, and your connected wallet joins automatically) and the required approvals (default: every member; any value from 1 to the member count).

What happens:

1. The app generates an ephemeral `createKey` and asks `POST /api/squads/groups` (wallet-signed request) to prepare protection. The route forwards `{ multisig, creator, createKey }` to the runner (`POST /frontend/groups/prepare`), which returns the guard's `initialize_guard` instruction.
2. The route and the browser both validate it: guard program (the deployed one), exact account order and flags (multisig, create key signer, config PDA `["config", multisig]`, executor PDA `["executor", multisig]`, creator as payer, system program), only the create key and creator sign, and the forwarder, policy hash and review lifetimes equal the deployment's `guard` block.
3. Your wallet signs **one transaction** with two instructions, also signed by the `createKey`: Squads `multisigCreateV2` (humans get Propose and Vote, the guard executor PDA is the sole Execute member, no config authority, no timelock) and `initialize_guard` (the immutable `GuardConfig`). Both land or neither does. Your wallet pays fees and rent.
4. The app opens the new treasury; the groups route now finds it guarded through the runner (`GET /frontend/groups/:multisig`).

**Membership changes.** Member changes need the members' vote and are checked by the guard. Squads applies member, threshold and time lock changes through config transactions, which need a member with Execute; in a guarded treasury that is only the guard executor, which applies them with `guarded_config_execute`.

1. **Invite member** (Members page), **Remove** (per member row) or **Propose threshold change** (Settings) creates a Squads `configTransactionCreate` + `proposalCreate`, signed by a member with Initiate. New members always get Initiate + Vote, never Execute. The guard executor is never offered for removal. A removal that would leave fewer voters than the threshold also lowers the threshold to the remaining voter count in the same proposal, and the dialog says so.
   **Edit** (per human member row, never the guard executor) has three independent parts. _Name_ saves a display label for that wallet in this browser only (`localStorage` key `wysiwys.memberNames`, per treasury and wallet; no transaction); it replaces "Member N" in the member lists. _Replace wallet_ (an on-curve wallet that is not already a member, the executor or the vault) proposes `AddMember(new wallet, the old member's permissions without Execute)` then `RemoveMember(old wallet)`. _Permissions_ (Initiate + Vote, Vote only or Initiate only, never Execute) proposes `RemoveMember(wallet)` then `AddMember(wallet, new permissions)`. Changing both proposes `AddMember(new wallet, new permissions)` then `RemoveMember(old wallet)`. Each is one config proposal; Squads applies all actions and checks its invariants at the end. As for removal, a change that leaves fewer voters than the threshold puts `ChangeThreshold` first, and a change that leaves no proposer or no voter (or, in a standard group, no executor) is refused. The dialog lists exactly what will be proposed (for example "Replace A4bB…zr37 with 9xQe…k2Lm (Initiate + Vote)", "Change Member 1 to Vote only", "Threshold lowers from 3 to 2"). Standard groups get the same Edit, executed directly.
2. Members vote as for any proposal. The review screen decodes every config action (add or remove member, threshold, time lock) and summarises member edits ("Change permissions of X to Vote only.", "Replace X with Y (Initiate + Vote)."). Any action the guard refuses (Execute permission, adding or removing the executor, spending limits, rent collector) is flagged "The guard will refuse this change" and cannot be approved or executed from the UI.
3. Once the Squads proposal is Approved (current, time lock elapsed), **Execute through guard** asks `POST /api/squads/prepare` with action `configExecute`. The route forwards `{ multisig, txIndex, member }` to the runner's `POST /frontend/config-execute` and validates the returned instruction like `execute` (deployed guard program, the open group's multisig, config transaction and proposal accounts, the member as the only signer). The wallet signs it with a 400,000 compute unit limit. The member pays any rent when adding a member grows the multisig.
4. No Chainlink review is involved. The guard checks every action on-chain (voters only, no spending limits) and that its executor remains the sole Execute member afterwards; Squads checks the approval, staleness and time lock. Executing a config change makes older pending proposals stale, as in any Squads multisig.

**Funding.** Use **Receive** to deposit SOL or the treasury token (mUSD, 6 decimals) from any connected wallet. A token deposit creates the vault's associated token account idempotently (the depositor pays) and then sends a `TransferChecked`.

**Policy.** The policy whitelist is not set per treasury in the UI. Every guarded treasury is initialized with the deployment's `policy_hash` (`deployments/devnet.json` `guard.policyHash`), so the same confidential policy and destination whitelist apply to every guarded treasury.

Propose, request review, vote, guarded execute and membership changes work for whichever guarded treasury is open: the prepare route takes the multisig from the wallet-signed request, resolves it to the deployment or a runner-reported group under the deployed guard program, and validates the runner's guard instruction against that group.

## Standard Squads workflow

1. Connect an installed Solana wallet through the Wallet Standard picker (Phantom, Solflare, Backpack, or another compatible wallet).
2. With `NEXT_PUBLIC_ENABLE_STANDARD_GROUPS=true`, the create dialog also offers **Standard group (no guard)**. Enter a name and member addresses, and choose the approval threshold. The connected creator joins automatically. Creation uses `multisigCreateV2`, the actual program configuration treasury, and an ephemeral create-key signer.
3. In a standard group the creator has Propose, Vote and Execute permissions. Other members have Propose and Vote. Configuration authority is unset, so settings changes require group approval rather than an admin override.
4. Use **Receive** to copy the derived vault address or deposit SOL/classic SPL tokens. Treasury funds live in the vault; members keep their own SOL for fees.
5. Create a payment, wait for decoding, review its exact amount, mint and recipient, then sign the proposal. SDK `vaultTransactionCreate` and active `proposalCreate` are submitted together; proposing does not transfer funds.
6. Members inspect the stored transaction and vote. Fresh token ownership must match the displayed review before approval. Votes update after finalized confirmation.
7. After the threshold and timelock are satisfied, an authorized executor can execute through the Squads SDK. Threshold changes and invitations use configuration proposals, votes, then `configTransactionExecute`.

Open an existing standard group with its multisig address or `/?group=<address>`. Group names and recently opened addresses are public local browser preferences. Sharing a link does not add a member: an invitation must be approved and executed first.

Vault, configuration and Batch proposal accounts are readable. Batch creation, full Batch decoding/approval/execution, address lookup tables, Token-2022, swaps and rent reclamation are not implemented. Unsupported instructions cannot be approved or executed through this UI. There is no production mock or demo fallback; test fixtures remain under `tests/`.

## Configuration

Copy `.env.example` to `.env.local` and fill in what you need.

| Variable                             | Purpose                                                                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `SOLANA_RPC_URL`                     | Server-only Devnet RPC endpoint. Defaults to Solana’s public Devnet endpoint.                                                          |
| `WYSIWYS_DEPLOYMENT_PATH`            | Optional path to the guarded deployment file. Defaults to `../deployments/devnet.json`.                                                |
| `WYSIWYS_SETTLEMENT_URL`             | Runner service for guarded groups, for example `http://127.0.0.1:8787`. Also proxied server-side for runner status and review history. |
| `WYSIWYS_SETTLEMENT_TOKEN`           | Server-only bearer token for the settlement service. Must equal the runner’s `SETTLEMENT_TOKEN`.                                       |
| `NEXT_PUBLIC_ENABLE_STANDARD_GROUPS` | Set to `true` to also offer "Standard group (no guard)" in the create dialog. Off by default: the UI creates guarded treasuries only.  |
| `WYSIWYS_NEXT_DIST`                  | Optional Next.js build directory. Defaults to `.next`; browser tests use `.next-browser`.                                              |

Wallets are detected through Wallet Standard. Connecting requests permission to expose an account, without a sign-in message or external authentication service. Transaction signatures are requested only for treasury actions. Disconnect and account changes invalidate pending signing operations. The picker supports wallets with Solana Devnet and versioned transaction signing. Install a compatible browser wallet if none is detected.

RPC submissions require valid Ed25519 signatures from every required transaction signer. Legacy Guard preparation uses a short-lived wallet-signed request bound to its body, path and origin; proofs cannot be reused on the same server instance. Connection alone does not authorize payments: Squads enforces member permissions, proposal approval and the threshold on-chain. Reads validate program ownership, discriminator, PDA and transaction/proposal binding. Network actions verify the full Devnet genesis hash. Wallet/account changes or modified transaction messages prevent broadcast.

## Guard review in the UI

For guarded groups the app reads each proposal's guard `Review` account (PDA `["review", multisig, tx_index u64 LE]` under the guard program) through the finalized RPC proxy, one `getMultipleAccounts` per refresh. The account must be owned by the guard program, carry the IDL discriminator and match the multisig and index.

- Proposal screen: the on-chain review comes first (Pending review, Approved, Rejected, Executed, or Expired when an approval is past `expires_at`), with a plain-English reason and the expiry time. "No review requested" means no Review account exists. The local decoder card is labelled a preview and never overrides the on-chain verdict. The preview comes from `@wysiwys/decoder` (the same decoder as the CRE workflow), run on the exact finalized VaultTransaction account bytes; the app recomputes the canonical `tx_hash` with `@wysiwys/shared` and blocks approval when it differs from the Review's, when any instruction is unsupported or malformed, or when an action is not a treasury payment. Drafts in the payment dialog are serialized with the Squads SDK into the bytes `vaultTransactionCreate` stores and decoded the same way. Live token accounts (source owned by the vault, mint decimals, destination mint and owner) are still checked before display and again before voting. Technical details show the decoder JSON and the `tx_hash`. The app builds `packages/decoder` before `test` and `build` (its `dist` is not committed).
- Transaction list: the Guard review column shows the same on-chain status next to the Squads proposal status.
- Execute through guard is enabled only when the Squads proposal is Approved and the Review is Approved and unexpired; otherwise the button shows why. The guard enforces this on-chain regardless.
- Config proposals (membership, threshold, time lock) have no Review account. They show "Guard check" with the decoded actions, and Execute through guard is enabled once the Squads proposal is Approved; see Membership changes above.
- Status page: runner online/offline, listener subscription, last backfill and review counts from `GET /api/runner/status` (sanitized, 5 second timeout).
- Dashboard: "Recent reviews" from `GET /api/runner/reviews?multisig=<open treasury>` (runner history filtered to that validated multisig, polled every 15 seconds). It is history; the on-chain review is authoritative.

Reason codes map to fixed text in `src/lib/squads/review.ts` (no AI).

## Standard groups and the Guard

Standard groups (opt-in) use **standard Squads execution** and do not enforce Guard policy checks. Guarded treasuries keep their PDA executor and Guard-only execution path; the standard path cannot execute them. A Guard adapter failure does not silently switch a protected treasury to standard execution. A standard group cannot be moved to Guard protection from the frontend; create a guarded treasury instead.

Verification uses unit tests, TypeScript, production build and browser flows with SDK-serialized accounts and ephemeral wallet signatures. These tests do not claim that the user’s real Phantom extension or live Devnet treasury has been exercised.
