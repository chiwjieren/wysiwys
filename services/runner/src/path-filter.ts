import { PublicKey, type Connection } from "@solana/web3.js";
import type { TriggerRequest } from "./store";
import type { Trigger } from "./trigger";

// A treasury's GuardConfig fixes its review path forever (simulator mock forwarder or the live Keystone
// forwarder). The runner serves one path at a time, so it skips reviews for the other path before
// spending RPC calls or a CRE execution on a report the guard would refuse.

/** Forwarder program named by a multisig's GuardConfig, or null when it has none. */
export function guardForwarderReader(connection: Pick<Connection, "getAccountInfo">, programId: PublicKey) {
  return async (multisig: string): Promise<string | null> => {
    const [config] = PublicKey.findProgramAddressSync([Buffer.from("config"), new PublicKey(multisig).toBuffer()], programId);
    const info = await connection.getAccountInfo(config, "finalized");
    // GuardConfig: discriminator (8) | multisig (32) | forwarder_program (32) | ...
    if (!info || !info.owner.equals(programId) || info.data.length < 72) return null;
    return new PublicKey(info.data.subarray(40, 72)).toBase58();
  };
}

export class PathFilteredTrigger implements Trigger {
  constructor(
    private readonly inner: Trigger,
    private readonly forwarderOf: (multisig: string) => Promise<string | null>,
    private readonly expected: string,
    private readonly log: (line: string) => void = console.log,
  ) {}

  async send(req: TriggerRequest): Promise<void> {
    const forwarder = await this.forwarderOf(req.multisig);
    if (forwarder !== this.expected) {
      this.log(`[trigger] skip review ${req.review}: treasury uses forwarder ${forwarder ?? "none"}, this runner serves ${this.expected}`);
      return;
    }
    await this.inner.send(req);
  }
}
