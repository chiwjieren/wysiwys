import * as anchor from "@anchor-lang/core";
import { Connection } from "@solana/web3.js";

/**
 * AnchorProvider.env() uses "processed", which lets helpers (spl-token, Squads) fetch blockhashes
 * the preflight bank may not know yet ("Blockhash not found"). Tests use "confirmed" everywhere.
 */
export function testProvider(): anchor.AnchorProvider {
  const env = anchor.AnchorProvider.env();
  const connection = new Connection(env.connection.rpcEndpoint, "confirmed");
  const provider = new anchor.AnchorProvider(connection, env.wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);
  return provider;
}
