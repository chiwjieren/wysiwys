// Sets up the devnet demo (idempotent) and writes deployments/devnet.json.
// Usage: npx tsx scripts/bootstrap-devnet.ts   (env from .env; see .env.example)
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import idl from "../packages/shared/idl/wysiwys_guard.json";
import { bootstrap, guardFromEnv } from "./lib/bootstrap";

const root = resolve(__dirname, "..");
try {
  process.loadEnvFile(join(root, ".env"));
} catch {
  // No .env: use the process environment.
}
const env = process.env;

async function main() {
  const rpcUrl = env.HELIUS_DEVNET_RPC_URL || "https://api.devnet.solana.com";
  const walletPath = env.SOLANA_WALLET ?? join(homedir(), ".config/solana/id.json");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8"))));
  const connection = new Connection(rpcUrl, "confirmed");
  const guard = guardFromEnv(env); // throws on partial CRE values before anything is sent
  const decimals = 6;

  const balance = await connection.getBalance(payer.publicKey);
  console.log(`[bootstrap] rpc ${new URL(rpcUrl).host}, payer ${payer.publicKey.toBase58()} (${balance / LAMPORTS_PER_SOL} SOL)`);
  if (balance < 0.5 * LAMPORTS_PER_SOL) throw new Error("payer needs at least 0.5 SOL on devnet");
  console.log(guard ? "[bootstrap] CRE values set: guard config will be created if missing" : "[bootstrap] no CRE values: guard config skipped");

  const deployment = await bootstrap({
    connection,
    payer,
    guardProgramId: new PublicKey(idl.address),
    keysDir: join(root, "keys"),
    token: { name: env.MUSD_NAME || "Mock USD", symbol: env.MUSD_SYMBOL || "mUSD", uri: env.MUSD_URI ?? "", decimals },
    vaultBalance: BigInt(env.MUSD_VAULT_BALANCE ?? 10_000_000) * 10n ** BigInt(decimals),
    lookalikePrefix: 3,
    guard,
  });

  const out = join(root, "deployments/devnet.json");
  writeFileSync(out, JSON.stringify(deployment, null, 2) + "\n");
  console.log(`[bootstrap] wrote ${out}`);
  console.log(JSON.stringify(deployment, null, 2));
}

main().catch((e) => {
  console.error(`[bootstrap] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
