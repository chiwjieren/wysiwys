import test from "node:test";
import assert from "node:assert/strict";
import { paymentFields } from "../src/lib/squads/review-presentation";
import type { DisplayPayment } from "../src/lib/squads/decoded-preview";

const wallet = "7aqT3Dv7DZhmVKq9PMZYhcgbMU6XXKH42YAQ6QQMoEfT";
const sol: DisplayPayment = {
  asset: "SOL",
  amount: "0.2",
  rawAmount: "200000000",
  decimals: 9,
  symbol: "SOL",
  source: "vaultAddress",
  recipient: wallet,
  destination: wallet,
};
const token: DisplayPayment = {
  asset: "token",
  amount: "100",
  rawAmount: "100000000",
  decimals: 6,
  symbol: "mUSD",
  mint: "tokenAddress",
  source: "sourceAccount",
  recipient: wallet,
  destination: "tokenAccount",
};
test("a decoded SOL payment displays the exact amount and wallet", () => {
  const fields = paymentFields({ supported: true, payments: [sol] });
  assert.equal(fields?.amount, "0.2 SOL");
  assert.equal(fields?.recipient, wallet);
  assert.equal(fields?.source, "Treasury vault");
  assert.equal(fields?.tokenAddress, undefined);
});
test("token payments show the symbol and distinguish the wallet from its token account", () => {
  const fields = paymentFields({ supported: true, payments: [token] });
  assert.equal(fields?.amount, "100 mUSD");
  assert.equal(fields?.recipient, wallet);
  assert.equal(fields?.source, "sourceAccount");
  assert.equal(fields?.destinationAccount, "tokenAccount");
  assert.equal(fields?.tokenAddress, "tokenAddress");
});
test("partial or multi-payment previews do not attribute one recipient", () => {
  assert.equal(paymentFields({ supported: false, payments: [sol] }), null);
  assert.equal(paymentFields({ supported: true, payments: [sol, sol] }), null);
  assert.equal(paymentFields({ supported: true, payments: [] }), null);
});
