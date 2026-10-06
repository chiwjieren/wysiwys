import { VersionedTransaction } from "@solana/web3.js";
import { Buffer } from "buffer";
type Session = {
  connected: boolean;
  address?: string;
  assertConnected: () => void;
};
export function walletRpcFetch(
  session: () => Session,
  transport: typeof fetch = fetch,
): typeof fetch {
  return async (url, init) => {
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (body?.method === "sendTransaction") {
      const current = session();
      const payer = VersionedTransaction.deserialize(
        Buffer.from(body.params[0], "base64"),
      ).message.staticAccountKeys[0].toBase58();
      if (!current.connected || current.address !== payer)
        throw new Error("Connect the transaction’s wallet to continue.");
      // Read the extension's live accounts, not only React state, immediately before broadcasting.
      current.assertConnected();
    }
    return transport(url, init);
  };
}
