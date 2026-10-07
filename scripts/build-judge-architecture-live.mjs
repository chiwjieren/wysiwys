import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'docs/diagrams');
await mkdir(resolve(out, 'assets'), { recursive: true });
const names = ['chainlink', 'chainlink-symbol', 'cre', 'squads', 'solana', 'aws', 'quicknode', 'helius', 'alchemy', 'scorechain'];
// Reuse the official brand assets already saved in the pre-sync recovery snapshot.
for (const name of [...names.map(n => `${n}.svg`), 'sources.json']) {
  const path = resolve(out, 'assets', name);
  try { await readFile(path); }
  catch { await writeFile(path, execFileSync('git', ['show', `stash@{0}:docs/diagrams/assets/${name}`], { cwd: root })); }
}
const logos = Object.fromEntries(await Promise.all(names.map(async n => [n, 'data:image/svg+xml;base64,' + (await readFile(resolve(out, 'assets', `${n}.svg`))).toString('base64')])));
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const xml = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const c = { bg: '#F5F7FC', ink: '#172238', muted: '#526487', blue: '#3754FF', blueFill: '#EEF2FF',
  line: '#CED9F3', purple: '#7546E8', purpleFill: '#F5F0FF', green: '#177F68', greenFill: '#EDF9F5',
  amber: '#975A06', amberFill: '#FFF5DA', white: '#FFFFFF' };
const p = [];
function rect(x,y,w,h,fill=c.white,stroke=c.line,r=22,extra='') { p.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="2" ${extra}/>`); }
function text(x,y,s,size=23,color=c.ink,weight=400,extra='') { p.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}" ${extra}>${xml(s)}</text>`); }
function logo(n,x,y,w,h) { p.push(`<image href="${logos[n]}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMinYMid meet"/>`); }
function arrow(d,color=c.blue,dashed=false) { p.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" ${dashed?'stroke-dasharray="10 9"':''} marker-end="url(#${color===c.purple?'purple':color===c.green?'green':'blue'}Arrow)"/>`); }
function pill(x,y,w,s,fill=c.blueFill,color=c.blue,size=19) { rect(x,y,w,33,fill,fill,9); text(x+13,y+23,s,size,color,600); }
function step(x,y,n,title,color=c.blue) { rect(x,y-26,34,34,color,color,10); text(x+17,y-2,n,22,c.white,700,'text-anchor="middle"'); text(x+49,y,title,29,c.ink,600); }
function person(x,y) { p.push(`<circle cx="${x}" cy="${y}" r="23" fill="#E8DCFF"/><circle cx="${x}" cy="${y-5}" r="7" fill="${c.purple}"/><path d="M ${x-12} ${y+13} Q ${x-10} ${y+2} ${x} ${y+2} Q ${x+10} ${y+2} ${x+12} ${y+13} Z" fill="${c.purple}"/>`); }

// Heading and the invariant are deliberately readable before any component detail.
rect(80,59,7,72,c.blue,c.blue,0);
text(105,94,'Wysiwys',48,c.ink,600);
text(105,128,'What You See Is What You Sign',23,c.muted);
text(2480,89,'Treasury payment firewall',31,c.ink,500,'text-anchor="end"');
text(2480,126,'Exact transaction. Independent review. On-chain enforcement.',22,c.muted,400,'text-anchor="end"');
rect(80,160,2400,75,c.ink,c.ink,15);
text(112,209,'PAYMENT = human Squads approvals AND a matching, current, unexpired, unused Guard approval',31,c.white,600);
text(80,283,'01  PROPOSE & APPROVE',25,c.ink,600);
text(710,283,'02  VERIFY INDEPENDENTLY WITH CRE',25,c.ink,600);
logo('solana',1860,259,30,25);
text(1904,283,'03  ENFORCE ON SOLANA DEVNET',25,c.ink,600);

// Left column: proposal and authenticated event adapter. These never authorize execution.
rect(80,312,550,131);
text(109,351,'Treasury operator',29,c.ink,600); logo('aws',521,328,77,37);
text(109,389,'Next.js app + connected wallet',24);
text(109,421,'Choose recipient, token and integer amount.',22,c.muted);
arrow('M 355 444 V 464');
rect(80,474,550,210);
rect(111,495,29,27,'none',c.ink,5); text(159,521,'Squads v4 + Guard',27,c.ink,600);
step(109,568,'1','Store payment + request review');
text(109,608,'VaultTransaction + Proposal + request_review',22,c.muted);
text(109,641,'Guard computes tx_hash; creates PENDING Review.',21,c.muted);
pill(109,650,371,'Funds stay in the Squads vault',c.blueFill,c.blue,19);
arrow('M 355 685 V 708');
rect(80,718,550,185);
step(109,760,'2','Finalized event → runner');
logo('aws',523,734,73,36);
text(109,801,'WebSocket listener + startup / 60 s backfill',22,c.muted);
text(109,837,'Dedupe, retry; SQLite stores activity history.',22,c.muted);
text(109,873,'Signed CRE gateway trigger: identifiers only.',22,c.blue,500);
arrow('M 630 809 H 670 V 400 H 710');
text(682,700,'Authenticated HTTP',19,c.blue,500,'transform="rotate(-90 682 700)"');

// Human votes are a separate authorization path. They are not DON operator votes.
rect(80,948,550,194,c.purpleFill,'#DDCEFD');
text(110,988,'Independent human approval',27,c.purple,600);
rect(565,970,26,24,'none',c.ink,4);
person(137,1034); person(208,1034); person(279,1034);
text(325,1039,'3 of 3 in live demo',23,c.purple,600);
text(110,1085,'Humans propose and vote; Guard authorizes execution.',20,c.purple);
text(110,1120,'The UI reads chain state; previews are descriptive.',20,c.muted);
arrow('M 630 1041 H 653 V 1166 H 1827 V 974 H 1860',c.purple,true);
text(1050,1198,'Human votes and the Guard review may arrive in either order.',22,c.purple,500);

// Center column: actual live DON path, with two visibly separate consensus layers.
rect(710,312,1070,830,c.blueFill,'#B8C7FF');
logo('chainlink',741,337,191,40); logo('cre',952,341,34,35);
text(1000,370,'CRE',32,c.blue,500);
pill(1462,341,283,'10 nodes observed',c.white,c.blue,23);
text(741,410,'Live DON execution • TypeScript / WASM • private workflow registry',24,c.ink);

rect(735,437,1020,330,c.white,'#C7D4FF',19);
step(761,480,'3','Re-read stored Solana accounts on each node');
// Exactly ten schematic node illustrations; numbers are diagram indices, not operator identities.
for (let i=0;i<10;i++) {
  const x=760+i*98;
  p.push(`<g data-don-node="${i+1}">`);
  rect(x,502,82,55,c.blueFill,'#D6DFFF',11);
  logo('chainlink-symbol',x+10,516,24,25);
  text(x+56,538,`${i+1}`,21,c.blue,600,'text-anchor="middle"');
  p.push('</g>');
}
text(761,590,'Each node uses the same three upstream RPC providers:',22,c.muted);
rect(760,607,310,57,'#F8FAFF','#E3E9FA',12); logo('quicknode',779,619,239,32);
rect(1090,607,310,57,'#F8FAFF','#E3E9FA',12); logo('helius',1109,617,240,35);
rect(1420,607,310,57,'#F8FAFF','#E3E9FA',12); logo('alchemy',1438,618,35,34); text(1491,645,'Alchemy',27,c.ink,500);
text(761,696,'Finalized reads • shared slot floor • normalized account owners + bytes',22,c.muted);
pill(761,716,454,'2 of 3 exact snapshots per node',c.blueFill,c.blue,22);
arrow('M 1228 733 H 1255');
pill(1270,716,459,'CRE identical aggregation',c.blueFill,c.blue,22);
arrow('M 1245 768 V 791');

rect(735,801,1020,203,c.white,'#C7D4FF',19);
step(761,844,'4','Decode + evaluate the committed policy');
text(761,880,'Check tx_hash, then decode every instruction in order.',23,c.muted);
rect(760,900,524,83,'#F8FAFF','#E3E9FA',12);
text(776,929,'Whitelist • mint • cap • vault authority',23,c.ink,500);
text(776,960,'Vault DON secret / authenticated store by hash',20,c.muted);
rect(1302,900,427,83,'#F8FAFF','#E3E9FA',12);
logo('scorechain',1319,912,185,28);
text(1319,960,'Sanctions API; node results aggregated',20,c.muted);
rect(735,1018,1020,57,c.amberFill,'#F3DEAB',12);
text(761,1053,'LIVE: DON evaluation. TEE path: implemented + simulated only.',24,c.amber,600);
rect(735,1088,1020,35,'#DFE7FF','#DFE7FF',9);
text(752,1112,'117-byte report: verdict + reason + tx_hash + policy_hash + destination_hash + times',21,c.ink);
arrow('M 1780 1104 H 1810 V 392 H 1860');
text(1801,750,'DON-signed report',20,c.blue,600,'transform="rotate(-90 1801 750)"');

// Right column: production report delivery and atomic payment execution.
rect(1860,312,620,169);
step(1889,359,'5','Production Keystone forwarder');
text(1889,403,'Verifies DON-signed reports.',24,c.muted);
text(1889,440,'SolanaClient.writeReport → forwarder → Guard',22,c.muted);
pill(1889,447,379,'Live forwarder on Solana devnet',c.greenFill,c.green,19);
arrow('M 2170 484 V 507');
rect(1860,517,620,185);
step(1889,561,'6','Guard records the verdict');
text(1889,600,'Authenticates forwarder + workflow owner.',23,c.muted);
text(1889,634,'Checks hashes, report deadline and expiry.',23,c.muted);
pill(1889,655,193,'APPROVED',c.greenFill,c.green,22);
pill(2096,655,183,'REJECTED','#FFF0EE','#AC3E35',22);
arrow('M 2170 704 V 727',c.green);

rect(1860,737,620,309,c.greenFill,'#A3DBC9');
step(1889,782,'7','Guarded execution',c.green);
pill(1889,803,270,'Guard review APPROVED','#D8F0E7',c.green,20);
text(2173,828,'AND',18,c.green,600);
pill(2220,803,230,'Squads approved','#D8F0E7',c.green,20);
text(1889,876,'Current tx + policy; unexpired + unused.',23,c.green);
text(1889,913,'Live destination still matches; no durable nonce.',22,c.green);
text(1889,952,'Consume Review → executor PDA → Squads CPI',22,c.green,500);
text(1889,989,'Squads enforces votes + timelock; vault pays.',22,c.green);
text(1889,1026,'Any failure rolls back review consumption + payout.',21,c.green);
arrow('M 2170 1048 V 1071',c.green);
rect(1860,1081,620,61,c.green,c.green,16);
text(1889,1108,'Squads vault → verified recipient',25,c.white,600);
text(1889,1131,'SOL / demo mUSD • executed event → app',20,c.white);

// Management is separate from the payment approval invariant.
rect(80,1226,2400,94,c.white,c.line,16);
text(110,1264,'Separate governance paths',25,c.ink,600);
text(511,1264,'Policy: member vote → ≥5 min wait → new policy_hash; old approvals fail.',23,c.muted);
text(511,1300,'Members / threshold / timelock: voted guarded_config_execute; sole executor preserved.',23,c.muted);

rect(80,1338,2400,52,c.white,c.line,12);
text(104,1371,'VERIFIED LIVE',19,c.green,700);
text(278,1371,'Clean payments executed • lookalike rejected • production-forwarder receipts finalized',22,c.ink);
text(2462,1371,'Devnet, test keys only',21,c.muted,500,'text-anchor="end"');
text(80,1420,`Checked 7 Oct 2026 • repo ${commit} • 10 nodes from recorded live runs; current membership not re-enumerated`,18,c.muted);
text(2480,1420,'No TEE attestation claimed for the live path.',18,c.amber,500,'text-anchor="end"');

const defs = ['blue','purple','green'].map(n => `<marker id="${n}Arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 Z" fill="${c[n]}"/></marker>`).join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="2560" height="1440" viewBox="0 0 2560 1440" role="img" aria-labelledby="title desc"><title id="title">Wysiwys live devnet payment firewall architecture</title><desc id="desc">A proposal triggers a ten-node CRE workflow. Every node compares three independent RPC providers with two-of-three exact source agreement, followed by CRE consensus. A signed report reaches the Guard through the production Keystone forwarder. Payment requires both human Squads approvals and the exact current, unexpired, unused Guard approval. Live evaluation runs on DON nodes. The TEE path is implemented and simulated only. Ten nodes are observed in recorded live runs, not freshly enumerated.</desc><defs>${defs}</defs><rect width="2560" height="1440" fill="${c.bg}"/><g font-family="Arial, Helvetica, sans-serif">${p.join('\n')}</g></svg>`;
const base = resolve(out,'wysiwys-judge-architecture-live');
await writeFile(base+'.svg',svg);
await sharp(Buffer.from(svg), { density: 144 }).resize(3840,2160).png().toFile(base+'.png');
await sharp(Buffer.from(svg)).resize(1920,1080).png().toFile(base+'-preview.png');
await writeFile(base+'.html',`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wysiwys | Live devnet architecture</title><style>html,body{margin:0;background:${c.bg};}main{max-width:2560px;margin:auto}svg{display:block;width:100%;height:auto} @media print{@page{size:16in 9in;margin:0}main{width:16in}}</style><main>${svg}</main></html>`);
console.log('Generated editable SVG, 3840x2160 PNG, 1920x1080 preview and standalone HTML in docs/diagrams.');
