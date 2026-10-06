# Spikes (6 Oct)

1. Program ID: `3jNv1XjPNeWUiZ8aiYheKJHknyjS81cpZfnPEp57CaH2`. Keypair backed up in `keys/` (gitignored). Never regenerate.
2. Squads on the local validator: loaded from `tests/fixtures` (devnet dump of `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`) plus ProgramConfig `BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr`. `multisigCreateV2` needs only the `create_key` and `creator` signatures. Tests run through `NODE_OPTIONS='--import tsx' mocha` (mocha 9 works).
3. Squads CPI: built by hand (the squads crate pins an old Anchor). `vault_transaction_execute` discriminator `[194, 8, 161, 87, 153, 164, 25, 171]`; accounts `multisig` (ro), `proposal` (w), `transaction` (ro), `member` (signer), then message accounts in order with the vault as non-signer.
4. Forwarder: `on_report(metadata, report)`; accounts `[forwarder_state, forwarder_authority (signer)]` then receiver accounts; authority PDA `["forwarder", state, receiver_program_id]` under the forwarder program. Metadata is 64 bytes (workflow_cid 32, workflow_name 10, workflow_owner 20, report_id 2).
5. Report size: CRE Solana `ReportSizeLimit` is 265 bytes of raw report, so the payload was cut to 107 bytes (see AGENTS.md). Simulate `--broadcast` through the mock forwarder: to be confirmed with Teammate A.
