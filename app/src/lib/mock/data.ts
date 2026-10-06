import type { PayoutView, TradeView } from "./types";

/** MOCK DATA: all records, shortened addresses, hashes and balances match Figma.
 * These values are display fixtures, not usable deployment addresses or chain proof.
 * Replace this module and provider.tsx with adapters backed by packages/shared,
 * deployments/devnet.json, the runner and authoritative on-chain reads.
 * Providers are labels only: no Helius, Alchemy or QuickNode API is connected yet.
 */
export const mockDesk = {
  name: "Origins OTC Desk",
  vault: "7nYpGkLvRq9mWsAe5xBt3cFz8dJu6hNs4vKq2rPb8qLm",
  multisig: "3kRt…6vWx",
  guard: "4gFt…1qWe",
  executor: "8pGd…9mRx",
  policyHash: "6cf1…0a92",
  policyVersion: 1,
};
export const mockMembers = [
  { name: "Jun Heng", initials: "JH", wallet: "5rVd…7aQm" },
  { name: "Treasury signer", initials: "TS", wallet: "4xLs…2bNz" },
  { name: "Zhi Jian · You", initials: "ZJ", wallet: "9wKp…3tFn" },
];
export const mockTrades: TradeView[] = [
  {
    id: "OTC-10428",
    counterparty: "ABC Capital",
    version: 3,
    clientAmount: 500250,
    payoutAmount: 500000,
    destination: "8jS6uETdPXn4R9wY2gA7cMv5KqH3zBfN6tLsVpXrD9Qa",
    status: "Approved",
    validUntil: "2026-10-06T03:15:00Z",
    payoutId: "104",
  },
  {
    id: "OTC-10427",
    counterparty: "Delta Partners",
    version: 2,
    clientAmount: 125080,
    payoutAmount: 125000,
    destination: "6aR2uETdPXn4R9wY2gA7cMv5KqH3zBfN6tLsVpXrD8Tz",
    status: "Approved",
    validUntil: "2026-10-06T03:15:00Z",
    payoutId: "103",
  },
  {
    id: "OTC-10425",
    counterparty: "ABC Capital",
    version: 2,
    clientAmount: 500250,
    payoutAmount: 500000,
    destination: "8jS6uETdPXn4R9wY2gA7cMv5KqH3zBfN6tLsVpXrD9Qa",
    status: "Approved",
    validUntil: "2026-10-06T03:15:00Z",
    payoutId: "101",
  },
  {
    id: "OTC-10424",
    counterparty: "Gamma Trading",
    version: 1,
    clientAmount: 75050,
    payoutAmount: 75000,
    destination: "Gamma verified wallet",
    status: "Expired",
    validUntil: "2026-10-06T01:15:00Z",
  },
  {
    id: "OTC-10423",
    counterparty: "North Desk",
    version: 2,
    clientAmount: 25020,
    payoutAmount: 25000,
    destination: "North verified wallet",
    status: "Cancelled",
    validUntil: "2026-10-06T03:15:00Z",
  },
];
// A fixed mock clock keeps the reviewed screenshot reproducible even after hackathon day.
// Production must use actual expiry from chain, with refreshed reads before every action.
export const MOCK_NOW = Date.parse("2026-10-06T02:42:00Z");
const expiry = "2026-10-06T02:56:32Z";
export const mockPayouts: PayoutView[] = [
  {
    id: "104",
    tradeId: "OTC-10428",
    stage: "approved",
    votes: 2,
    clientReceived: true,
    destinationMatches: true,
    expiresAt: expiry,
    tradeSettled: false,
  },
  {
    id: "103",
    tradeId: "OTC-10427",
    stage: "rejected",
    votes: 0,
    clientReceived: false,
    destinationMatches: true,
    reason: "client payment not received",
    expiresAt: expiry,
    tradeSettled: false,
  },
  {
    id: "101",
    tradeId: "OTC-10425",
    stage: "rejected",
    votes: 0,
    clientReceived: true,
    destinationMatches: false,
    reason: "destination mismatch",
    expiresAt: expiry,
    tradeSettled: false,
  },
  {
    id: "unavailable",
    tradeId: "OTC-10428",
    stage: "unavailable",
    votes: 0,
    clientReceived: false,
    destinationMatches: true,
    expiresAt: expiry,
    tradeSettled: false,
  },
];
export const mockHoldings = [
  {
    name: "USDC",
    symbol: "$",
    detail: "Test token · SPL",
    balance: "2,000,000.00 USDC",
    value: "$2,000,000.00",
  },
  {
    name: "Solana",
    symbol: "S",
    detail: "SOL",
    balance: "254.00 SOL",
    value: "$25,400.00",
  },
];
export const mockActivity = [
  { text: "Jun Heng approved payout for OTC-10428", time: "12 minutes ago" },
  { text: "Client payment confirmed · OTC-10428", time: "1 hour ago" },
];
export const mockProviders = ["Helius", "Alchemy", "QuickNode"];
export const number = (value: number) =>
  new Intl.NumberFormat("en-US").format(value);
export const shorten = (value: string) =>
  value.length > 16 ? value.slice(0, 4) + "…" + value.slice(-4) : value;
