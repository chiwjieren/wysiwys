# Policy fetched by hash (no operator step) Implementation Plan

**Goal:** after members apply a voted policy change, reviews use the new policy automatically: the CRE workflow fetches the document by the hash the treasury's GuardConfig names and verifies it, so no operator copies documents into secrets, and members never paste the current policy.

**Architecture:** the runner's policy store becomes content-addressed (keyed by hash). It is seeded at startup from the policy document(s) already on the box (the CRE project `.env`, `CRE_POLICY_DOCUMENT`) and grows with every member proposal. The workflow first looks in its `POLICY_DOCUMENT` secret (unchanged fallback); if no entry matches the treasury's hash, it fetches `GET /cre/policies/:hash` from the runner with a dedicated bearer token, parses it as Policy v1 and uses it only if its hash equals the treasury's. A missing or wrong document is POLICY_STALE (fail closed, no report). The app's member-only route stops trusting client-supplied hashes: a proposal read names the proposal index, and the server derives the hashes from the stored marker on chain.

**Tech stack:** CRE TypeScript SDK (HTTPClient in node mode with identical consensus; in the TEE handler directly), runner (node:http + SQLite), Next.js route.

## Why it is safe

- Content addressing: the guard committed to the hash on chain; a changed or invented document has a different hash and is refused. The store can only withhold, which fails closed like a runner outage.
- Confidentiality unchanged: the document travels over HTTPS behind a token that only the workflow holds (Vault DON secret). Without a TEE, node operators see it at run time, as they already do with the secret.
- Members still only see their own treasury's documents: the app checks membership on chain and that the hash is the treasury's current hash or one named by its own policy change proposal.

## Budget

HTTP calls per review: 6 health + 3 + 3 account reads + 1 policy fetch (only when the secret has no match) + 1 screening = 14 of CRE's 15.

## Tasks (TDD each)

1. **Runner store by hash.** `putPolicy` keeps `multisig` for audit; `getPolicyDocument(hash)` serves any stored document with that hash. Seed at startup from `CRE_POLICY_DOCUMENT` in `${CRE_PROJECT_DIR}/.env` (one document or an array; each parsed with `parsePolicy`, invalid entries skipped with a log line that never prints contents). Routes: `GET /cre/policies/:hash` (bearer `POLICY_FETCH_TOKEN`, fail closed 503 when unset, rate limited); `GET /frontend/policies/:hash` (settlement token) replaces the per-multisig path.
2. **Workflow fetch.** Config `policyStoreUrl` (live: the public runner URL; staging and local: `http://127.0.0.1:8787`). Secret `POLICY_STORE_TOKEN`. `findPolicy(secretRegistry, hash)` returns a match or null; on null, fetch by hash (node mode + identical consensus in DON execution, directly in the TEE), parse, verify the hash. Tests: secret match needs no fetch; fetch used and verified; fetched document with another hash, 404, invalid document or transport error are POLICY_STALE with no report; call count stays within 15.
3. **App.** Policy read requests carry the proposal `index`; the route reads the proposal's vault transaction on chain, decodes the marker and fetches `hash` and `base` itself. Remove the "workflow must have the document" warnings; keep the upload fallback only for a document that is not on file.
4. **Deploy.** Generate `POLICY_FETCH_TOKEN` (runner `.env`) = `CRE_POLICY_STORE_TOKEN` (CRE `.env`, Vault DON via `cre secrets update`, one browser sign-in). Redeploy the live workflow, update `CRE_WORKFLOW_ID` on EC2, pull, rebuild, restart. Verify: a voted change applies and the next payment under it is APPROVED with no operator step.
