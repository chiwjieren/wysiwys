import test from "node:test";
import assert from "node:assert/strict";
import { assertWalletConnected } from "../src/lib/auth/wallet-state";
test("a synchronous Wallet Standard disconnect blocks a signature before React updates", () => {
  const wallet = { accounts: [{ address: "signer" }] };
  assertWalletConnected(wallet, "signer");
  wallet.accounts = [];
  assert.throws(
    () => assertWalletConnected(wallet, "signer"),
    /Wallet session changed/,
  );
});
test("changing the active wallet account invalidates the original signer", () => {
  assert.throws(() =>
    assertWalletConnected({ accounts: [{ address: "other" }] }, "signer"),
  );
});
