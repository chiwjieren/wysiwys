import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { guardForwarderReader, PathFilteredTrigger } from "../src/path-filter";
import type { Trigger } from "../src/trigger";
import type { TriggerRequest } from "../src/store";

const LIVE = Keypair.generate().publicKey.toBase58();
const SIM = Keypair.generate().publicKey.toBase58();
const request: TriggerRequest = { review: "Rev1", multisig: Keypair.generate().publicKey.toBase58(), txIndex: "7" };

function recorder(): Trigger & { sent: TriggerRequest[] } {
  const sent: TriggerRequest[] = [];
  return { sent, send: async (r) => void sent.push(r) };
}

test("forwards a review whose treasury uses this runner's forwarder", async () => {
  const inner = recorder();
  await new PathFilteredTrigger(inner, async () => LIVE, LIVE, () => {}).send(request);
  assert.deepEqual(inner.sent, [request]);
});

test("skips a review meant for the other path (or an unguarded multisig) without calling CRE", async () => {
  for (const forwarder of [SIM, null]) {
    const inner = recorder();
    const lines: string[] = [];
    await new PathFilteredTrigger(inner, async () => forwarder, LIVE, (l) => lines.push(l)).send(request);
    assert.equal(inner.sent.length, 0);
    assert.match(lines[0]!, /skip review Rev1/);
  }
});

test("a failed GuardConfig read throws, so the listener retries instead of skipping", async () => {
  const inner = recorder();
  const filter = new PathFilteredTrigger(inner, async () => { throw new Error("rpc down"); }, LIVE, () => {});
  await assert.rejects(filter.send(request), /rpc down/);
  assert.equal(inner.sent.length, 0);
});

test("reads the forwarder program from the treasury's GuardConfig (finalized, owned by the guard)", async () => {
  const programId = Keypair.generate().publicKey;
  const ms = new PublicKey(request.multisig);
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config"), ms.toBuffer()], programId);
  // GuardConfig: discriminator (8) | multisig (32) | forwarder_program (32) | forwarder_state (32) | ...
  const data = Buffer.concat([Buffer.alloc(8, 1), ms.toBuffer(), new PublicKey(LIVE).toBuffer(), Buffer.alloc(64)]);
  const seen: Array<{ address: string; commitment: unknown }> = [];
  const accounts = new Map<string, { owner: PublicKey; data: Buffer }>([[configPda.toBase58(), { owner: programId, data }]]);
  const connection = {
    getAccountInfo: async (address: PublicKey, commitment: unknown) => {
      seen.push({ address: address.toBase58(), commitment });
      return accounts.get(address.toBase58()) ?? null;
    },
  };
  const read = guardForwarderReader(connection as never, programId);
  assert.equal(await read(request.multisig), LIVE);
  assert.deepEqual(seen[0], { address: configPda.toBase58(), commitment: "finalized" });

  accounts.set(configPda.toBase58(), { owner: Keypair.generate().publicKey, data });
  assert.equal(await read(request.multisig), null, "an account the guard does not own is not a GuardConfig");
  accounts.delete(configPda.toBase58());
  assert.equal(await read(request.multisig), null);
});
