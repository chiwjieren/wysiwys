# @omnicounter/shared

Cross-component contracts: seeds, events, report payload, reason codes (`ReviewReason`), `settlement_intent_hash` and `trade_ref_hash` hashing, DecodedAction schema, IDL and runner API types.

See the root AGENTS.md for guidelines.

`idl/omnicounter_guard.json` is copied from `target/idl` after every guard change (`anchor build`). The listener and the app parse guard events with it.
