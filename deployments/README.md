# deployments

`devnet.json` is written by `scripts/bootstrap-devnet.ts` and owns every address (programId, multisig, vault, executorPda, configPda, mint, forwarderProgram, forwarderState, policyHash, signers). Never hardcode these elsewhere.
