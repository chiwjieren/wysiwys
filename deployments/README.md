# deployments

`devnet.json` is written by `scripts/bootstrap-devnet.ts` and owns every address: guard `programId`, Squads `multisig`, `vault`, `executorPda`, `configPda`, the guard config values (`guard`, null until the CRE values are set), mUSD `mint` and `mintMetadata`, `vaultTokenAccount`, `signers`, and the `recipients` (whitelisted and lookalike wallets with their token accounts). Never hardcode these elsewhere.

`devnet.<name>.json` describes a named treasury made with `--treasury <name>` and `SIGNERS=a,b,c` (for example the demo treasury signed by Phantom wallets). It shares the mUSD mint and recipients with `devnet.json`. Point the app at it with `WYSIWYS_DEPLOYMENT_PATH`.

Re-run the bootstrap any time; it only creates what is missing. Private keys stay in `keys/` (gitignored).
