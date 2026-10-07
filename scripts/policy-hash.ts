// Prints GUARD_POLICY_HASH for a policy document: policyHash(policy, "@wysiwys/decoder@<version>").
// Usage: npx tsx scripts/policy-hash.ts [workflow/policy.json]
// Prints only the hash and the decoder version; never the policy contents (the whitelist is private).
// The document must be a valid Policy v1 (parsePolicy), so the hash commits to rules the workflow enforces.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePolicy, policyHash } from "../packages/shared/src/policy";
import decoderPkg from "../packages/decoder/package.json";

const path = resolve(process.argv[2] ?? "workflow/policy.json");
const decoderVersion = `${decoderPkg.name}@${decoderPkg.version}`;
try {
  const policy = parsePolicy(JSON.parse(readFileSync(path, "utf8")));
  const hash = policyHash(policy as unknown as Record<string, unknown>, decoderVersion);
  console.log(`decoder version: ${decoderVersion}`);
  console.log(`GUARD_POLICY_HASH=${Buffer.from(hash).toString("hex")}`);
} catch (e) {
  console.error(`[policy-hash] ${e instanceof Error ? e.message : String(e)}`);
  console.error("A salt can be made with: openssl rand -hex 16");
  process.exit(1);
}
