import type { DecodedAction } from "@wysiwys/decoder";
import type { PaymentPreview } from "./decoded-preview";
import { tokenAmount } from "./payments";

// Plain-language facts that help a signer decide, built only from decoded actions, chain state
// and (when a member loads it) the private policy. Fixed templates, no AI. A preview: the
// on-chain Guard review stays the verdict.

export type Insight = { tone: "ok" | "warn" | "info"; text: string };
export type KnownAddress = { address: string; name?: string; label?: string };

// Addresses are long; show the first and last 4 characters (what people actually compare).
export function short(address: string) {
  return address.length >= 32
    ? `${address.slice(0, 4)}…${address.slice(-4)}`
    : address;
}

const PAYMENT_KINDS = new Set<DecodedAction["kind"]>([
  "system.transfer",
  "token.transferChecked",
  "ata.create",
  "ata.createIdempotent",
]);

function describeExtra(action: DecodedAction): string {
  switch (action.kind) {
    case "system.advanceNonce":
      return "Also uses a durable nonce, so it could be executed long after you approve.";
    case "system.withdrawNonce":
    case "system.initializeNonce":
    case "system.authorizeNonce":
      return `Also changes durable nonce account ${short(action.nonceAccount)}.`;
    case "system.assign":
      return `Also gives program ${short(action.newOwnerProgram)} control of account ${short(action.account)}.`;
    case "token.setAuthority": {
      const to = action.newAuthority ? short(action.newAuthority) : "nobody";
      const target = short(action.target);
      return action.authorityType === "accountOwner"
        ? `Also changes the owner of token account ${target} to ${to}.`
        : action.authorityType === "closeAccount"
          ? `Also changes who can close token account ${target} to ${to}.`
          : action.authorityType === "mintTokens"
            ? `Also changes who can create new tokens of ${target} to ${to}.`
            : `Also changes who can freeze ${target} to ${to}.`;
    }
    case "token.approve":
    case "token.approveChecked":
      return `Also lets ${short(action.delegate)} spend from token account ${short(action.sourceTokenAccount)}.`;
    case "token.revoke":
      return `Also removes the spending delegate of token account ${short(action.sourceTokenAccount)}.`;
    case "token.closeAccount":
      return `Also closes token account ${short(action.tokenAccount)} and sends its balance of SOL to ${short(action.destination)}.`;
    case "token.transfer":
      return `Also moves tokens from ${short(action.sourceTokenAccount)} to ${short(action.destinationTokenAccount)} without checking the token type.`;
    default:
      return "Also contains another action.";
  }
}

export function paymentInsights(input: {
  preview: PaymentPreview;
  known: KnownAddress[];
  /** The treasury's holding of the paid asset, in base units. */
  balance?: { raw: string; decimals: number; symbol: string };
  /** Loaded on request from the member-only policy route. */
  policy?: { whitelist: string[]; cap: string };
}): { headline?: string; insights: Insight[] } {
  const { preview, known, balance, policy } = input;
  const insights: Insight[] = [];
  const decoded = preview.decoded;

  // What else is in the transaction.
  if (decoded?.status === "success") {
    const extras = decoded.actions.filter((a) => !PAYMENT_KINDS.has(a.kind));
    const transfers = decoded.actions.filter(
      (a) => a.kind === "system.transfer" || a.kind === "token.transferChecked",
    );
    const creates = decoded.actions.filter(
      (a) => a.kind === "ata.create" || a.kind === "ata.createIdempotent",
    );
    if (!extras.length && transfers.length === 1 && preview.supported)
      insights.push({
        tone: "ok",
        text: creates.length
          ? "Only this transfer and the recipient's token account. No other instructions, no owner or authority changes, no durable nonce."
          : "Only this transfer. No other instructions, no owner or authority changes, no new accounts, no durable nonce.",
      });
    if (transfers.length > 1)
      insights.push({
        tone: "warn",
        text: `Contains ${transfers.length} transfers. Check each one below.`,
      });
    for (const action of extras)
      insights.push({ tone: "warn", text: describeExtra(action) });
  } else if (decoded?.status === "unsupported")
    for (const ix of decoded.unsupportedInstructions)
      insights.push({
        tone: "warn",
        text: `Also calls program ${short(ix.programId)}, which this app cannot read. The Guard review will reject it.`,
      });
  else if (decoded?.status === "malformed")
    insights.push({
      tone: "warn",
      text: "The stored transaction could not be read completely. Do not approve it.",
    });

  const payment =
    preview.supported && preview.payments.length === 1
      ? preview.payments[0]
      : undefined;
  if (!payment) return { insights };
  const recipient = payment.recipient;
  const exact = known.find((k) => k.address === recipient);
  const who =
    exact?.name ??
    (exact?.label ? `${exact.label} ${short(recipient)}` : short(recipient));
  const headline = `Pay ${payment.amount} ${payment.symbol} to ${who}`;

  // Lookalike: same start or end as an address the treasury knows, but not that address.
  for (const k of known) {
    if (k.address === recipient) continue;
    if (
      k.address.slice(0, 3) === recipient.slice(0, 3) ||
      k.address.slice(-3) === recipient.slice(-3)
    ) {
      insights.push({
        tone: "warn",
        text: `Looks like ${k.name ?? k.label ?? "a known address"} ${short(k.address)} but is a different address. Compare every character.`,
      });
      break;
    }
  }

  if (balance) {
    const left = BigInt(balance.raw) - BigInt(payment.rawAmount);
    insights.push(
      left >= 0n
        ? {
            tone: "info",
            text: `Treasury keeps ${tokenAmount(left.toString(), balance.decimals)} ${balance.symbol} after this.`,
          }
        : {
            tone: "warn",
            text: `Treasury holds only ${tokenAmount(balance.raw, balance.decimals)} ${balance.symbol}, less than this payment.`,
          },
    );
  }

  if (policy) {
    insights.push(
      policy.whitelist.includes(recipient)
        ? { tone: "ok", text: "Recipient is on this treasury's whitelist." }
        : {
            tone: "warn",
            text: "Recipient is not on this treasury's whitelist. The Guard review will reject it.",
          },
    );
    const of = `${payment.amount} of ${tokenAmount(policy.cap, payment.decimals)} ${payment.symbol}`;
    insights.push(
      BigInt(payment.rawAmount) <= BigInt(policy.cap)
        ? { tone: "ok", text: `Within the per-payment cap (${of}).` }
        : {
            tone: "warn",
            text: `Over the per-payment cap (${of}). The Guard review will reject it.`,
          },
    );
  }
  return { headline, insights };
}
