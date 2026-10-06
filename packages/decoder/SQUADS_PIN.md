# Squads v4 decoder source pin

- Package: `@sqds/multisig` **2.1.4**, latest stable release found on 6 October 2026.
- Official package page: https://www.npmjs.com/package/@sqds/multisig (lists version 2.1.4).
- Official source repository: https://github.com/Squads-Protocol/v4, `sdk/multisig/`.
- Source version check: https://raw.githubusercontent.com/Squads-Protocol/v4/main/sdk/multisig/package.json (package name and version 2.1.4).
- Exact npm tarball integrity: SHA-512 `5w+NmwHOzl96nI50R/fjSD6uFydRLNUquhoEmmWbGepS4D9DnQyF2TKcUBfTyxV3sgJt00ypBt7SXB3y8WOzUQ==`, recorded in the root npm lockfile.
- Generated account source: `src/generated/accounts/VaultTransaction.ts`.
- Generated message source: `src/generated/types/VaultTransactionMessage.ts`.
- Nested source types: `src/generated/types/MultisigCompiledInstruction.ts` and `src/generated/types/MultisigMessageAddressTableLookup.ts`.
- License declared by package: MIT.

## Confirmed serialization order

The account starts with discriminator bytes `a8 fa a2 64 51 0e a2 cf`, then `multisig: PublicKey`, `creator: PublicKey`, `index: u64 LE`, `bump: u8`, `vaultIndex: u8`, `vaultBump: u8`, `ephemeralSignerBumps: Vec<u8>`, and `message`.

`VaultTransactionMessage` is `numSigners: u8`, `numWritableSigners: u8`, `numWritableNonSigners: u8`, `accountKeys: Vec<PublicKey>`, `instructions: Vec<MultisigCompiledInstruction>`, `addressTableLookups: Vec<MultisigMessageAddressTableLookup>`. A compiled instruction is `programIdIndex: u8`, `accountIndexes: Vec<u8>`, `data: Vec<u8>`. An address-table lookup is `accountKey: PublicKey`, `writableIndexes: Vec<u8>`, `readonlyIndexes: Vec<u8>`.

Vectors use the Beet/Borsh-compatible u32 little-endian length prefix in these generated structs. Public keys are 32 raw bytes. The decoder rejects nonempty address-table lookups before decoding instructions.

The package is not a runtime dependency of the portable decoder. This exact package version is recorded as the decoder's source pin; consumers integrating Squads should align their account/message assumptions to 2.1.4. CRE-specific compatibility remains a later integration gate.

## TransferChecked source

The MVP decoder recognizes the classic SPL Token program and its `TransferChecked` enum variant (tag 12): u64 little-endian amount followed by encoded decimals. Account roles are source token account, mint, destination token account, and authority in that order. This is the classic SPL Token contract; it does not infer the destination token account's owner wallet. The canonical implementation source is https://github.com/solana-program/token/blob/main/interface/src/instruction.rs.

## Deterministic local fixture

`fixtures/transfer-checked.json` is a deterministic locally generated account fixture using the field order above. It is synthetic, not real devnet account evidence. The test asserts its complete canonical result.
