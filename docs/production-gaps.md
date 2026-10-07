# Risks and production gaps

Wysiwys runs on Solana devnet as a hackathon build. This list is what stands between it and a production treasury firewall. Severity: **High** (breaks the trust model in production), **Medium** (operational or product risk), **Low** (limitation worth knowing).

The invariant that holds today, even with every gap below: money moves only when the treasury's human threshold has voted AND the guard has an Approved, unexpired review for that exact transaction and destination.

## Trust and keys

| # | Gap | Today | Risk | Production fix | Severity |
|---|---|---|---|---|---|
| 1 | Guard upgrade authority | One deployer key (`6GsX…`) can upgrade the guard program | An upgrade can change what the executor checks | Move the upgrade authority to a Squads multisig; make the program immutable after an audit | High |
| 2 | Report authenticity | Demo treasuries: CRE simulator mock forwarder, no DON signature check. Live treasury (`deployments/devnet.live.json`, 7 Oct): deployed workflow on a live DON, production Keystone forwarder, approve and reject verified end to end (`evidence/cre/2026-10-07-live-don-e2e.md`) | On demo treasuries anyone on devnet can deliver an "approved" report (human votes are still required) | Move every treasury to the live GuardConfig | High (demo), closed on the live treasury |
| 3 | Workflow provenance | Guard checks the 20-byte workflow owner only | Any workflow of the same owner could report | Bind the workflow ID (or a per-workflow key) in the guard once the live Solana report path exposes it | High |
| 4 | Confidential execution | TEE simulated locally; no attestation. The live DON runs `execution: "don"`: the policy is a Vault DON secret visible to node operators at run time | Policy and screening inputs are not hardware-protected | Confidential Workflows enrollment (private beta), then `execution: "tee"`; verify attestation | High |
| 5 | Transmitter key | Hot key on the server pays report transactions | Theft drains its SOL (it cannot approve or move treasury funds) | Small balance, alerts, separate key per runner, KMS-backed signing | Low |
| 6 | Secrets storage | `.env` files on the EC2 box | Server compromise exposes RPC, Scorechain and policy secrets | AWS SSM Parameter Store / Secrets Manager; rotate the Scorechain key and the CRE API key (both were pasted in chat once) | Medium |
| 7 | Token authority | mUSD mint authority is the deployer key | Unlimited minting of the demo token | Real USDC (or a mint with no authority) in production | Low (demo only) |

## Oracle and data

| # | Gap | Today | Risk | Production fix | Severity |
|---|---|---|---|---|---|
| 8 | DON consensus | Live DON (10 nodes) exercised on 7 Oct; it surfaced and we fixed a provider-health split and a reply-shape check. Fault bound not verified by us | Provider rate limits across 10 nodes (QuickNode failed on up to 5 nodes) | Higher RPC tiers; verify the DON's fault bound | Medium |
| 9 | RPC sources | Same 3 providers (QuickNode, Helius, Alchemy) for every node, 2-of-3 | Two colluding or identically wrong providers mislead every node | More, independent providers; per-operator diversity | Medium |
| 10 | Destination freshness | Follow-up destination read skips the slot pin (CRE 15-call limit) | Slightly older view of the destination account | Guard re-checks owner and mint at execution, so the risk is bounded; pin when limits allow | Low |
| 11 | Screening scope | Scorechain sanctions only | No wallet-risk scoring; screening outage blocks payments (fail closed) | Add a verified risk provider and thresholds | Medium |
| 12 | Report size | 117-byte payload, 3 bytes under CRE's 265-byte Solana limit | No room for new fields | Next version must hash or compress fields | Low |

## Guard and payment model

| # | Gap | Today | Risk | Production fix | Severity |
|---|---|---|---|---|---|
| 13 | No recovery path | If CRE or the runner is down, nothing can execute | Funds safe but stuck | Timelocked recovery, e.g. supermajority can execute after N days without a review | High |
| 14 | Membership changes | Resolved (7 Oct): `guarded_config_execute` lets members add or remove voters and change the threshold after a vote; spending limits, rent collector and Execute members stay impossible | Policy for who may join is only the members' vote (no CRE review of membership) | Optional CRE review of membership changes | Low |
| 15 | One review per transaction | Rejected, expired or late (> 900 s) reviews cannot be retried | Re-propose the payment | Review generations (`RequestHead`) | Low |
| 16 | Payment types | One instruction per payment: SOL transfer or legacy SPL `TransferChecked` to an existing token account | No batches, ATA creation, Token-2022, lookup tables, swaps | Extend decoder, policy and guard binding per instruction type | Medium |
| 17 | Limits | Per-payment cap only | Many small payments bypass a daily budget | On-chain cumulative counters updated atomically at execution | Medium |
| 18 | Treasury size | Up to 11 humans per treasury (one-transaction creation, with compute budget instructions, fits 1232 bytes) | Large committees not supported | Two-step creation | Low |
| 19 | Audit | Guard not audited. The durable-nonce check reads instruction 0 only, which matches the runtime: Solana honours a durable nonce only when `AdvanceNonceAccount` is the first instruction | Undiscovered bugs | External audit; internal security review before any mainnet use | High |
| 20 | Dependency | Squads v4 is upgradable by the Squads team | External trust | Accept (audited, widely used) or pin a verified build | Low |

## Policy

| # | Gap | Today | Risk | Production fix | Severity |
|---|---|---|---|---|---|
| 21 | Policy changes | Closed on devnet (7 Oct): members vote a policy change in Squads; the guard applies it after a waiting period (`max(time lock, 300 s)`), and approvals under the old policy stop working. The workflow fetches the document by hash and verifies it | Signers who reach the threshold can still loosen the policy after the wait (members can cancel during it). The workflow fetches each treasury's document by hash from the runner store, so no operator step | CRE review of policy changes (screen added addresses); encrypted policy store read by the TEE | Medium |
| 22 | Shared policy | Every UI-created treasury starts with the deployment's policy; each can then vote its own (the registry serves every document by hash) | The first policy is shared | Policy chosen at creation | Low |
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
