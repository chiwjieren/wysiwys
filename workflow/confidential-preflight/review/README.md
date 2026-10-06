# Wysiwys review workflow (CRE)

HTTP trigger `{ multisig, txIndex }` -> 2-of-3 reads (QuickNode, Helius, Alchemy, finalized) of the Review, the stored Squads transaction, the GuardConfig and the destination -> `tx_hash` check -> decode -> private policy (`POLICY_DOCUMENT`, hash must equal the guard's `policy_hash`) and Scorechain screening inside the TEE -> 117-byte report v2 through the forwarder to the guard's `on_report`. Contract: `docs/specs/guard-cre-interface.md`.

Simulation only: the guard config points at the CRE simulator's mock forwarder, which does not verify DON signatures. The TEE is simulated locally.

## Run

From `workflow/confidential-preflight` (the project root):

```bash
# a Pending review to process (test treasury)
npx tsx ../../scripts/propose-devnet.ts clean         # prints txIndex; wait ~20 s for finality

# dry run: decides and simulates the write, sends nothing
cre workflow simulate review --target staging-settings --non-interactive --trigger-index 0 \
  --http-payload '{"multisig":"<multisig>","txIndex":"<n>"}'

# write the report to the guard on devnet
cre workflow simulate review --target staging-settings --non-interactive --trigger-index 0 --broadcast \
  --http-payload '{"multisig":"<multisig>","txIndex":"<n>"}'

# then vote 3 of 3 and execute (test signers)
npx tsx ../../scripts/finish-devnet.ts <n>
```

Or let the runner do it for every new review: root `.env` `CRE_PROJECT_DIR=<abs path to workflow/confidential-preflight>`, `CRE_WORKFLOW=review`.

## Project `.env` (gitignored)

`CRE_QUICKNODE_SOLANA_DEVNET_RPC_URL`, `CRE_HELIUS_SOLANA_DEVNET_RPC_URL`, `CRE_ALCHEMY_SOLANA_DEVNET_RPC_URL`, `CRE_SCORECHAIN_SANCTIONS_API_KEY`, `CRE_POLICY_DOCUMENT` (workflow/policy.json on one line), `CRE_SOLANA_PRIVATE_KEY` (base58 transmitter keypair, pays report transactions; `keys/cre-transmitter.json`), `CRE_ETH_PRIVATE_KEY` (throwaway; the CLI requires it even for Solana).

## Notes

- CRE allows 15 HTTP calls per run: the first read does devnet and slot checks (9 calls), the destination read only the account (3), Scorechain 1.
- Reads are at `finalized`: a review requested seconds ago can make providers disagree (`RPC_NO_QUORUM`); retry after ~20 s.
- Fails closed without a report on: no quorum, policy hash mismatch, review deadline passed, screening errors. Decided reviews are skipped.
- `bun test` runs the decision and quorum tests on real devnet account bytes (`fixtures/`).
