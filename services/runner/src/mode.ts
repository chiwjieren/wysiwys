import type { CreRunner, ReviewRequest } from "./cre";
import type { Store, TriggerRequest } from "./store";
import type { Trigger } from "./trigger";

// Which review path this runner serves: the live DON (CRE gateway) or the simulator
// (`cre workflow simulate --broadcast`). Switchable at run time by the operator (POST /admin/mode).
// Switching never touches chain state: each treasury's GuardConfig fixes its path, and the runner
// only skips the other path's reviews.

export type ReviewMode = "live" | "simulator";
export type ReviewPath = {
  /** Forwarder program this path's treasuries name in their GuardConfig. */
  forwarder: string;
  /** Path-filtered trigger for new reviews. */
  trigger: Trigger;
  /** POST /review for one review. */
  review: Pick<CreRunner, "run">;
};

const MODES: ReviewMode[] = ["live", "simulator"];
const KEY = "reviewMode";

export class ModeSwitch implements Trigger {
  private current: ReviewMode;

  constructor(
    private readonly o: {
      paths: Partial<Record<ReviewMode, ReviewPath>>;
      store: Pick<Store, "getSetting" | "setSetting" | "requeuePendingSince">;
      /** Pending reviews newer than this are re-queued on a switch (the guard's review deadline). */
      requeueWindowSecs?: number;
      now?: () => number;
      log?: (line: string) => void;
    },
  ) {
    const available = this.available;
    if (!available.length) throw new Error("no review path configured");
    const stored = o.store.getSetting(KEY) as ReviewMode | null;
    this.current = stored && available.includes(stored) ? stored : available[0]!;
  }

  get available(): ReviewMode[] {
    return MODES.filter((m) => this.o.paths[m]);
  }

  get mode(): ReviewMode {
    return this.current;
  }

  get forwarder(): string {
    return this.o.paths[this.current]!.forwarder;
  }

  set(mode: ReviewMode): void {
    if (!MODES.includes(mode) || !this.o.paths[mode]) throw new Error(`review path "${mode}" is not configured on this runner`);
    const previous = this.current;
    this.current = mode;
    this.o.store.setSetting(KEY, mode);
    if (previous === mode) return;
    // Reviews the old path skipped were marked handled; give the new path the ones still inside the deadline.
    const now = Math.floor((this.o.now ?? Date.now)() / 1000);
    const requeued = this.o.store.requeuePendingSince(now - (this.o.requeueWindowSecs ?? 900));
    (this.o.log ?? console.log)(`[runner] review path switched: ${previous} -> ${mode} (${requeued} pending review(s) re-queued)`);
  }

  send(req: TriggerRequest): Promise<void> {
    return this.o.paths[this.current]!.trigger.send(req);
  }

  run(req: ReviewRequest) {
    return this.o.paths[this.current]!.review.run(req);
  }
}
