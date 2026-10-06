> **Superseded (7 Oct):** all four guard values are resolved and the guard config exists on devnet. See `docs/specs/guard-cre-interface.md` section 7 and `deployments/devnet.json`. Note: `CRE_TRIGGER_URL`/`CRE_TRIGGER_TOKEN` below are replaced by the runner's in-process CRE runner (`CRE_PROJECT_DIR`, `REVIEW_TOKEN`).

You need two groups of values: four for the guard config, and two for the runner. The guard ones matter most because the config can't be changed once created.

1. Guard config (goes in .env, then rerun the bootstrap)

┌─────────────────────────┬──────────────────────────────────────┬────────────┬─────────────────────────────────────────────────────────────────────┐
│        Variable         │              What it is              │   Format   │                          Ask the CRE lead                           │
├─────────────────────────┼──────────────────────────────────────┼────────────┼─────────────────────────────────────────────────────────────────────┤
│                         │                                      │            │ "Which forwarder program does your cre workflow simulate            │
│ GUARD_FORWARDER_PROGRAM │ The forwarder program that delivers  │ Solana     │ --broadcast use on devnet?" Earlier notes had the simulator's mock  │
│                         │ reports to the guard                 │ address    │ forwarder as 7kuEAA3mSC1Tz8gQjnvH7bKFda9xSPRRin9SZbH49cNK, but      │
│                         │                                      │            │ confirm it                                                          │
├─────────────────────────┼──────────────────────────────────────┼────────────┼─────────────────────────────────────────────────────────────────────┤
│ GUARD_FORWARDER_STATE   │ That forwarder's state account       │ Solana     │ Same question. Earlier notes:                                       │
│                         │                                      │ address    │ 5Tipz3yhTBdVsDbaBxZkrp7Gjf3brGq5SKkxReefPMP7, also needs confirming │
├─────────────────────────┼──────────────────────────────────────┼────────────┼─────────────────────────────────────────────────────────────────────┤
│                         │ The workflow owner address CRE       │ 20 bytes   │                                                                     │
│ GUARD_WORKFLOW_OWNER    │ writes into each report's metadata   │ hex (EVM   │ "What workflow owner address will appear in the report metadata,    │
│                         │ (bytes 42 to 62). The guard rejects  │ address)   │ for simulate and for deploy?"                                       │
│                         │ reports from any other owner         │            │                                                                     │
├─────────────────────────┼──────────────────────────────────────┼────────────┼─────────────────────────────────────────────────────────────────────┤
│                         │ Commitment over workflow/policy.json │ 32 bytes   │ "How do you compute policy_hash, and what's the value for the       │
│ GUARD_POLICY_HASH       │  plus the decoder version. Every     │ hex        │ policy we'll demo?"                                                 │
│                         │ report must carry exactly this value │            │                                                                     │
└─────────────────────────┴──────────────────────────────────────┴────────────┴─────────────────────────────────────────────────────────────────────┘

These two are your choice, and the defaults are already set:

┌────────────────────────────┬─────────┬─────────────────────────────────────────────────────────┐
│          Variable          │ Default │                         Meaning                         │
├────────────────────────────┼─────────┼─────────────────────────────────────────────────────────┤
│ GUARD_MAX_REVIEW_LIFETIME  │ 3600    │ An approval can be valid for at most 1 hour             │
├────────────────────────────┼─────────┼─────────────────────────────────────────────────────────┤
│ GUARD_REVIEW_DEADLINE_SECS │ 900     │ CRE must report within 15 minutes of the review request │
└────────────────────────────┴─────────┴─────────────────────────────────────────────────────────┘

Why it matters: the config is fixed once created. If any of the four values is wrong, every report fails (InvalidForwarder, InvalidWorkflow or PolicyMismatch), and the only fix is a new multisig. Get all four confirmed in writing first.

2. Runner (so it can start the workflow)

┌───────────────────┬────────────────────────────────────────────────────────────────────────────┐
│     Variable      │                                 What it is                                 │
├───────────────────┼────────────────────────────────────────────────────────────────────────────┤
│ CRE_TRIGGER_URL   │ The workflow's HTTP trigger endpoint, if the workflow is deployed on a DON │
├───────────────────┼────────────────────────────────────────────────────────────────────────────┤
│ CRE_TRIGGER_TOKEN │ The auth token that trigger expects, if any                                │
└───────────────────┴────────────────────────────────────────────────────────────────────────────┘

If you'll demo with cre workflow simulate instead, there's no URL to call. In that case the runner's POST /review, which shells out to cre workflow simulate, still needs to be built. So ask: "Deployed HTTP trigger, or simulate only?"

3. One check, not a value

Ask them to confirm the 265-byte report limit covers the 64 bytes of metadata plus the 181-byte payload together. The payload size was designed around that.