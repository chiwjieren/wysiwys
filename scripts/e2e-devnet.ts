// End-to-end scenarios on devnet against the test treasury (deployments/devnet.json, keys/signer-1..3).
// Usage: npx tsx scripts/e2e-devnet.ts [scenario ...]   (default: all)
// The review step is the local stand-in (scripts/lib/local-review.ts) delivered through the CRE simulator's
// mock forwarder; it is labelled as such in the output. Writes evidence to evidence/e2e/.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Connection, Keypair } from "@solana/web3.js";
import decoderPkg from "../packages/decoder/package.json";
import type { Deployment } from "./lib/bootstrap";
import { EXPECTED, SCENARIOS, loadE2eContext, runScenario, type Outcome, type ScenarioName } from "./lib/e2e";

const root = resolve(__dirname, "..");
try {
  process.loadEnvFile(join(root, ".env"));
} catch {
  // No .env: use the process environment.
}

async function main() {
  const env = process.env;
  const wanted = process.argv.slice(2);
  for (const w of wanted) if (!(SCENARIOS as readonly string[]).includes(w)) throw new Error(`unknown scenario ${w}; known: ${SCENARIOS.join(", ")}`);
  const names = (wanted.length ? wanted : SCENARIOS) as ScenarioName[];
  const rpcUrl = env.HELIUS_DEVNET_RPC_URL || "https://api.devnet.solana.com";
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(env.SOLANA_WALLET || join(homedir(), ".config/solana/id.json"), "utf8"))),
  );
  const deployment: Deployment = JSON.parse(readFileSync(join(root, "deployments/devnet.json"), "utf8"));
  const policy = JSON.parse(readFileSync(join(root, "workflow/policy.json"), "utf8"));
  const ctx = loadE2eContext({
    connection: new Connection(rpcUrl, "confirmed"),
    payer,
    keysDir: join(root, "keys"),
    deployment,
    policy,
    decoderVersion: `${decoderPkg.name}@${decoderPkg.version}`,
  });
  console.log(`[e2e] devnet ${new URL(rpcUrl).host}, multisig ${deployment.multisig}`);
  console.log("[e2e] review step: LOCAL STAND-IN for the CRE workflow, delivered via the CRE simulator mock forwarder");

  const results: Outcome[] = [];
  for (const name of names) {
    console.log(`[e2e] ${name}: ${EXPECTED[name].describe}`);
    results.push(await runScenario(ctx, name));
  }
  const dir = join(root, "evidence/e2e");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-devnet.json`);
  writeFileSync(
    file,
    JSON.stringify({ cluster: "devnet", multisig: deployment.multisig, reviewer: "local stand-in via mock forwarder", results }, null, 2) + "\n",
  );
  console.log(`[e2e] evidence: ${file}`);
  const failed = results.filter((r) => !r.matches);
  if (failed.length) {
    console.error(`[e2e] ${failed.length} scenario(s) did not match: ${failed.map((f) => f.name).join(", ")}`);
    process.exit(1);
  }
  console.log(`[e2e] all ${results.length} scenario(s) matched`);
}

main().catch((e) => {
  console.error(`[e2e] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
