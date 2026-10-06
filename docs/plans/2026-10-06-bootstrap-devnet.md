# Devnet Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One idempotent command that sets up everything the demo needs on devnet (mUSD mint with metadata, signers, Squads treasury, recipients, guard config) and writes `deployments/devnet.json`.

**Architecture:** `scripts/lib/bootstrap.ts` exports `bootstrap(opts)`, which takes a `Connection`, the payer and a keys directory, creates whatever is missing, verifies whatever exists and returns the deployment record. `scripts/bootstrap-devnet.ts` is the CLI: reads `.env`, runs it against devnet with the deployer wallet and `keys/`, writes `deployments/devnet.json`. Tests run the same function against the local validator (Squads and Metaplex loaded from `tests/fixtures`).

**Tech Stack:** `@solana/web3.js` 1.99, `@solana/spl-token`, `@sqds/multisig` 2.1, `@metaplex-foundation/mpl-token-metadata` 2.13 (web3.js v1 builders, no umi), Anchor 1.2 client for `initialize_guard`.

**Spec:** `AGENTS.md` (Scripts, Secrets, Demo scenarios), `docs/specs/guard-cre-interface.md`.

## Decisions

- **mUSD is a legacy SPL Token mint** (the guard only accepts legacy Token accounts; Token-2022 is out of scope). Name, symbol and URI live in a Metaplex Token Metadata account, mutable, update authority = deployer. Defaults: name `Mock USD`, symbol `mUSD`, 6 decimals, URI from `MUSD_URI` (empty until the app hosts a JSON).
- **Keys** live in `keys/` (gitignored): `multisig-create-key.json`, `signer-1..3.json`, `musd-mint.json`, `recipient.json`, `lookalike.json`. Created once, reused on every run.
- **Lookalike recipient**: a wallet whose base58 address starts with the same 3 characters as the whitelisted recipient (ground once, then stored).
- **Multisig**: Squads v4, threshold 3, members = 3 signers (Initiate + Vote), executor PDA `["executor", multisig]` under the guard (Execute only), no config authority, no time lock, no rent collector. Verified on every run with the same rule the guard enforces.
- **Guard config** is created only when all four CRE values are given (`GUARD_FORWARDER_PROGRAM`, `GUARD_FORWARDER_STATE`, `GUARD_POLICY_HASH`, `GUARD_WORKFLOW_OWNER`). It is immutable, so an existing config with different values is an error, never overwritten.
- Funding: signers topped up to 0.1 SOL from the payer (devnet airdrops are unreliable); vault token account minted up to 10,000,000 mUSD.

## Review Focus

1. Second run with the same keys: no new accounts, same addresses, vault not minted again.
2. Existing guard config with a different policy hash: run fails with a clear message, nothing changes.
3. Partial CRE env (e.g. only the forwarder program): fails before sending anything.
4. Multisig on chain that does not match the expected setup (human with Execute): run fails.
5. Keys directory missing: created with 0600 files.

## Tasks

- [ ] **Task 1: fixtures.** Dump Metaplex Token Metadata (`metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s`) from devnet to `tests/fixtures/mpl_token_metadata.so`; load it in `Anchor.toml` `[[test.genesis]]`.
- [ ] **Task 2: bootstrap library + tests** (`tests/bootstrap.ts`): first run creates mint (6 decimals, payer mint authority), metadata (name, symbol), signers, multisig (members and permissions as above), vault and recipient token accounts, vault balance, lookalike prefix; second run is a no-op with identical output; guard init with values creates the config; rerun with a different policy hash throws; partial guard values throw.
- [ ] **Task 3: CLI + docs.** `scripts/bootstrap-devnet.ts` (env parsing, writes `deployments/devnet.json`), `.env.example`, `deployments/README.md`, AGENTS.md Commands.
