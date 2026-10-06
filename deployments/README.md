# deployments

`devnet.json` is written by `scripts/bootstrap-devnet.ts` and owns every address: guard `programId`, Squads `multisig`, `vault`, `executorPda`, `configPda`, the guard config values (`guard`, null until the CRE values are set), mUSD `mint` and `mintMetadata`, `vaultTokenAccount`, `signers`, and the `recipients` (whitelisted and lookalike wallets with their token accounts). Never hardcode these elsewhere.

Re-run the bootstrap any time; it only creates what is missing. Private keys stay in `keys/` (gitignored).
