# @wysiwys/shared

Cross-component contracts: seeds, events, report payload v2 (`encodeReportPayload`, 117 bytes), `destinationHash`, `policyHash` and `canonicalJson`, reason codes (`ReviewReason`), guard error codes, `txHash` (same as the guard's `tx_hash`), DecodedAction schema, IDL, runner API types and cross-language fixtures.

See the root AGENTS.md for guidelines.

`idl/wysiwys_guard.json` is copied from `target/idl` after every guard change (`anchor build`). The listener and the app parse guard events with it.
