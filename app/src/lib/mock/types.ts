/** UI-only view models. These are not replacements for packages/shared contracts.
 * Backend integration should map authoritative records into these display fields.
 * Amounts, addresses and hashes below are for rendering, never transaction building.
 */
export type ReviewStage =
  | "decoding"
  | "approved"
  | "rejected"
  | "unavailable"
  | "executing"
  | "executed";
export type TradeView = {
  id: string;
  counterparty: string;
  version: number;
  clientAmount: number;
  payoutAmount: number;
  destination: string;
  status: "Approved" | "Expired" | "Cancelled" | "Settled";
  validUntil: string;
  payoutId?: string;
};
export type PayoutView = {
  id: string;
  tradeId: string;
  stage: ReviewStage;
  votes: number;
  clientReceived: boolean;
  destinationMatches: boolean;
  reason?: string;
  expiresAt: string;
  tradeSettled: boolean;
};
export type MockAction =
  | "verificationComplete"
  | "approve"
  | "reject"
  | "execute"
  | "executionConfirmed"
  | "tradeSettled";
