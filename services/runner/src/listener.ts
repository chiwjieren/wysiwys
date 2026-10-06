import type { Commitment, Connection, PublicKey } from "@solana/web3.js";
import type { GuardEvent } from "./events";
import type { Store } from "./store";
import type { Trigger } from "./trigger";

/** The subset of web3.js Connection the listener uses (a fake implements it in tests). */
export type ChainSource = Pick<Connection, "getSignaturesForAddress" | "getTransaction" | "onLogs" | "removeOnLogsListener">;

export type ListenerOptions = {
  connection: ChainSource;
  programId: PublicKey;
  store: Store;
  parse: (logs: string[]) => GuardEvent[];
  trigger: Trigger;
  /** Milliseconds clock, injectable for tests. */
  now?: () => number;
  log?: (line: string) => void;
  backfillIntervalMs?: number;
  /** /status fails when the last successful backfill is older than this. */
  maxBackfillAgeMs?: number;
};

const COMMITMENT: Commitment = "finalized";

/**
 * Watches the guard program: WebSocket logs for speed, a periodic getSignaturesForAddress backfill
 * so nothing is missed, and a trigger loop that starts one CRE review per new Pending review.
 */
export class Listener {
  pageSize = 1000;
  private subscription: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastBackfillAt: number | null = null;
  private lastBackfillError: string | null = null;
  private lastLogAt: number | null = null;
  private ticking: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly o: ListenerOptions) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? console.log;
  }

  async start(): Promise<void> {
    this.subscription = this.o.connection.onLogs(
      this.o.programId,
      (l, ctx) => void this.handleLogs(l, ctx).catch((e) => this.log(`[ws] ${String(e)}`)),
      COMMITMENT,
    );
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.o.backfillIntervalMs ?? 60_000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.subscription !== null) await this.o.connection.removeOnLogsListener(this.subscription);
    this.subscription = null;
  }

  /** Backfill then send pending triggers. Runs one at a time. */
  tick(): Promise<void> {
    this.ticking ??= (async () => {
      try {
        await this.backfill();
        await this.runTriggers();
      } finally {
        this.ticking = null;
      }
    })();
    return this.ticking;
  }

  async handleLogs(l: { signature: string; err: unknown; logs: string[] }, ctx: { slot: number }): Promise<void> {
    this.lastLogAt = this.now();
    if (l.err) return;
    if (this.ingest(l.signature, ctx.slot, null, l.logs) > 0) await this.runTriggers();
  }

  /** Processes every finalized guard transaction after the cursor, oldest first. */
  async backfill(): Promise<void> {
    try {
      const cursor = this.o.store.getCursor() ?? undefined;
      const sigs: { signature: string; err: unknown }[] = [];
      let before: string | undefined;
      for (;;) {
        const page = await this.o.connection.getSignaturesForAddress(
          this.o.programId,
          { before, until: cursor, limit: this.pageSize },
          COMMITMENT as "finalized",
        );
        sigs.push(...page);
        if (page.length < this.pageSize) break;
        before = page[page.length - 1].signature;
      }
      for (const s of sigs.reverse()) {
        if (!s.err) {
          const tx = await this.o.connection.getTransaction(s.signature, {
            commitment: "finalized",
            maxSupportedTransactionVersion: 0,
          });
          if (!tx) throw new Error(`transaction ${s.signature} not available yet`);
          if (!tx.meta?.err) this.ingest(s.signature, tx.slot, tx.blockTime ?? null, tx.meta?.logMessages ?? []);
        }
        this.o.store.setCursor(s.signature);
      }
      this.lastBackfillAt = this.now();
      this.lastBackfillError = null;
    } catch (e) {
      this.lastBackfillError = String(e);
      this.log(`[backfill] ${this.lastBackfillError}`);
    }
  }

  /** Sends every pending, untriggered (or previously failed) review once. */
  async runTriggers(): Promise<void> {
    for (const req of this.o.store.pendingTriggers()) {
      try {
        await this.o.trigger.send(req);
        this.o.store.markTrigger(req.review, true);
        this.log(`[trigger] review ${req.review} (multisig ${req.multisig}, tx ${req.txIndex})`);
      } catch (e) {
        this.o.store.markTrigger(req.review, false, String(e));
        this.log(`[trigger] failed for ${req.review}: ${String(e)}`);
      }
    }
  }

  health() {
    const maxAge = this.o.maxBackfillAgeMs ?? 120_000;
    const fresh = this.lastBackfillAt !== null && this.now() - this.lastBackfillAt <= maxAge;
    return {
      ok: fresh && this.subscription !== null,
      subscribed: this.subscription !== null,
      lastBackfillAt: this.lastBackfillAt,
      lastBackfillError: this.lastBackfillError,
      lastLogAt: this.lastLogAt,
      cursor: this.o.store.getCursor(),
    };
  }

  /** Stores the guard events in one transaction's logs; returns how many were new. */
  private ingest(signature: string, slot: number | null, blockTime: number | null, logs: string[]): number {
    let added = 0;
    this.o.parse(logs).forEach((ev, idx) => {
      if (this.o.store.applyEvent(ev, { signature, idx, slot, blockTime })) added++;
    });
    return added;
  }
}
