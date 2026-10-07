import test from "node:test";
import assert from "node:assert/strict";
import type { DecodeResult } from "@wysiwys/decoder";
import type {
  DisplayPayment,
  PaymentPreview,
} from "../src/lib/squads/decoded-preview";
import { paymentInsights } from "../src/lib/squads/payment-insights";

// Shapes like the devnet demo: the lookalike shares the whitelisted wallet's first 3 characters.
const whitelisted = "7aqT3Dv7DZhmVKq9PMZYhcgbMU6XXKH42YAQ6QQMoEfT";
const lookalike = "7aqKz9WbdQe1pGxN3F5RrTyuHcVmL2sJ8oPkAiBnXwYZ";
const member = "H66oYmL2n8u8uQmyvRDWZg6AWARchz1ZzhGeVScKcztK";
const mint = "J7oqTXmkvHY6E95gD9GBud4N9opBVjjeF1TuMfYiCa1r";
const source = "5rfW369JXC13UJshLpExiJzJ378GKtTPsg2HQGoowPu8";
const tokenAccount = "6PdRfBfuKBgJ9MPuzsoiLGxa52f9rVxbj3FXNFfzqUBX";

function payment(recipient: string, raw = "100000000"): DisplayPayment {
  return {
    asset: "token",
    amount: (Number(raw) / 1e6).toString(),
    rawAmount: raw,
    decimals: 6,
    symbol: "mUSD",
    mint,
    source,
    recipient,
    destination: tokenAccount,
  };
}
const transfer = {
  instructionIndex: 0,
  kind: "token.transferChecked" as const,
  programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  sourceTokenAccount: source,
  mint,
  destinationTokenAccount: tokenAccount,
  authority: "vault",
  amount: "100000000",
  decimals: 6,
};
function preview(
  recipient: string,
  actions: DecodeResult = {
    schemaVersion: 1,
    status: "success",
    actions: [transfer],
  },
  supported = true,
): PaymentPreview {
  return {
    supported,
    lines: [],
    payments: supported ? [payment(recipient)] : [],
    decoded: actions,
  };
}
const texts = (r: ReturnType<typeof paymentInsights>) =>
  r.insights.map((i) => `${i.tone}: ${i.text}`);

test("the headline names a known member and short-forms anyone else", () => {
  assert.equal(
    paymentInsights({
      preview: preview(member),
      known: [{ address: member, name: "Alice" }],
    }).headline,
    "Pay 100 mUSD to Alice",
  );
  assert.equal(
    paymentInsights({ preview: preview(whitelisted), known: [] }).headline,
    "Pay 100 mUSD to 7aqT…oEfT",
  );
});

test("a lone transfer says nothing else is in the transaction", () => {
  const r = paymentInsights({ preview: preview(member), known: [] });
  assert.ok(
    texts(r).includes(
      "ok: Only this transfer. No other instructions, no owner or authority changes, no new accounts, no durable nonce.",
    ),
  );
});

test("hidden actions are spelled out in plain words instead", () => {
  const drift: DecodeResult = {
    schemaVersion: 1,
    status: "success",
    actions: [
      {
        instructionIndex: 0,
        kind: "system.advanceNonce",
        nonceAccount: "nonce",
        recentBlockhashesSysvar: "sysvar",
        authority: "attacker",
      },
      transfer,
      {
        instructionIndex: 2,
        kind: "token.setAuthority",
        target: source,
        authorityType: "accountOwner",
        currentAuthority: "vault",
        newAuthority: "attackerWallet",
      },
    ],
  };
  const r = paymentInsights({
    preview: preview(member, drift, false),
    known: [],
  });
  const all = texts(r).join("\n");
  assert.match(all, /warn: Also uses a durable nonce/);
  assert.match(
    all,
    /warn: Also changes the owner of token account 5rfW…wPu8 to attackerWallet/,
  );
  assert.doesNotMatch(all, /Only this transfer/);
  assert.equal(r.headline, undefined);
});

test("a lookalike of a known address is flagged, the address itself is not", () => {
  const known = [{ address: whitelisted, label: "whitelisted wallet" }];
  assert.match(
    texts(paymentInsights({ preview: preview(lookalike), known })).join("\n"),
    /warn: Looks like whitelisted wallet 7aqT…oEfT but is a different address/,
  );
  assert.doesNotMatch(
    texts(paymentInsights({ preview: preview(whitelisted), known })).join("\n"),
    /Looks like/,
  );
});

test("the treasury balance after the payment, or a shortfall", () => {
  const holding = { raw: "1000000000", decimals: 6, symbol: "mUSD" };
  assert.ok(
    texts(
      paymentInsights({
        preview: preview(member),
        known: [],
        balance: holding,
      }),
    ).includes("info: Treasury keeps 900 mUSD after this."),
  );
  assert.ok(
    texts(
      paymentInsights({
        preview: preview(member),
        known: [],
        balance: { ...holding, raw: "50000000" },
      }),
    ).includes("warn: Treasury holds only 50 mUSD, less than this payment."),
  );
});

test("the private policy check reports whitelist and cap", () => {
  const policy = { whitelist: [whitelisted], cap: "500000000" };
  assert.deepEqual(
    texts(
      paymentInsights({ preview: preview(whitelisted), known: [], policy }),
    ).filter((t) => /whitelist|cap/.test(t)),
    [
      "ok: Recipient is on this treasury's whitelist.",
      "ok: Within the per-payment cap (100 of 500 mUSD).",
    ],
  );
  const over = paymentInsights({
    preview: {
      ...preview(lookalike),
      payments: [payment(lookalike, "900000000")],
    },
    known: [],
    policy,
  });
  assert.deepEqual(
    texts(over).filter((t) => /whitelist|cap/.test(t)),
    [
      "warn: Recipient is not on this treasury's whitelist. The Guard review will reject it.",
      "warn: Over the per-payment cap (900 of 500 mUSD). The Guard review will reject it.",
    ],
  );
});

test("an unnamed but known recipient is described by its role", () => {
  assert.equal(
    paymentInsights({
      preview: preview(member),
      known: [{ address: member, label: "treasury member" }],
    }).headline,
    "Pay 100 mUSD to treasury member H66o…cztK",
  );
});
