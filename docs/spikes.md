# Spikes (6 Oct)

1. Program ID: `3jNv1XjPNeWUiZ8aiYheKJHknyjS81cpZfnPEp57CaH2`. Keypair backed up in `keys/` (gitignored). Never regenerate.
2. Squads on the local validator: loaded from `tests/fixtures` (devnet dump of `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`) plus ProgramConfig `BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr`. `multisigCreateV2` needs only the `create_key` and `creator` signatures. Tests run through `NODE_OPTIONS='--import tsx' mocha --exit` (mocha 9 works).
3. Squads CPI: built by hand (the squads crate pins an old Anchor). `vault_transaction_execute` discriminator `[194, 8, 161, 87, 153, 164, 25, 171]`; accounts `multisig` (ro), `proposal` (w), `transaction` (ro), `member` (signer), then message accounts in order with the vault as non-signer.
4. Forwarder: `on_report(metadata, report)`; accounts `[forwarder_state, forwarder_authority (signer)]` then receiver accounts; authority PDA `["forwarder", state, receiver_program_id]` under the forwarder program. Metadata is 64 bytes (workflow_cid 32, workflow_name 10, workflow_owner 20, report_id 2).
5. Report size: CRE Solana `ReportSizeLimit` is 265 bytes of raw report, so the payload was cut to 107 bytes (see AGENTS.md). Simulate `--broadcast` through the mock forwarder: to be confirmed with Teammate A.

## Test environment findings (6 Oct)

- Anchor 1.2 starts Surfpool by default. Surfpool did not load `test_forwarder` and forks remote state, so the guard tests run on `anchor test --validator legacy` (solana-test-validator).
- web3.js 1.99 caches blockhashes by polling `finalized`, which lags on the local validator and returned expired blockhashes ("Blockhash not found"). Test helpers send with a fresh `confirmed` blockhash (`sendWithFreshBlockhash`).
- mocha 9 keeps running on open websocket handles after the summary; `--exit` is required or validators are left orphaned and later runs stall.
- `request_review` derives the Review PDA from bytes 72..80 of the vault transaction inside the `seeds` expression; Anchor 1.2 accepts it.

## First devnet deploy (6 Oct)

- Program `3jNv1XjPNeWUiZ8aiYheKJHknyjS81cpZfnPEp57CaH2`, deployed with `scripts/deploy-guard-devnet.sh` via the Helius devnet RPC.
- Signature `27M9KYXVnvD388oUS9VoqLfq6fxwjoo3wgUa1jM4DtwmdaoWNatFR2uySE8UZXs1jDWYW6A4tgWucWKRoc5JhrRZ` (finalized), slot 508039295.
- ProgramData `FDLBNBsE4n66oe4fCR8tz6SCTACauBbLgSkfMTUBsq7V`, 208,792 bytes; upgrade authority is the deployer `6GsXSpGrQYQfMesz1uxTWJDkLzZJ2tAWiSSy3UBp6Vm6`.
- Verified: the dumped on-chain program is byte-identical to `target/deploy/wysiwys_guard.so` at commit b7cc3ea.
- Includes the review fixes (workflow owner check, executor-in-message check, proposer signer).
