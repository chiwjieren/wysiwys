# wysiwys frontend

What you see is what you sign. Next.js, Tailwind CSS, shadcn UI, direct Solana wallet connection, and the Squads v4 TypeScript SDK (`@sqds/multisig`). The current Figma layout remains the presentation layer; balances, members and proposals come from finalized Solana Devnet reads.

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
2. Click **Create group** on the dashboard, enter a name and member addresses, and choose the approval threshold. The connected creator joins automatically. Creation uses `multisigCreateV2`, the actual program configuration treasury, and an ephemeral create-key signer.
3. The creator has Propose, Vote and Execute permissions. Other members have Propose and Vote. Configuration authority is unset, so settings changes require group approval rather than an admin override.
4. Use **Receive** to copy the derived vault address or deposit SOL/classic SPL tokens. Treasury funds live in the vault; members keep their own SOL for fees.
5. Create a payment, wait for decoding, review its exact amount, mint and recipient, then sign the proposal. SDK `vaultTransactionCreate` and active `proposalCreate` are submitted together; proposing does not transfer funds.
6. Members inspect the stored transaction and vote. Fresh token ownership must match the displayed review before approval. Votes update after finalized confirmation.
7. After the threshold and timelock are satisfied, an authorized executor can execute through the Squads SDK. Threshold changes and invitations use configuration proposals, votes, then `configTransactionExecute`.

Open an existing standard group with its multisig address or `/?group=<address>`. Group names and recently opened addresses are public local browser preferences. Sharing a link does not add a member: an invitation must be approved and executed first.

Vault, configuration and Batch proposal accounts are readable. Batch creation, full Batch decoding/approval/execution, address lookup tables, Token-2022, swaps and rent reclamation are not implemented. Unsupported instructions cannot be approved or executed through this UI. There is no production mock or demo fallback; test fixtures remain under `tests/`.

## Configuration

| Variable                       | Purpose                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `SOLANA_RPC_URL`               | Server-only Devnet RPC endpoint. Defaults to Solana’s public Devnet endpoint. |
| `OMNICOUNTER_DEPLOYMENT_PATH`  | Optional existing guarded-group deployment configuration.                     |
| `OMNICOUNTER_SETTLEMENT_URL`   | Optional Guard adapter for guarded groups.                                    |
| `OMNICOUNTER_SETTLEMENT_TOKEN` | Server-only Guard adapter credential.                                         |

Wallets are detected through Wallet Standard. Connecting requests permission to expose an account, without a sign-in message or external authentication service. Transaction signatures are requested only for treasury actions. Disconnect and account changes invalidate pending signing operations. The picker supports wallets with Solana Devnet and versioned transaction signing. Install a compatible browser wallet if none is detected.

RPC submissions require valid Ed25519 signatures from every required transaction signer. Legacy Guard preparation uses a short-lived wallet-signed request bound to its body, path and origin; proofs cannot be reused on the same server instance. Connection alone does not authorize payments: Squads enforces member permissions, proposal approval and the threshold on-chain. Reads validate program ownership, discriminator, PDA and transaction/proposal binding. Network actions verify the full Devnet genesis hash. Wallet/account changes or modified transaction messages prevent broadcast.

## Guard integration later

New groups use **standard Squads execution**, as requested for the current build. They do not enforce Guard policy checks. Existing explicitly configured guarded groups keep their PDA executor and Guard-only execution path; the standard path cannot execute them. A Guard adapter failure does not silently switch a protected deployment to standard execution. Moving a standard group to Guard protection later requires an approved on-chain permission change and deployed Guard contracts; it is not a frontend toggle.

Verification uses unit tests, TypeScript, production build and browser flows with SDK-serialized accounts and ephemeral wallet signatures. These tests do not claim that the user’s real Phantom extension or live Devnet treasury has been exercised.
