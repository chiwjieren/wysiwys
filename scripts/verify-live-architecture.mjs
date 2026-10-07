import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

// Read-only audit. Public deployment identifiers only; no environment files, keys or policy documents.
const require = createRequire(import.meta.url);
const { PublicKey } = require('@solana/web3.js');
const anchor = require('@anchor-lang/core');
const sqds = require('@sqds/multisig');
const root = resolve(import.meta.dirname, '..');
const deployment = JSON.parse(await readFile(resolve(root, 'deployments/devnet.live.json'), 'utf8'));
const current = JSON.parse(await readFile(resolve(root, 'deployments/devnet.json'), 'utf8'));
const idl = JSON.parse(await readFile(resolve(root, 'packages/shared/idl/wysiwys_guard.json'), 'utf8'));
const coder = new anchor.BorshCoder(idl);
const useAppProxy = process.argv.includes('--app-proxy');
const appOrigin = 'https://app.13-250-78-41.sslip.io';
const rpcUrl = useAppProxy ? `${appOrigin}/api/squads/rpc` : 'https://api.devnet.solana.com';
const runnerUrl = 'https://runner.13-250-78-41.sslip.io';
async function rpc(method, params) {
  const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json', ...(useAppProxy ? { origin: appOrigin } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Devnet read HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`Public devnet RPC error ${body.error.code}`);
  return body.result;
}
const guard = new PublicKey(deployment.programId);
const ms = new PublicKey(deployment.multisig);
const reviewAddress = (index) => {
  const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(index));
  return PublicKey.findProgramAddressSync([Buffer.from('review'), ms.toBuffer(), bytes], guard)[0].toBase58();
};
const checks = { checkedAt: new Date().toISOString(), rpc: rpcUrl, runner: runnerUrl, cluster: 'devnet',
  guardProgram: deployment.programId, liveTreasury: deployment.multisig,
  evidenceScope: 'Fresh public chain and runner reads; no transaction submission; this script does not enumerate CRE control-plane deployments or network membership.',
  donNodes: { count: 10, basis: 'Recorded live execution evidence in evidence/cre/2026-10-07-live-don-e2e.md; membership is not freshly enumerated by this read-only check.' },
  confidentialExecution: { live: false, configuredExecution: 'don', teePath: 'Implemented and simulated only' }, errors: [] };
try {
  const res = await fetch(`${runnerUrl}/status`, { signal: AbortSignal.timeout(20000) });
  const s = await res.json();
  checks.runnerHealth = { httpStatus: res.status, healthy: s.ok, subscribed: s.listener?.subscribed,
    reviewPath: s.reviewPath, counts: s.reviews, lastBackfillAt: s.listener?.lastBackfillAt };
} catch (e) { checks.errors.push(String(e.message)); }
try {
  checks.genesis = await rpc('getGenesisHash', []);
  const addresses = [deployment.configPda, current.configPda, deployment.multisig, ...[2, 3, 4].map(reviewAddress)];
  const response = await rpc('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'finalized' }]);
  checks.finalizedContextSlot = response.context.slot;
  const values = response.value;
  checks.configs = values.slice(0, 2).map((a, i) => {
    if (!a || a.owner !== deployment.programId) throw new Error('Expected Guard-owned config account');
    const c = coder.accounts.decode('GuardConfig', Buffer.from(a.data[0], 'base64'));
    return { address: addresses[i], multisig: c.multisig.toBase58(), forwarderProgram: c.forwarder_program.toBase58(),
      forwarderState: c.forwarder_state.toBase58(), policyHash: Buffer.from(c.policy_hash).toString('hex'),
      workflowOwner: Buffer.from(c.workflow_owner).toString('hex'),
      maxReviewLifetime: c.max_review_lifetime.toString(), reviewDeadlineSecs: c.review_deadline_secs.toString() };
  });
  if (!values[2] || values[2].owner !== deployment.squadsProgram) throw new Error('Expected Squads-owned multisig');
  const m = sqds.accounts.Multisig.deserialize(Buffer.from(values[2].data[0], 'base64'))[0];
  const has = (member, permission) => sqds.types.Permissions.has(member.permissions, permission);
  checks.permissions = { threshold: m.threshold, timeLock: m.timeLock,
    humanVoteMembers: m.members.filter(a => has(a, sqds.types.Permission.Vote)).length,
    executeMembers: m.members.filter(a => has(a, sqds.types.Permission.Execute)).map(a => a.key.toBase58()),
    expectedExecutor: deployment.executorPda, configAuthority: m.configAuthority?.toBase58() ?? null,
    soleGuardExecutor: m.members.filter(a => has(a, sqds.types.Permission.Execute)).length === 1 &&
      m.members.find(a => has(a, sqds.types.Permission.Execute)).key.toBase58() === deployment.executorPda };
  checks.reviews = values.slice(3).map((a, i) => {
    if (!a || a.owner !== deployment.programId) throw new Error('Expected Guard-owned Review');
    const r = coder.accounts.decode('Review', Buffer.from(a.data[0], 'base64'));
    return { address: addresses[i + 3], txIndex: r.tx_index.toString(), status: Object.keys(r.status)[0],
      reason: r.reason, policyHash: Buffer.from(r.policy_hash).toString('hex'),
      issuedAt: r.issued_at.toString(), expiresAt: r.expires_at.toString() };
  });
} catch (e) { checks.errors.push(String(e.message)); }
const evidence = await readFile(resolve(root, 'evidence/cre/2026-10-07-live-don-e2e.md'), 'utf8');
const signatures = [...evidence.matchAll(/\| `([1-9A-HJ-NP-Za-km-z]{80,90})`(?: \([^\n|]*\))? \|/g)].map(m => m[1]);
checks.recordedReportTransactions = [];
if (useAppProxy) {
  try {
    const results = await rpc('getSignatureStatuses', [signatures, { searchTransactionHistory: true }]);
    checks.recordedReportTransactions = results.value.map((s, i) => ({ signature: signatures[i], found: Boolean(s),
      successful: s ? s.err === null : false, confirmationStatus: s?.confirmationStatus, slot: s?.slot,
      cpiEvidence: 'CPI path described in the committed live execution evidence; this proxy exposes signature status, not transaction logs.' }));
  } catch (e) { checks.errors.push(String(e.message)); }
}
if (!useAppProxy) {
for (const signature of signatures) {
  try {
    const tx = await rpc('getTransaction', [signature, { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
    checks.recordedReportTransactions.push({ signature, found: Boolean(tx), slot: tx?.slot,
      successful: tx ? tx.meta?.err === null : false,
      productionForwarderInvoked: tx?.meta?.logMessages?.some(l => l.startsWith(`Program ${deployment.guard.forwarderProgram} invoke`)) ?? false,
      guardInvoked: tx?.meta?.logMessages?.some(l => l.startsWith(`Program ${deployment.programId} invoke`)) ?? false });
  } catch (e) { checks.recordedReportTransactions.push({ signature, error: String(e.message) }); }
}
}
await mkdir(resolve(root, 'evidence/architecture'), { recursive: true });
await writeFile(resolve(root, 'evidence/architecture/2026-10-07-live-verification.json'), JSON.stringify(checks, null, 2) + '\n');
console.log(JSON.stringify(checks, null, 2));
