# Risks and production gaps

Wysiwys runs on Solana devnet as a hackathon build. This list is what stands between it and a production treasury firewall. Severity: **High** (breaks the trust model in production), **Medium** (operational or product risk), **Low** (limitation worth knowing).

The invariant that holds today, even with every gap below: money moves only when the treasury's human threshold has voted AND the guard has an Approved, unexpired review for that exact transaction and destination.

## Trust and keys

| # | Gap | Today | Risk | Production fix | Severity |
|---|---|---|---|---|---|
| 1 | Guard upgrade authority | One deployer key (`6GsX…`) can upgrade the guard program | An upgrade can change what the executor checks | Move the upgrade authority to a Squads multisig; make the program immutable after an audit | High |
| 2 | Report authenticity | CRE simulator mock forwarder: no DON signature check; every simulator reports the same workflow owner | Anyone on devnet can deliver an "approved" report (human votes are still required) | Deploy the workflow to a live Chainlink DON with the Keystone forwarder; new GuardConfig pointing at it | High |
| 3 | Workflow provenance | Guard checks the 20-byte workflow owner only | Any workflow of the same owner could report | Bind the workflow ID (or a per-workflow key) in the guard once the live Solana report path exposes it | High |
| 4 | Confidential execution | TEE simulated locally; no attestation | Policy and screening inputs are not hardware-protected | Confidential Workflows enrollment; verify attestation before trusting enclave output | High |
| 5 | Transmitter key | Hot key on the server pays report transactions | Theft drains its SOL (it cannot approve or move treasury funds) | Small balance, alerts, separate key per runner, KMS-backed signing | Low |
| 6 | Secrets storage | `.env` files on the EC2 box | Server compromise exposes RPC, Scorechain and policy secrets | AWS SSM Parameter Store / Secrets Manager; rotate the Scorechain key (it was pasted in chat once) | Medium |
| 7 | Token authority | mUSD mint authority is the deployer key | Unlimited minting of the demo token | Real USDC (or a mint with no authority) in production | Low (demo only) |

## Oracle and data

| # | Gap | Today | Risk | Production fix | Severity |
|---|---|---|---|---|---|
| 8 | DON consensus | Simulation runs a single node | Multi-node agreement is designed but not exercised | Live DON; verify membership, fault bound and quorum | High |
| 9 | RPC sources | Same 3 providers (QuickNode, Helius, Alchemy) for every node, 2-of-3 | Two colluding or identically wrong providers mislead every node | More, independent providers; per-operator diversity | Medium |
| 10 | Destination freshness | Follow-up destination read skips the slot pin (CRE 15-call limit) | Slightly older view of the destination account | Guard re-checks owner and mint at execution, so the risk is bounded; pin when limits allow | Low |
| 11 | Screening scope | Scorechain sanctions only | No wallet-risk scoring; screening outage blocks payments (fail closed) | Add a verified risk provider and thresholds | Medium |
| 12 | Report size | 117-byte payload, 3 bytes under CRE's 265-byte Solana limit | No room for new fields | Next version must hash or compress fields | Low |

## Guard and payment model

| # | Gap | Today | Risk | Production fix | Severity |
|---|---|---|---|---|---|
| 13 | No recovery path | If CRE or the runner is down, nothing can execute | Funds safe but stuck | Timelocked recovery, e.g. supermajority can execute after N days without a review | High |
| 14 | Fixed membership | Members and threshold cannot change after creation (config transactions need Execute, which only the guard has) | Lost key or staff change needs a new treasury | Guarded config path (`guarded_config_execute` with its own review) | Medium |
| 15 | One review per transaction | Rejected, expired or late (> 900 s) reviews cannot be retried | Re-propose the payment | Review generations (`RequestHead`) | Low |
| 16 | Payment types | One instruction per payment: SOL transfer or legacy SPL `TransferChecked` to an existing token account | No batches, ATA creation, Token-2022, lookup tables, swaps | Extend decoder, policy and guard binding per instruction type | Medium |
| 17 | Limits | Per-payment cap only | Many small payments bypass a daily budget | On-chain cumulative counters updated atomically at execution | Medium |
| 18 | Treasury size | Up to 13 humans per treasury (one-transaction creation fits 1232 bytes) | Large committees not supported | Two-step creation | Low |
| 19 | Audit | Guard not audited; durable-nonce check looks at instruction 0 only | Undiscovered bugs | External audit; broaden instruction introspection | High |
| 20 | Dependency | Squads v4 is upgradable by the Squads team | External trust | Accept (audited, widely used) or pin a verified build | Low |

## Policy

| # | Gap | Today | Risk | Production fix | Severity |
|---|---|---|---|---|---|
| 21 | Policy changes | `policy_hash` is immutable per GuardConfig | Any whitelist or cap change needs a new treasury | Versioned policy with treasury-approved, guarded updates | Medium |
| 22 | Shared policy | Every UI-created treasury uses the deployment's policy (one whitelisted wallet) | Not per-organization | Policy per treasury, chosen at creation | Medium |
| 23 | Policy custody | Policy JSON and its salt live in one place | Losing the salt makes the hash unreproducible; one author | Backed-up, access-controlled policy store; approval workflow for edits | Medium |

## Operations

| # | Gap | Today | Risk | Production fix | Severity |
|---|---|---|---|---|---|
| 24 | Single runner | One EC2 instance, one SQLite file | Downtime delays reviews (fail closed) | 2+ runners behind a load balancer with `/status` health checks; one active reviewer or DON triggers | Medium |
| 25 | Monitoring | Logs only (`journalctl`) | Silent failures | Alerts on `/status` 503, trigger failures, transmitter balance, review deadline misses | Medium |
| 26 | App rate limits and replay | In-memory per instance | Weak on multi-instance or serverless hosting | Shared store (Redis) for limits and wallet-proof replay | Low |
| 27 | Environment | Devnet only, test keys, mock token | Not production data | Mainnet deployment after items 1 to 4, 8, 13 and 19 | High |

## Testing status

| # | Gap | Today | Production fix | Severity |
|---|---|---|---|---|
| 28 | Browser wallet flow | Every step verified on devnet through the app's code with test keypairs; a full click-through with Phantom still to record | Browser E2E with a real wallet (Playwright + wallet adapter) | Medium |
| 29 | Live CRE scenarios | Clean, lookalike and Drift-style run through the real workflow; over-cap, ownership swap, durable nonce and a sanctioned wallet only via the stand-in reviewer or local tests | Run all scenarios through the real workflow; add a sanctioned-wallet case | Low |
