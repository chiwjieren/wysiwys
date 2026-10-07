import type { PaymentPreview } from "./decoded-preview";

// Display fields from the existing deterministic preview templates only.
// This presentation helper never supplies authorization or a policy verdict.
export function paymentFields(
  preview: Pick<PaymentPreview, "supported" | "lines"> | undefined,
) {
  if (!preview?.supported) return null;
  const payments = preview.lines.filter((line) => line.startsWith("Send "));
  if (payments.length !== 1) return null;
  const sol =
    /^Send ([0-9.,]+ SOL) from the treasury vault to ([1-9A-HJ-NP-Za-km-z]+)\.$/.exec(
      payments[0],
    );
  if (sol)
    return {
      amount: sol[1],
      recipient: sol[2],
      source: "Treasury vault",
      mint: undefined,
      destinationAccount: undefined,
    };
  const token =
    /^Send ([0-9.,]+ tokens) \(mint (\S+)\) from token account (\S+) to wallet (\S+) via token account (\S+)\.$/.exec(
      payments[0],
    );
  return token
    ? {
        amount: token[1],
        mint: token[2],
        source: token[3],
        recipient: token[4],
        destinationAccount: token[5],
      }
    : null;
}
