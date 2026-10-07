# Spikes (6 Oct)

1. Program ID: `9wCcjb74o2cWcFx8GimQQMcR1nJay9X86v1JiyV9kwya` (Wysiwys guard, since 6 Oct). Keypair in `keys/wysiwys_guard-program-keypair.json` (gitignored); back it up. Never regenerate. The previous OTC-era program `3jNv1XjPNeWUiZ8aiYheKJHknyjS81cpZfnPEp57CaH2` is retired.
2. Squads on the local validator: loaded from `tests/fixtures` (devnet dump of `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`) plus ProgramConfig `BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr`. `multisigCreateV2` needs only the `create_key` and `creator` signatures. Tests run through `NODE_OPTIONS='--import tsx' mocha --exit` (mocha 9 works).
3. Squads CPI: built by hand (the squads crate pins an old Anchor). `vault_transaction_execute` discriminator `[194, 8, 161, 87, 153, 164, 25, 171]`; accounts `multisig` (ro), `proposal` (w), `transaction` (ro), `member` (signer), then message accounts in order with the vault as non-signer.
4. Forwarder: `on_report(metadata, report)`; accounts `[forwarder_state, forwarder_authority (signer)]` then receiver accounts; authority PDA `["forwarder", state, receiver_program_id]` under the forwarder program. Metadata is 64 bytes (workflow_cid 32, workflow_name 10, workflow_owner 20, report_id 2).
5. Report size: CRE Solana `ReportSizeLimit` is 265 bytes of raw report. The Wysiwys payload v1 is 181 bytes (plus 64 bytes of metadata); see AGENTS.md. Simulate `--broadcast` through the mock forwarder: to be confirmed with Teammate A.

## Test environment findings (6 Oct)

- Anchor 1.2 starts Surfpool by default. Surfpool did not load `test_forwarder` and forks remote state, so the guard tests run on `anchor test --validator legacy` (solana-test-validator).
- web3.js 1.99 caches blockhashes by polling `finalized`, which lags on the local validator and returned expired blockhashes ("Blockhash not found"). Test helpers send with a fresh `confirmed` blockhash (`sendWithFreshBlockhash`).
- mocha 9 keeps running on open websocket handles after the summary; `--exit` is required or validators are left orphaned and later runs stall.
- `request_review` derives the Review PDA from bytes 72..80 of the vault transaction inside the `seeds` expression; Anchor 1.2 accepts it.

## First devnet deploy (6 Oct, OTC-era, retired)

- Program `3jNv1XjPNeWUiZ8aiYheKJHknyjS81cpZfnPEp57CaH2`, deployed with `scripts/deploy-guard-devnet.sh` via the Helius devnet RPC.
- Signature `27M9KYXVnvD388oUS9VoqLfq6fxwjoo3wgUa1jM4DtwmdaoWNatFR2uySE8UZXs1jDWYW6A4tgWucWKRoc5JhrRZ` (finalized), slot 508039295.
- ProgramData `FDLBNBsE4n66oe4fCR8tz6SCTACauBbLgSkfMTUBsq7V`, 208,792 bytes; upgrade authority is the deployer `6GsXSpGrQYQfMesz1uxTWJDkLzZJ2tAWiSSy3UBp6Vm6`.
- Verified: the dumped on-chain program is byte-identical to `target/deploy/wysiwys_guard.so` at commit b7cc3ea.
- Includes the review fixes (workflow owner check, executor-in-message check, proposer signer).

## Wysiwys guard devnet deploy (6 Oct)

- Fresh program ID `9wCcjb74o2cWcFx8GimQQMcR1nJay9X86v1JiyV9kwya` (new account layouts: `tx_hash`, destination facts, report payload v1). Deployed with `scripts/deploy-guard-devnet.sh` via the public devnet RPC.
- Signature `4EzMkbWbL1VKnjxqVBaSs6UbXppJqcjSfe2VySndm85MAgKfeLmjTQuRiu47E8CaqnzPYAkhZ4WoYRNYp9SGwnd9` (finalized), slot 508077916.
- ProgramData `6YApJTnoLM7brdEd2S5HNnW84WeTYHJbD2sLEsax3sL`, 216,960 bytes; upgrade authority is the deployer `6GsXSpGrQYQfMesz1uxTWJDkLzZJ2tAWiSSy3UBp6Vm6`.
- Verified: the dumped on-chain program is byte-identical to `target/deploy/wysiwys_guard.so` (sha256 `215dc3ff064a88df45af8c1e8e247d6dfc244ea79f90acb81b1d94eb775e1b38`), built from 72425d5 plus the program ID change.
- `anchor test --validator legacy`: 57 passing with this ID before deploy.
- No guard config or multisig exists yet for this program; `scripts/bootstrap-devnet.ts` must create them and write `deployments/devnet.json`.

## Guard upgrade: payload v2 (7 Oct)

- In-place upgrade of `9wCcjb74o2cWcFx8GimQQMcR1nJay9X86v1JiyV9kwya` (no Review or GuardConfig accounts existed). Signature `3Ztzo42Ld2SgokJDaLQRZoFBZSq1MNgZWy9cNTT5Fp3QwPSUoybJNx4Awk3vUJNt3SBXDGaReLZArnBhA2VieoXj` (finalized), slot 508153634.
- Build 215,184 bytes (sha256 `ac32be4edcd8a3e31f47eca41dbffb3bf3c6fd94b16df1d0245dbda8a40d3de3`) at e098b24; fits the existing 216,960-byte ProgramData. Verified: the dumped program's first 215,184 bytes equal the build and the rest is zero padding.
- Why: CRE caps the Solana raw report at 265 bytes (109 metadata + 32 account hash + 4 length + payload), so payload v1 (181) could not be delivered. v2 is 117 bytes with `destination_hash`. See `docs/specs/guard-cre-interface.md`.
- `anchor test --validator legacy`: 70 passing before the upgrade.

## Guard upgrade: guarded_config_execute (7 Oct)

- In-place upgrade of `9wCcjb74o2cWcFx8GimQQMcR1nJay9X86v1JiyV9kwya` (additive: new instruction, no account layout change). Signature `3ZCvUu5bfBYzedxMmdYaY96cUyyZ3yPHpDNJDk3qDmNVgsgnBkqrwayYhxBuUWZweeoQFQWVTEeUcaaNgwhs9eVV`, slot 508302149. ProgramData extended to 233,008 bytes; dump byte-identical to the build (sha256 `97b176e7302760565275084ddd01b3ae36a3be751c31816de7b9938ca959da2e`).
- Devnet check on treasury `26XYHwTdNnNN1mFZAu11LK3m68eY1SmA8HNVhb41gMc4`: voted AddMember (Initiate + Vote) executed through the guard (`3E4MnPWL…`), then voted RemoveMember (`5UEjjqji…`); the executor stayed the sole Execute member.
