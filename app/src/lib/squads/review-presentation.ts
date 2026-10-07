import type { PaymentPreview } from "./decoded-preview";

// Display fields from the decoder-driven preview's structured payments.
// This presentation helper never supplies authorization or a policy verdict.
export function paymentFields(
  preview: Pick<PaymentPreview, "supported" | "payments"> | undefined,
) {
  if (!preview?.supported || preview.payments.length !== 1) return null;
  const payment = preview.payments[0];
  return {
    amount: `${payment.amount} ${payment.symbol}`,
    recipient: payment.recipient,
    source: payment.asset === "SOL" ? "Treasury vault" : payment.source,
    tokenAddress: payment.mint,
    destinationAccount:
      payment.asset === "token" ? payment.destination : undefined,
  };
}
