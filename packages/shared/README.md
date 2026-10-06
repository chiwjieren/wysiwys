# @wysiwys/shared

Cross-component contracts: seeds, events, account models (`GuardConfig`, `RequestHead`, `Review`), report layout, reason codes, canonical `tx_hash` encoding, DecodedAction schema, IDL, runner API types and cross-language fixtures.

See the root AGENTS.md for guidelines.

`idl/wysiwys_guard.json` is copied from `target/idl` after every guard change (`anchor build`). The listener and the app parse guard events with it.
