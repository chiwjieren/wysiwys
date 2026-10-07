import { validate, type CreRunResult, type ReviewRequest } from "./cre";
import type { Trigger } from "./trigger";

// POST /review in live mode: re-triggers the deployed workflow for one review (for example after a
// failed DON run) through the CRE gateway. Like the simulator runner, success means the decision is on
// chain, never that the gateway accepted the request.

export type LiveReviewOptions = {
  /** Signed CRE gateway trigger. */
  trigger: Trigger;
  /** Forwarder program in the treasury's GuardConfig, or null without one. */
  forwarderOf: (multisig: string) => Promise<string | null>;
  /** The live Keystone forwarder this runner serves. */
  liveForwarder: string;
  /** True once a finalized, decided Review exists for the request. */
  isDecided: (request: ReviewRequest) => Promise<boolean>;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export class LiveReviewRunner {
  constructor(private readonly o: LiveReviewOptions) {}

  async run(input: ReviewRequest): Promise<CreRunResult> {
    const req = validate(input);
    const now = this.o.now ?? Date.now;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const started = now();
    const log: string[] = [];
    const done = (ok: boolean, timedOut = false): CreRunResult => ({ ok, exitCode: null, timedOut, durationMs: now() - started, log });

    const forwarder = await this.o.forwarderOf(req.multisig);
    if (forwarder === null) {
      log.push("multisig has no guard config");
      return done(false);
    }
    if (forwarder !== this.o.liveForwarder) {
      log.push(`treasury uses another review path (forwarder ${forwarder}); this runner serves the live DON`);
      return done(false);
    }
    if (await this.o.isDecided(req)) {
      log.push("review already decided on chain; nothing to re-trigger");
      return done(true);
    }
    try {
      await this.o.trigger.send({ review: "", ...req });
      log.push("CRE gateway accepted the execution");
    } catch (e) {
      log.push(e instanceof Error ? e.message : String(e));
      return done(false);
    }
    const deadline = started + (this.o.timeoutMs ?? 180_000);
    while (now() < deadline) {
      await sleep(this.o.pollMs ?? 5_000);
      if (await this.o.isDecided(req)) {
        log.push("review decided on chain");
        return done(true);
      }
    }
    log.push("no decision on chain before the timeout; check `cre execution list` for the run");
    return done(false, true);
  }
}
