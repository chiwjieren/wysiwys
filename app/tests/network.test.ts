import test from "node:test";
import assert from "node:assert/strict";
import { assertDevnet } from "../src/lib/squads/network";

// Independent fixture, verified against the running relay and public Devnet RPC.
const DEVNET = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

test("the full Devnet genesis hash allows chain reads and wallet actions", async () => {
  await assert.doesNotReject(() =>
    assertDevnet({ getGenesisHash: async () => DEVNET }),
  );
});

test("mainnet, testnet and truncated identities remain blocked", async () => {
  for (const genesis of [
    "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
    "EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  ]) {
    await assert.rejects(
      () => assertDevnet({ getGenesisHash: async () => genesis }),
      /devnet/i,
    );
  }
});

test("an unavailable RPC cannot enable wallet actions", async () => {
  await assert.rejects(
    () =>
      assertDevnet({
        getGenesisHash: async () => {
          throw new Error("RPC unavailable");
        },
      }),
    /unavailable/,
  );
});
