# Treasury Signing Firewall: decoder implementation plan

## Purpose and scope

Build the decoder component for Wysiwys on the existing `decoder` branch. The decoder accepts the exact raw Squads v4 `VaultTransaction` account data supplied by an upstream consumer and returns deterministic canonical facts about every top-level instruction. It does not decide whether a transaction is safe.

The authoritative flow is: upstream Fetcher obtains full account bytes, upstream CRE verifies `txHash(vault_transaction, data) == Review.tx_hash` (domain-separated, see `packages/shared` and `docs/specs/guard-cre-interface.md`), the decoder parses those verified bytes, and downstream policy consumes the result. Hashing and hash verification are not decoder responsibilities. A web consumer may use the same decoder for a preview, but preview output cannot authorize a transaction.

Implement decoder code in `packages/decoder`. Define shared `DecodedAction` and `DecodeResult` contracts in `packages/shared`, the repository's owner of cross-component types. Changes to a frozen shared interface require owner review and a team announcement before merging. Create only the minimum decoder-facing interfaces, adapters, and mocks needed to prove these boundaries. Leave teammate-owned Fetcher/RPC/NOWNodes, listener, hash infrastructure, policy engine, Guard, report builder, and Next.js business/UI logic untouched. Do not edit `README.md` or `AGENTS.md` as part of this plan.

## Branch and execution rules

1. Before implementation, run `git branch --show-current` and `git status --short --branch`. Confirm that the active branch is exactly `decoder`. If the existing branch is absent, stop and report it. Do not create or use a substitute branch.
2. Keep all changes and any requested phase commits on `decoder`. Never modify, merge, rebase, or push to `main`, `master`, or a teammate-owned branch. Never merge `decoder` into another branch.
3. Follow the hard gates below in order. A suggested commit message is not permission to commit. Commit only when the user explicitly asks, and only after that phase's gate passes. Never push automatically.
4. Use test-driven development for implementation: write a meaningful failing fixture test, run it, implement the behavior, then rerun it. Record commands and outcomes. Avoid unrelated changes.
5. If pinned source or fixtures disagree with this plan, stop the affected work and report the exact discrepancy. Do not guess a binary layout, program ID, instruction account role, or policy choice.

## Decoder contract

- Input: raw, complete Squads v4 `VaultTransaction` account bytes as `Uint8Array`. The API must not accept a caller-provided `verified: true` flag as proof of the upstream hash check.
- Parse the Anchor account discriminator, all fields of the pinned `VaultTransaction`, its `VaultTransactionMessage`, static account keys, compiled instructions, and address table lookups according to the confirmed pinned source/IDL. Validate lengths, counts, indexes, integer ranges, and trailing data according to that exact version. Do not parse this as a legacy or v0 Solana transaction message.
- Resolve each compiled program ID and account index using the pinned Squads message contract. Process exactly one ordered record for each top-level instruction, preserving its original index. Do not sort, aggregate, skip, or infer CPI/inner-instruction effects.
- Return a versioned `DecodeResult` with an overall success, unsupported, or malformed/error status. Only a complete successful result may expose a fully supported `DecodedAction[]` for downstream policy. Preserve ordered per-instruction unsupported records for review without presenting a supported subset as a successful decode.
- Supported records preserve the full base58 program ID and relevant public keys with their semantic roles, canonical instruction name, and exact base-unit amounts as decimal strings. Never convert amounts to floating point or display units. Preserve encoded decimals, authority type, and an explicit null new authority where relevant.
- Unsupported records include a stable category, instruction index, full program ID where resolvable, recoverable account keys, and instruction data in a documented lossless encoding. Structural parse failures use stable error categories and never look like successful empty actions.
- Any nonempty `address_table_lookups` is an explicit overall unsupported result in v1, before instruction decoding. No ALT resolution.
- Any nonempty `ephemeralSignerBumps` is an explicit overall unsupported result (`ephemeral_signers`), before instruction decoding or generic inspection. Empty lists remain supported. Regression fixtures cover both SOL and SPL payments with zero-valued, single and multiple bumps.
- The package is pure deterministic TypeScript suitable for the actual CRE target and shared web-preview import: no Node.js runtime API, filesystem, RPC, network, clock, randomness, AI, signing, execution, policy, hash verification, Guard, or report-building dependency.

### MVP instruction set

Confirm exact program IDs, discriminators, byte layouts, required account positions, and authority semantics against authoritative pinned sources before implementation. Accept only the classic program IDs agreed for this project.

| Program | Instructions | Canonical facts |
| --- | --- | --- |
| System | `Assign`, `Transfer`, `AdvanceNonceAccount`, `WithdrawNonceAccount`, `InitializeNonceAccount`, `AuthorizeNonceAccount` | Owner change, SOL transfer, or nonce operation; exact accounts, authority, and lamports where encoded. |
| Classic SPL Token | `Transfer`, `Approve`, `ApproveChecked`, `Revoke`, `SetAuthority`, `CloseAccount`, `TransferChecked` | Exact token accounts, delegate/authority facts, amount, mint and decimals only when encoded. |
| Associated Token Account | `Create`, `CreateIdempotent` | Payer, ATA, wallet owner, and mint. |

Token transfer destinations are token accounts, not assumed recipient wallets. Plain SPL `Transfer` does not encode a mint, so the decoder must not invent one. Resolving a token account's owner wallet or mint from chain state belongs to the upstream Fetcher. Token-2022, unknown programs, unknown variants, and malformed supported instructions are unsupported and make the overall result non-success.

## Phases, timing, and gates

These are hackathon estimates for decoder work, assuming the pinned source/IDL is supplied promptly. A missing pin pauses layout-dependent work. A real devnet fixture is needed for integration validation, but does not block development against deterministic local fixtures once the pinned layout is established. Target the first complete fixture-to-action path before expanding instruction coverage.

| Phase | Work | Estimate | Hard gate | Suggested commit |
| --- | --- | --- | --- | --- |
| 0. Reconnaissance | Check branch/status and repository instructions; identify the project's pinned Squads v4 version, source/IDL, binary field order, instruction layouts, CRE target constraints, and owners of shared contracts. Record the provenance. | 1 to 3 hours, excluding owner wait | Exact pinned account/message layout and program/instruction sources are identified; unresolved contracts are reported with owners. If no version is pinned, report the blocker and stop layout-dependent work. | `docs(decoder): record pinned Squads contracts` |
| 1. Parser, API, early vertical path | Agree the versioned `DecodedAction`/`DecodeResult` interface in `packages/shared`. Implement bounded account/message deserialization and compiled index resolution in `packages/decoder`. Use a deterministic locally generated fixture to prove `fixture -> Squads deserialization -> account/program resolution -> Transfer or TransferChecked -> canonical action`. | 4 to 8 hours | A fixture generated from the confirmed layout produces one complete canonical action; wrong discriminator, truncation, counts, and indexes fail predictably; shared interface has owner review. | `feat(decoder): add Squads parser and first canonical action` |
| 2. Full MVP decoders | Add the remaining listed System, classic SPL Token, and ATA variants, with separate program-specific decoders. Preserve order, full keys, exact integer strings, and encoded null/authority/decimal semantics. | 5 to 8 hours | Every listed variant has a positive fixture asserting its complete canonical result and a malformed-layout case. | `feat(decoder): cover MVP instruction set` |
| 3. Fail-closed and security tests | Implement explicit unsupported records, overall non-success semantics, ALT rejection, and stable errors. Cover mixed instructions and deterministic output. | 3 to 5 hours | Unknown or malformed input cannot yield a successful subset; the security matrix below passes. | `test(decoder): prove fail-closed behavior` |
| 4. Real devnet fixture validation | Obtain verified full Squads `VaultTransaction` account bytes from the pinned version and record provenance, account address, cluster, slot/transaction reference, and expected decode. Keep secrets out of fixtures. | 2 to 4 hours, excluding fixture acquisition | The real fixture decodes to the expected complete action sequence, and locally generated fixtures agree on layout. Any mismatch is investigated before continuing. | `test(decoder): validate real Squads account fixture` |
| 5. Integration boundary | Expose a clean package API for CRE and web consumers. Use mocks/fixtures to show upstream hash success calls the decoder, upstream mismatch never calls it, and only a complete successful decode is eligible for downstream policy. Verify actual target build/import constraints where available. | 2 to 4 hours | Boundary tests pass without implementing teammate components; package typechecks and builds for the actual CRE target and web preview; no forbidden runtime dependency is present. | `feat(decoder): expose consumer API and boundary tests` |
| 6. Optional Anchor stretch | Only after all MVP gates pass and the team explicitly accepts the stretch: exact allowlisted program IDs, trusted pinned IDLs, allowed instructions, reviewed mappings, and mismatch tests. | Separate estimate | Each supported IDL/program has reviewed positive and negative fixtures; unknown IDLs/programs remain unsupported; CPI limitations are documented. | `feat(decoder): add reviewed Anchor actions` |

Estimated MVP effort is about 2 to 3 focused working days, plus time waiting for the pinned source or real devnet fixture. Phase 6 is excluded from the MVP schedule.

## Required security and correctness matrix

Use fixed fixtures and assert complete result structures, not only action counts. Cover:

- Wrong account discriminator, malformed or truncated account/message/instruction data, invalid lengths/counts, trailing bytes as specified by the pin, invalid program/account indexes, and required-account omissions.
- Unknown program IDs, unknown instruction discriminators, unsupported variants, Token-2022, nonempty ALT lists, and wrong classic program IDs with otherwise plausible bytes.
- Mixed supported and unsupported instructions, `TransferChecked + SetAuthority`, multiple instructions in exact original order, and no route that returns only the supported subset as success.
- Full exact public keys and semantic roles, exact token-account destination, plain `Transfer` with no invented mint, explicit null authority, and base-unit integers above JavaScript's safe integer range.
- Repeated decoding of identical bytes yields identical serialized results and error categories.
- Mocked upstream hash mismatch prevents decoder invocation; mocked downstream policy receives only complete successful action lists. These are boundary tests, not implementations of hash infrastructure or policy.
- Static review for floating-point conversions, network/RPC, Node.js runtime APIs, clocks/randomness, policy logic, hash verification, signing/execution, and duplicate decoding logic.

Run the decoder package's relevant tests, typecheck, and target compatibility checks; record each command and outcome. If the current scaffold lacks a required test/typecheck/build command, add only the minimum decoder-local package tooling necessary. Do not modify AGENTS.md or README.md. Report any repository-level documentation changes that may be needed to the team instead.

## Non-goals and scope controls

No Fetcher, RPC/NOWNodes consensus, listener, hash implementation, policy engine, allowlists, limits, risk scoring, report builder, signing, execution, Guard changes, or Next.js business/UI work. No token-account owner/mint chain-state resolution. No display-unit amounts, Token-2022, ALT resolution, arbitrary programs, universal CPI/inner-instruction analysis, or generic Anchor decoding. Do not modify teammate-owned components to make decoder tests pass. Anchor remains optional and cannot delay MVP.

## Blocker protocol

When blocked, stop only dependent work. Report: the phase and hard gate, the exact missing source/fixture/interface, what was checked, the affected files or behavior, the owner or decision needed, and independent work that can still proceed. If the project's pinned Squads source/IDL/version is absent, do not silently choose a public version. If the pinned source conflicts with this plan or a fixture, quote the exact conflicting fields and pause affected parsing or decoding. Do not mark a gate passed based only on synthetic fixtures when that gate requires real devnet evidence.

Current reconnaissance snapshot for this plan: `decoder` is active, the working tree was clean before this file was written, `packages/shared` and `packages/decoder` are scaffolds, and no pinned Squads source/IDL/version or real account fixture was found in the current tree. Phase 0 must recheck this at execution time because teammates may add files.

## Strict Definition of Done

1. The active work and any requested commits stay on `decoder`; no merge, rebase, or push is performed.
2. The decoder parses raw bytes using the confirmed pinned Squads v4 layout and resolves compiled indexes correctly.
3. Every listed MVP instruction produces the agreed complete canonical action with full keys, exact values, and original ordering.
4. ALT, Token-2022, unknown, malformed, or unsupported content yields explicit non-success; no partial successful action list reaches a consumer.
5. A verified real devnet account fixture validates the parser and expected action sequence.
6. The shared package API works for the actual CRE target and web preview, with upstream hash and downstream policy boundaries proven by mocks/fixtures.
7. Meaningful unit, security, and boundary tests pass; commands and outcomes are recorded; the package has no forbidden runtime dependencies or teammate-owned implementations.
8. Source pin, fixture provenance, schema version, owner reviews, limitations, and any deviations are documented. Anchor is absent unless separately approved and completed.

## Completion report format

At completion or a hard stop, report:

- Branch and `git status`.
- Phases and gates passed; any gate blocked and its owner action.
- Files changed and each file's purpose.
- Pinned Squads version/source and fixture provenance.
- Tests, typecheck, and target build commands with outcomes.
- Decoder API/schema version and upstream/downstream boundary results.
- Phase commit hashes only if the user requested commits.
- Open risks, limitations, and deviations from this plan.
