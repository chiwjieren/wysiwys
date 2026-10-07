// Proposes one scenario payment on the devnet test treasury and requests its review, without
// reviewing it: leaves a Pending review for the CRE review workflow (or the runner) to process.
// Usage: npx tsx scripts/propose-devnet.ts <clean|lookalike|drift|overCap|ownershipSwap|durableNonce>
// WYSIWYS_DEPLOYMENT=deployments/devnet.live.json targets another treasury file (default deployments/devnet.json).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Connection, Keypair } from "@solana/web3.js";
import decoderPkg from "../packages/decoder/package.json";
import type { Deployment } from "./lib/bootstrap";
import { SCENARIOS, loadE2eContext, proposeScenario, type ScenarioName } from "./lib/e2e";

const root = resolve(__dirname, "..");
try {
  process.loadEnvFile(join(root, ".env"));
} catch {
  // No .env: use the process environment.
}

async function main() {
  const name = process.argv[2] as ScenarioName;
  if (!(SCENARIOS as readonly string[]).includes(name)) throw new Error(`usage: propose-devnet.ts <${SCENARIOS.join("|")}>`);
  const env = process.env;
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(env.SOLANA_WALLET || join(homedir(), ".config/solana/id.json"), "utf8"))),
  );
  const deployment: Deployment = JSON.parse(readFileSync(resolve(root, process.env.WYSIWYS_DEPLOYMENT || "deployments/devnet.json"), "utf8"));
  const ctx = loadE2eContext({
    connection: new Connection(env.HELIUS_DEVNET_RPC_URL || "https://api.devnet.solana.com", "confirmed"),
    payer,
    keysDir: join(root, "keys"),
    deployment,
    policy: JSON.parse(readFileSync(join(root, "workflow/policy.json"), "utf8")),
    decoderVersion: `${decoderPkg.name}@${decoderPkg.version}`,
  });
  const p = await proposeScenario(ctx, name);
  console.log(JSON.stringify({ scenario: name, multisig: deployment.multisig, txIndex: p.txIndex.toString(), review: p.reviewPda.toBase58(), propose: p.signatures.propose }));
}

main().catch((e) => {
  console.error(`[propose] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
