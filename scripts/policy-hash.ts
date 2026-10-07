// Prints GUARD_POLICY_HASH for a policy document: policyHash(policy, "@wysiwys/decoder@<version>").
// Usage: npx tsx scripts/policy-hash.ts [workflow/policy.json]
//        npx tsx scripts/policy-hash.ts --registry [workflow/policies] [workflow/confidential-preflight/.env]
// Prints only hashes and the decoder version; never the policy contents (the whitelist is private).
// Every document must be a valid Policy v1 (parsePolicy), so a hash commits to rules the workflow enforces.
// --registry hashes every *.json in the folder and writes them as one JSON array into CRE_POLICY_DOCUMENT
// of the CRE project .env (mode 600), so treasuries on older policies keep being reviewed after a change.
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parsePolicy, policyHash, type PolicyV1 } from "../packages/shared/src/policy";
import decoderPkg from "../packages/decoder/package.json";

const decoderVersion = `${decoderPkg.name}@${decoderPkg.version}`;
const hashOf = (p: PolicyV1) => Buffer.from(policyHash(p as unknown as Record<string, unknown>, decoderVersion)).toString("hex");

function single(path: string) {
  const policy = parsePolicy(JSON.parse(readFileSync(path, "utf8")));
  console.log(`decoder version: ${decoderVersion}`);
  console.log(`GUARD_POLICY_HASH=${hashOf(policy)}`);
}

function registry(dir: string, envPath: string) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  if (!files.length) throw new Error(`no *.json policy documents in ${dir}`);
  const seen = new Map<string, string>();
  const documents = files.map((f) => {
    let policy: PolicyV1;
    try {
      policy = parsePolicy(JSON.parse(readFileSync(join(dir, f), "utf8")));
    } catch (e) {
      throw new Error(`${f}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const hash = hashOf(policy);
    if (seen.has(hash)) throw new Error(`${f} has the same hash as ${seen.get(hash)}`);
    seen.set(hash, f);
    console.log(`${f}: ${hash}`);
    return policy;
  });
  const line = `CRE_POLICY_DOCUMENT='${JSON.stringify(documents)}'`;
  const kept = existsSync(envPath)
    ? readFileSync(envPath, "utf8").split("\n").filter((l) => !l.startsWith("CRE_POLICY_DOCUMENT="))
    : [];
  while (kept.length && kept[kept.length - 1] === "") kept.pop();
  writeFileSync(envPath, [...kept, line, ""].join("\n"), { mode: 0o600 });
  chmodSync(envPath, 0o600);
  console.log(`decoder version: ${decoderVersion}`);
  console.log(`wrote a registry of ${documents.length} policy document(s) to CRE_POLICY_DOCUMENT in ${envPath}`);
}

try {
  if (process.argv[2] === "--registry") {
    registry(resolve(process.argv[3] ?? "workflow/policies"), resolve(process.argv[4] ?? "workflow/confidential-preflight/.env"));
  } else {
    single(resolve(process.argv[2] ?? "workflow/policy.json"));
  }
} catch (e) {
  console.error(`[policy-hash] ${e instanceof Error ? e.message : String(e)}`);
  console.error("A salt can be made with: openssl rand -hex 16");
  process.exit(1);
}
