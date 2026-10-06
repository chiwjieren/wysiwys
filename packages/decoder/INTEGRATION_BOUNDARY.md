# Decoder consumer boundary

Build with `npm run build --workspace=packages/decoder`, then import `decodeVaultTransaction` and the `DecodeResult` and `DecodedAction` types from `@omnicounter/decoder`. The package root resolves to the generated JavaScript and declaration files. The contract remains provisional in this package pending team review; `packages/shared` is unchanged.

The caller verifies the hash of the **full** Squads `VaultTransaction` account data before invoking the decoder. A hash mismatch stops before decoding. The caller passes `result.actions` to policy only when `result.status === 'success'`; `unsupported` and `malformed` results carry no actions. The decoder does not verify hashes or make policy decisions.

`test/boundary.test.ts` exercises the call order with an upstream hash mock, the package import, real and synthetic account fixtures, and a downstream policy mock. `test/browser-import.ts` is typechecked with DOM types and no Node types, and bundles for the browser. The source and browser bundle have no Node runtime, filesystem, network, clock, or randomness dependency.

The repository currently has no CRE workflow source or target configuration, so an actual CRE target import and WASM build cannot yet be verified. The CRE CLI is installed, but its project initialization requires authentication. The package build and browser import checks do not establish CRE compatibility; that gate stays open until a workflow target is available.
