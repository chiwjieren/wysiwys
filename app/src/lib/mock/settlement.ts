import type { MockAction, PayoutView, TradeView } from "./types";

/** Frontend-only interaction rules. No signing, decoding, hashing or policy decision
 * happens here. Replace mock transitions with authoritative chain/backend updates.
 */
export function hasCommittedPayout(
  tradeId: string,
  records: PayoutView[],
  excludeId?: string,
) {
  return records.some(
    (p) =>
      p.tradeId === tradeId &&
      p.id !== excludeId &&
      (p.stage === "executing" || p.stage === "executed"),
  );
}
export function canInitiateTrade(
  trade: TradeView,
  records: PayoutView[],
  now: number,
) {
  return (
    trade.status === "Approved" &&
    Date.parse(trade.validUntil) > now &&
    !hasCommittedPayout(trade.id, records)
  );
}
function isVerified(payout: PayoutView, now: number, records: PayoutView[]) {
  return (
    payout.stage === "approved" &&
    payout.clientReceived &&
    payout.destinationMatches &&
    Number.isFinite(Date.parse(payout.expiresAt)) &&
    Date.parse(payout.expiresAt) > now &&
    !hasCommittedPayout(payout.tradeId, records, payout.id)
  );
}
export function canApprove(
  payout: PayoutView,
  now: number,
  records: PayoutView[] = [],
) {
  return isVerified(payout, now, records) && payout.votes === 2;
}
export function canExecute(
  payout: PayoutView,
  now: number,
  records: PayoutView[] = [],
) {
  return isVerified(payout, now, records) && payout.votes === 3;
}
export function getPayoutStatus(
  payout: PayoutView,
  now: number,
  records: PayoutView[] = [],
) {
  if (payout.stage === "executed")
    return payout.tradeSettled ? "Settled" : "Executed";
  if (payout.stage === "executing") return "Confirming";
  if (payout.stage === "rejected") return "Blocked";
  if (payout.stage === "unavailable") return "Unavailable";
  if (hasCommittedPayout(payout.tradeId, records, payout.id)) return "Blocked";
  if (payout.stage === "decoding") return "Decoding";
  if (
    !Number.isFinite(Date.parse(payout.expiresAt)) ||
    Date.parse(payout.expiresAt) <= now
  )
    return "Expired";
  return payout.votes === 3 ? "Ready" : "Needs approval";
}
export function transitionPayout(
  payout: PayoutView,
  action: MockAction,
  now: number,
  records: PayoutView[] = [],
): PayoutView {
  if (action === "verificationComplete" && payout.stage === "decoding") {
    if (hasCommittedPayout(payout.tradeId, records, payout.id))
      return { ...payout, stage: "rejected", reason: "trade already settled" };
    if (!payout.clientReceived || !payout.destinationMatches)
      return { ...payout, stage: "rejected" };
    return { ...payout, stage: "approved", votes: 2 };
  }
  if (action === "approve" && canApprove(payout, now, records))
    return { ...payout, votes: 3 };
  if (action === "reject" && canApprove(payout, now, records))
    return { ...payout, stage: "rejected", reason: "member rejected proposal" };
  if (action === "execute" && canExecute(payout, now, records))
    return { ...payout, stage: "executing" };
  if (action === "executionConfirmed" && payout.stage === "executing")
    return { ...payout, stage: "executed" };
  if (action === "tradeSettled" && payout.stage === "executed")
    return { ...payout, tradeSettled: true };
  return payout;
}
