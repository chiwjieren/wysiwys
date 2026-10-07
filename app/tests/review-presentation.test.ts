import test from "node:test";
import assert from "node:assert/strict";
import { paymentFields } from "../src/lib/squads/review-presentation";

const wallet = "7aqT3Dv7DZhmVKq9PMZYhcgbMU6XXKH42YAQ6QQMoEfT";
test("a decoded SOL payment displays the exact amount and wallet", () => {
  const fields = paymentFields({
    supported: true,
    lines: [`Send 0.2 SOL from the treasury vault to ${wallet}.`],
  });
  assert.equal(fields?.amount, "0.2 SOL");
  assert.equal(fields?.recipient, wallet);
});
test("token payments distinguish the wallet from the destination token account", () => {
  const fields = paymentFields({
    supported: true,
    lines: [
      `Send 5 tokens (mint mintAddress) from token account sourceAccount to wallet ${wallet} via token account tokenAccount.`,
    ],
  });
  assert.equal(fields?.recipient, wallet);
  assert.equal(fields?.destinationAccount, "tokenAccount");
  assert.equal(fields?.mint, "mintAddress");
});
test("partial or multi-payment previews do not attribute one recipient", () => {
  const line = `Send 0.2 SOL from the treasury vault to ${wallet}.`;
  assert.equal(paymentFields({ supported: false, lines: [line] }), null);
  assert.equal(paymentFields({ supported: true, lines: [line, line] }), null);
  assert.equal(
    paymentFields({ supported: true, lines: ["Unknown transfer"] }),
    null,
  );
});
