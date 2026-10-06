"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { MOCK_NOW, mockPayouts, mockTrades } from "./data";
import { transitionPayout, canInitiateTrade } from "./settlement";
import type { MockAction, PayoutView } from "./types";

type MockContext = {
  payouts: PayoutView[];
  now: number;
  loaded: boolean;
  dispatch: (id: string, action: MockAction) => void;
  propose: (tradeId: string) => string | undefined;
  observeReview: (id: string) => void;
};
const Context = createContext<MockContext | null>(null);
const storageKey = "wysiwys.mock-payouts.v1";
function persist(records: PayoutView[]) {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(records));
  } catch {
    /* Storage may be disabled. In-memory interaction still works. */
  }
}

/** MOCK BACKEND BOUNDARY: tab-local records and timers simulate asynchronous
 * verification, confirmation and the listener's separate trade update.
 * Session storage preserves sample proposals across refresh/navigation. It contains
 * no keys or secrets and is never trusted to authorize a real payout.
 * Replace storage/timers with subscribed chain/runner updates during integration.
 */
export function MockSettlementProvider({ children }: { children: ReactNode }) {
  const [payouts, setPayouts] = useState(() =>
    mockPayouts.map((p) => ({ ...p })),
  );
  const [now, setNow] = useState(MOCK_NOW);
  const [loaded, setLoaded] = useState(false);
  const [observedId, setObservedId] = useState("");
  const nextId = useRef(105);
  const observeReview = useCallback((id: string) => setObservedId(id), []);
  useEffect(() => {
    try {
      const stored = JSON.parse(
        sessionStorage.getItem(storageKey) || "null",
      ) as PayoutView[] | null;
      if (
        Array.isArray(stored) &&
        stored.every(
          (p) =>
            typeof p.id === "string" &&
            mockTrades.some((t) => t.id === p.tradeId),
        )
      ) {
        setPayouts(stored);
        nextId.current =
          Math.max(
            104,
            ...stored.map((p) => Number(p.id)).filter(Number.isFinite),
          ) + 1;
      }
    } catch {
      /* Invalid sample storage resets to the Figma fixtures. */
    }
    setLoaded(true);
    const timer = setInterval(() => setNow((time) => time + 1000), 1000);
    return () => clearInterval(timer);
  }, []);
  const update = (change: (records: PayoutView[]) => PayoutView[]) =>
    setPayouts((records) => {
      const changed = change(records);
      persist(changed);
      return changed;
    });
  const dispatch = (id: string, action: MockAction) =>
    update((records) =>
      records.map((record) =>
        record.id === id
          ? transitionPayout(record, action, now, records)
          : record,
      ),
    );
  useEffect(() => {
    if (!loaded) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const payout of payouts) {
      // Start the mock decoding timer only once its review is visible, so a cold
      // route compilation cannot skip the decoding state the operator must see.
      const action =
        payout.stage === "decoding" && payout.id === observedId
          ? "verificationComplete"
          : payout.stage === "executing"
            ? "executionConfirmed"
            : payout.stage === "executed" && !payout.tradeSettled
              ? "tradeSettled"
              : undefined;
      if (action)
        timers.push(
          setTimeout(
            () =>
              update((records) =>
                records.map((record) =>
                  record.id === payout.id
                    ? transitionPayout(record, action, now, records)
                    : record,
                ),
              ),
            action === "tradeSettled" ? 3000 : 2400,
          ),
        );
    }
    return () => timers.forEach(clearTimeout);
    // The mock clock must not restart in-flight verification timers every second.
    // Backend subscriptions replace this effect, including expiry revalidation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payouts, observedId, loaded]);
  const propose = (tradeId: string) => {
    const trade = mockTrades.find((t) => t.id === tradeId);
    if (!trade || !canInitiateTrade(trade, payouts, now)) return;
    const id = String(nextId.current++);
    const record: PayoutView = {
      id,
      tradeId,
      stage: "decoding",
      votes: 0,
      clientReceived: trade.id !== "OTC-10427",
      destinationMatches: true,
      expiresAt: new Date(
        Math.min(now + 15 * 60 * 1000, Date.parse(trade.validUntil)),
      ).toISOString(),
      reason:
        trade.id === "OTC-10427" ? "client payment not received" : undefined,
      tradeSettled: false,
    };
    const changed = [record, ...payouts];
    persist(changed);
    setPayouts(changed);
    return id;
  };
  return (
    <Context.Provider
      value={{ payouts, now, loaded, dispatch, propose, observeReview }}
    >
      {children}
    </Context.Provider>
  );
}
export function useMockSettlement() {
  const context = useContext(Context);
  if (!context) throw new Error("MockSettlementProvider is required.");
  return context;
}
