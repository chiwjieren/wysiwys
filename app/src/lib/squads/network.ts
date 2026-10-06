import type { Connection } from "@solana/web3.js";

// Solana's full Devnet cluster identity, verified with getGenesisHash.
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

/** Check the cluster for reads and signing; never trust only an RPC URL label. */
export async function assertDevnet(
  rpc: Pick<Connection, "getGenesisHash">,
): Promise<void> {
  if ((await rpc.getGenesisHash()) !== DEVNET_GENESIS)
    throw new Error("RPC is not Solana devnet. Live actions are disabled.");
}
