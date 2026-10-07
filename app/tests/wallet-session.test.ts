import test from "node:test";
import assert from "node:assert/strict";
import {
  accountChange,
  isPhantom,
  restoreSession,
} from "../src/lib/auth/wallet-session";

// Like Phantom after a page reload: no accounts until the site calls standard:connect.
function phantom(authorized: string[] | Error) {
  const calls: unknown[] = [];
  const wallet = {
    name: "Phantom",
    accounts: [] as { address: string }[],
    features: {
      "standard:connect": {
        connect: async (input?: { silent?: boolean }) => {
          calls.push(input);
          if (authorized instanceof Error) throw authorized;
          wallet.accounts = authorized.map((address) => ({ address }));
          return { accounts: wallet.accounts };
        },
      },
    },
  };
  return { wallet, calls };
}
const usable = (wallet: { accounts: { address: string }[] }) =>
  wallet.accounts.map((a) => a.address);

test("a reload restores an already-authorized Phantom account silently", async () => {
  const { wallet, calls } = phantom(["alice"]);
  assert.equal(await restoreSession(wallet, usable), "alice");
  assert.deepEqual(calls, [{ silent: true }]);
});

test("restore never prompts and gives up quietly when Phantom has not authorized the site", async () => {
  const rejected = phantom(new Error("User rejected the request."));
  assert.equal(await restoreSession(rejected.wallet, usable), undefined);
  assert.deepEqual(rejected.calls, [{ silent: true }]);
  const none = phantom([]);
  assert.equal(await restoreSession(none.wallet, usable), undefined);
});

test("only a real account switch starts a new wallet session", () => {
  assert.deepEqual(accountChange(["alice", "bob"], "alice"), {
    kind: "same",
  });
  assert.deepEqual(accountChange(["bob"], "alice"), {
    kind: "switched",
    address: "bob",
  });
  assert.deepEqual(accountChange([], "alice"), { kind: "lost" });
  assert.deepEqual(accountChange(["bob"], undefined), {
    kind: "switched",
    address: "bob",
  });
});

test("Phantom is the only supported wallet for now", () => {
  assert.equal(isPhantom({ name: "Phantom" }), true);
  assert.equal(isPhantom({ name: "Solflare" }), false);
  assert.equal(isPhantom({ name: "Backpack" }), false);
});
