# Decoder result contract, provisional v1

`decodeVaultTransaction(data: Uint8Array)` accepts full Squads `VaultTransaction` account bytes and returns a deterministic `DecodeResult` with `schemaVersion: 1`. These types currently belong only to `packages/decoder`. They have not been promoted to the frozen shared contract.

- `status: 'success'` includes `actions` for **every** top-level instruction in original order. Each action carries its original zero-based `instructionIndex`. This is the only result eligible to provide a complete action list to a later policy layer.
- `status: 'unsupported'` includes `error` and ordered `unsupportedInstructions`. It has no `actions` property, even if other instructions were supported.
- `status: 'malformed'` includes a stable `error` and, for an instruction failure, its `instructionIndex`. It has no `actions` property. If other instructions were unknown, their ordered `unsupportedInstructions` are also retained.

Each unsupported instruction record contains its zero-based `instructionIndex`, `category`, full base58 `programId`, ordered full base58 `accountKeys`, and `dataHex`. The `dataHex` value is the complete instruction data encoded as two lowercase hexadecimal characters per byte, including leading zero bytes. An empty instruction payload is `""`. The categories are `unknown_program` for an unrecognized program ID, `unknown_instruction` for an unrecognized variant of an accepted program, and `unsupported_token_program` when an Associated Token Account instruction selects a token program other than classic SPL Token.

A nonempty address table lookup list returns `status: 'unsupported'`, `error: 'address_table_lookups'`, and an empty `unsupportedInstructions` list before decoding any instruction. Structural account and message errors return `status: 'malformed'`. When both malformed and unknown instructions occur in a structurally valid message, malformed takes precedence and the unknown records are retained. The first malformed instruction in original order determines the reported error and index.

Classic Token actions include an optional `multisigSigners` array when signer accounts follow the required accounts. The keys remain in account order. Base-unit amounts are decimal strings; no mint is inferred for plain Token `Transfer`. A revoked `SetAuthority` new authority is explicitly `null`.

Hash verification remains upstream of this package. A caller must pass bytes to the decoder only after comparing `txHash(vaultTransactionAddress, fullAccountData)` from `@wysiwys/shared` with the Guard Review, and must pass actions to policy only when `status === 'success'`. Boundary tests in `test/boundary.test.ts` cover the call order and the shared hash function. Real devnet account validation is covered by `test/real-devnet.test.ts`. An import and build against the actual CRE workflow target remains an integration gate.
