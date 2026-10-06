# @wysiwys/app

Next.js web app: dashboard, transactions, review (verdict + summary + claim vs decoded reality), members, settings and /status. Propose, request review, vote and guarded execute.

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

## Standard Squads workflow

1. Connect an installed Solana wallet through the Wallet Standard picker (Phantom, Solflare, Backpack, or another compatible wallet).
2. With `NEXT_PUBLIC_ENABLE_STANDARD_GROUPS=true`, click **Create group** on the dashboard (hidden by default because UI-created groups bypass the Guard; guarded treasuries come from `scripts/bootstrap-devnet.ts`), enter a name and member addresses, and choose the approval threshold. The connected creator joins automatically. Creation uses `multisigCreateV2`, the actual program configuration treasury, and an ephemeral create-key signer.
3. The creator has Propose, Vote and Execute permissions. Other members have Propose and Vote. Configuration authority is unset, so settings changes require group approval rather than an admin override.
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
| `NEXT_PUBLIC_ENABLE_STANDARD_GROUPS` | Set to `true` to show UI group creation. Off by default: guarded treasuries are created by the bootstrap script.                       |
| `WYSIWYS_NEXT_DIST`                  | Optional Next.js build directory. Defaults to `.next`; browser tests use `.next-browser`.                                              |

Wallets are detected through Wallet Standard. Connecting requests permission to expose an account, without a sign-in message or external authentication service. Transaction signatures are requested only for treasury actions. Disconnect and account changes invalidate pending signing operations. The picker supports wallets with Solana Devnet and versioned transaction signing. Install a compatible browser wallet if none is detected.

RPC submissions require valid Ed25519 signatures from every required transaction signer. Legacy Guard preparation uses a short-lived wallet-signed request bound to its body, path and origin; proofs cannot be reused on the same server instance. Connection alone does not authorize payments: Squads enforces member permissions, proposal approval and the threshold on-chain. Reads validate program ownership, discriminator, PDA and transaction/proposal binding. Network actions verify the full Devnet genesis hash. Wallet/account changes or modified transaction messages prevent broadcast.

## Guard review in the UI

For guarded groups the app reads each proposal's guard `Review` account (PDA `["review", multisig, tx_index u64 LE]` under the guard program) through the finalized RPC proxy, one `getMultipleAccounts` per refresh. The account must be owned by the guard program, carry the IDL discriminator and match the multisig and index.

- Proposal screen: the on-chain review comes first (Pending review, Approved, Rejected, Executed, or Expired when an approval is past `expires_at`), with a plain-English reason and the expiry time. "No review requested" means no Review account exists. The local decoder card is labelled a preview and never overrides the on-chain verdict.
- Transaction list: the Guard review column shows the same on-chain status next to the Squads proposal status.
- Execute through guard is enabled only when the Squads proposal is Approved and the Review is Approved and unexpired; otherwise the button shows why. The guard enforces this on-chain regardless.
- Status page: runner online/offline, listener subscription, last backfill and review counts from `GET /api/runner/status` (sanitized, 5 second timeout).
- Dashboard: "Recent reviews" from `GET /api/runner/reviews` (runner history filtered to the deployment multisig, polled every 15 seconds). It is history; the on-chain review is authoritative.

Reason codes map to fixed text in `src/lib/squads/review.ts` (no AI).

## Guard integration later

New groups use **standard Squads execution**, as requested for the current build. They do not enforce Guard policy checks. Existing explicitly configured guarded groups keep their PDA executor and Guard-only execution path; the standard path cannot execute them. A Guard adapter failure does not silently switch a protected deployment to standard execution. Moving a standard group to Guard protection later requires an approved on-chain permission change and deployed Guard contracts; it is not a frontend toggle.

Verification uses unit tests, TypeScript, production build and browser flows with SDK-serialized accounts and ephemeral wallet signatures. These tests do not claim that the user’s real Phantom extension or live Devnet treasury has been exercised.
