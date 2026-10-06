# Generic VaultTransaction inspection

## Goal

Expose every top-level instruction stored in a Squads `VaultTransaction` as raw,
lossless fields. Optionally interpret an instruction using a locally registered,
reviewed Anchor IDL. The inspection API is for investigation and preview. It
must not feed the payout approval policy.

## Contract and scope

- Reuse the existing bounded Squads account parser and index validation.
- Preserve instruction order, program ID, all account keys, and lowercase hex data.
- Keep address lookup tables unsupported until their addresses can be resolved.
- Accept only an explicit caller-supplied registry. Never fetch an IDL at runtime.
- Require IDL `address` to equal the registered program ID, an explicit discriminator,
  exact argument consumption, and a supported Borsh type before showing named fields.
- Unknown programs and unsupported IDL types retain raw fields without an interpretation.
- Keep `decodeVaultTransaction`, `DecodeResult`, `DecodedAction`, and policy behavior unchanged.
  Do not move provisional types into `packages/shared` without the required team agreement.
- This does not infer CPI effects, account-state-dependent behavior, or approval safety.

## Tests and gate

Write failing tests for real devnet raw inspection, a synthetic registered Anchor
instruction, wrong IDL address/discriminator, malformed data, and a mixed sequence.
Then implement, run the full decoder suite, package typecheck, browser and CRE
typechecks, and live fixture verification. A real deployed Anchor instruction
fixture remains a follow-up before calling IDL interpretation production-validated.
