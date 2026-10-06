# Wysiwys MVP critical path (7 Oct)

Status: plan for review. Supersedes the ordering in `whatsnext.md` (its task list A to J still applies). Nothing here authorizes devnet writes, guard config creation, commits or pushes on its own.

Deadlines today: integration 12:00, **feature freeze 18:00**, submit 22:00.

## Where we are

| Component | State | Gap to MVP |
|---|---|---|
| Guard program `9wCc…` | Deployed, 57 integration + 51 unit tests | None (frozen) |
| Treasury (multisig `Boz5…`, mUSD `J7oq…`, vault 10M mUSD) | On devnet via bootstrap | Members are generated keys, not the demo wallets; guard config not initialized |
| Listener (`services/runner`) | Built, Helius WS, 37 tests | No `POST /review`; no settlement endpoints for the app |
| Decoder (`packages/decoder`) | Decodes System, SPL Token, ATA; rejects Token-2022, ALT, ephemeral signers | No policy or summary; `DecodedAction` not in shared |
| CRE | 3-provider RPC read and Scorechain screening simulate (cron, EVM report) | No review workflow: no HTTP trigger, no Review/VaultTransaction read, no txHash check, no policy, no 181-byte Solana report |
| Frontend (`app/`) | Real Squads create/propose/vote/execute from browser wallets | Cannot load `devnet.json` (key names); Members page imports deleted mock; never sends `request_review`; expects a settlement service that does not exist; UI-created groups give the creator Execute (bypasses guard) |

The single item everything else waits on is **the CRE review workflow writing a 117-byte (payload v2) report to the guard through the simulator forwarder.** Until that works there is no guard config, no Approved review and no payout.

## Resolved since this plan was written

- Forwarder program and state (simulator mock forwarder) and the simulator workflow owner are verified from official docs and Chainlink source: `docs/specs/guard-cre-interface.md` section 7.
- Payload v1 (181) did not fit CRE's 265-byte Solana raw report; payload v2 (117 bytes, `destination_hash`) is implemented in the guard, shared package and runner (decision approved 7 Oct).
- `policy_hash` defined and implemented (`policyHash` in `packages/shared`, `scripts/policy-hash.ts`).

## Order of work

### Step 1. Spike the CRE Solana write (first, time-boxed to 2 hours)

Owner: Chainlink owner. Highest risk; it also yields 3 of the 4 guard config values.

- In a throwaway workflow on the installed CLI (v1.33.0 here; plans used v1.37.0, align first), send a fixed 181-byte payload with the Solana write capability to the guard's `on_report` with receiver accounts `[GuardConfig (ro), Review (w)]`.
- Run without `--broadcast` first. Record: forwarder program, forwarder state, the 64-byte metadata (workflow owner at bytes 42..62), total raw report size.
- Exit criteria: the four facts above written into `docs/specs/guard-cre-interface.md` with evidence in `evidence/cre/`.
- **If it is not working by the time box**, stop and decide (Decision 1 below). Do not burn the afternoon on it.

### Step 2. Unblock the app (in parallel with Step 1, ~1 hour)

Owner: frontend owner (or me, if you want me on it).

- Fix `server-config.ts` to read `programId` and `executorPda` from `devnet.json` (the bootstrap's keys are canonical).
- Remove the deleted mock import from `members/page.tsx`; read members from the multisig.
- Run app typecheck, unit tests and build.
- Decide packaging (Decision 5) and make `AGENTS.md` match.

### Step 3. Settlement endpoints in the runner (in parallel, ~2 hours)

Owner: me.

- `POST /frontend/propose { multisig, txIndex, member }` returns a `request_review` instruction (wire format the app's `fromWire` and `validateGuardInstruction` accept) for the member to sign. Refuses if the member is not the vault transaction creator (the guard would anyway).
- `POST /frontend/execute { multisig, txIndex, member }` returns `guarded_execute` with the destination account from the on-chain Review and the Squads remaining accounts.
- `GET /frontend/groups/:multisig` as the app expects.
- Bearer token auth (`OMNICOUNTER_SETTLEMENT_TOKEN`), identifier validation, rate limit, tests against the local validator.
- App side: call `prepare("propose")` after `proposalCreate` so every proposal gets a review; drop `tradeId`.

### Step 4. Demo signers and guard config (after Step 1)

Owner: me, with the Chainlink owner's values.

- Re-bootstrap with the demo wallets as the 3 signers (Decision 3): add `--fresh` and `SIGNERS=pubkey1,pubkey2,pubkey3`, keep the mUSD mint and recipients.
- Define and implement `policyHash` in `packages/shared` (Decision 2) so the bootstrap and the workflow compute the same value.
- With all four values verified: run the bootstrap to create the guard config. Requires your explicit go-ahead (immutable devnet state).

### Step 5. CRE review workflow (after Step 1, the big one)

Owner: Chainlink owner; I can pair on the shared parts.

New project `workflow/cre/review` (keep the preflights as diagnostics):

1. HTTP trigger `{ multisig, txIndex }`, identifiers only.
2. Derive Review, VaultTransaction, Proposal PDAs; read them plus the destination token account with the existing 3-provider 2-of-3 read; add owner and discriminator checks.
3. `txHash` from `@wysiwys/shared` must equal `Review.tx_hash`, else reject `TX_HASH_MISMATCH`.
4. `@wysiwys/decoder`: exactly one SOL transfer or SPL `TransferChecked` from the vault, else reject (`UNKNOWN_PROGRAM`, `UNEXPECTED_INSTRUCTION`, `AUTHORITY_CHANGE_BLOCKED`, `DURABLE_NONCE_DETECTED`, `UNSUPPORTED_FEATURE`).
5. Policy inside the confidential handler: owner wallet in the private whitelist (`DESTINATION_NOT_WHITELISTED`), mint is mUSD (`MINT_NOT_ALLOWED`), amount at most the cap (`AMOUNT_OVER_CAP`), Scorechain on the decoded owner wallet (`SCREENING_REJECTED`).
6. `encodeReportPayload` with destination facts, `issuedAt` = now, `expiresAt` = now + 600; write to the guard.
7. Fixture tests per reject path; native simulation without broadcast; then `--broadcast` once the config exists (your go-ahead).

Scope cut if short on time: Scorechain stays in (already built), the TEE is simulated, no observation-hash export beyond what consensus needs.

### Step 6. Runner `POST /review` (after Step 5 compiles)

Owner: me.

- Authenticated, rate-limited, one run per review at a time, bounded runtime; runs `cre workflow simulate --broadcast` for the review workflow with the HTTP payload; returns sanitized logs.
- Point the listener's trigger at it (in-process, no extra hop). Result status is read back from chain, not from the CLI output.

### Step 7. End to end and recording (before freeze)

- `scripts/e2e-devnet.ts` with shared scenario builders: clean payment, lookalike (denied), Drift-style (denied), ownership swap after approval (execute fails), durable nonce (execute fails).
- Record each scenario as soon as it works. Save signatures and sanitized CRE logs in `evidence/`.

### Step 8. Hosting and submission (after freeze)

- Runner on EC2 (systemd, Caddy), app on Amplify, secrets in SSM/Amplify env.
- Deck with the embedded video, public repo check for secrets.

## Docs to fix along the way (15 minutes, any time)

- Mark `architecture.md` sections on RequestHead, generations, pause and admin as superseded by the frozen decisions.
- `guard-cre-interface.md` and `spikes.md`: multisig and mint now exist (see `devnet.json`).
- `AGENTS.md`: the CRE command points at `workflow/cre/...`, not `workflow/`; `DecodedAction` lives in the decoder until moved.
- `decoder-implementation-plan.md`: `msg_hash` wording is stale.
- Rotate the Scorechain key that was pasted in chat.

## Decisions needed from you

1. **Fallback if the CRE Solana write does not work by the time box.** Options: (a) keep pushing and cut other scope; (b) demo-only relay: the runner takes the workflow's verdict and delivers it through a forwarder we control on devnet, clearly labelled as not the Keystone path. (b) weakens the trust story and AGENTS.md currently forbids deploying `test_forwarder` to devnet, so it needs your explicit call.
2. **`policy_hash` definition.** Proposal: `sha256("wysiwys:policy:v1" || decoder_version || sha256(canonical policy JSON))`, computed in `packages/shared`, policy JSON kept as a CRE secret. The hash reveals nothing useful about a salted private whitelist; add a random salt field to the policy to be safe.
3. **Demo signers.** The current multisig's members are generated keys in `keys/`, but the app signs with browser wallets. Either re-bootstrap with the three demo wallet addresses (recommended), or import the generated test keys into the demo wallets.
4. **UI group creation.** Groups created in the UI give the creator Execute, which bypasses the guard. For the demo, hide or disable group creation and use only the bootstrapped guarded multisig.
5. **App packaging.** The app is a root workspace and also has its own lockfile. Pick one (recommended: keep it a workspace, delete `app/package-lock.json`, update AGENTS.md).

## Definition of done for today

Propose in the app, request review, CRE review via the runner (real RPC reads, txHash, decode, policy, simulated TEE), report through the simulator forwarder, three wallet votes, guarded payout on devnet, with the four blocked scenarios recorded.
