# Generic Squads instruction inspection

`inspectVaultTransaction(bytes, registry?)` reads the same full Squads
`VaultTransaction` account bytes as `decodeVaultTransaction`. For every top-level
instruction it returns its index, program ID, ordered account keys, and complete
lowercase hex data. A built-in decoder or a locally registered Anchor IDL may
also provide named fields. The raw fields remain present either way.

This API is **descriptive**. `status: "inspected"` means the Squads account layout
was parsed; it does not mean every program was understood or that the payout is
safe. Do not pass `inspection.instructions` to settlement policy. The existing
`decodeVaultTransaction` result remains the fail-closed policy boundary.

## Run on bytes you fetched

```powershell
npm run build --workspace=packages/decoder
node packages/decoder/tools/inspect-vault.mjs vaulttransaction.bin
```

An optional second path may point to a reviewed JSON array of Anchor IDLs. Each
entry must contain `address` and flat `instructions` with explicit
`discriminator`, `accounts`, and `args`. No IDL is fetched automatically. This
first version interprets only `u8`, `u16`, `u32`, `u64`, `i64`, `bool`, and
`pubkey` arguments, with exact account count and no trailing data. Values for
`u64` and `i64` are decimal strings. Unknown programs, ambiguous IDs,
unsupported types, and invalid arguments remain raw. Address lookup tables
remain unsupported because their keys are not available in the account data.

The CLI prints both `inspection` and `payoutDecoder`, making the distinction
visible. IDL names and arguments do not establish a program's effects, which
may depend on account state or CPI calls. A real deployed Anchor instruction
fixture is still needed to validate IDL interpretation against live data.
