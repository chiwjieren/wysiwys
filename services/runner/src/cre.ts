import { spawn } from "node:child_process";
import { PublicKey } from "@solana/web3.js";
import type { Trigger } from "./trigger";

// Runs the CRE review workflow for one review with `cre workflow simulate`. Simulation-only demo:
// with --broadcast the report goes to the guard through the simulator's mock forwarder.

export type ReviewRequest = { multisig: string; txIndex: string };
export type CreRunResult = {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  log: string[];
};

export type CreRunnerOptions = {
  /** Executable and leading args, e.g. ["cre"]. */
  command: string[];
  /** Directory containing the CRE project.yaml. */
  projectDir: string;
  /** Workflow folder name inside the project. */
  workflow: string;
  target: string;
  broadcast: boolean;
  timeoutMs: number;
  /** Lines of output kept in the result. */
  maxLogLines?: number;
  /** Broadcast is acknowledged only after a finalized decided Review is read from chain. */
  verifyReview?: (request: ReviewRequest) => Promise<boolean>;
};

const URL_RE = /\bhttps?:\/\/\S+/g;

function validate(r: ReviewRequest): ReviewRequest {
  try {
    const multisig = new PublicKey(r.multisig).toBase58();
    if (
      multisig !== r.multisig ||
      !/^\d{1,20}$/.test(r.txIndex) ||
      BigInt(r.txIndex) < 1n ||
      BigInt(r.txIndex) > 18446744073709551615n
    )
      throw new Error();
    return { multisig, txIndex: BigInt(r.txIndex).toString() };
  } catch {
    throw new Error("invalid review identifiers");
  }
}

export class CreRunner {
  private queue: Promise<unknown> = Promise.resolve();
  private inFlight = new Map<string, Promise<CreRunResult>>();

  constructor(private readonly o: CreRunnerOptions) {}

  /** One simulation at a time; a request identical to one in flight shares its result. */
  run(input: ReviewRequest): Promise<CreRunResult> {
    let req: ReviewRequest;
    try {
      req = validate(input);
    } catch (e) {
      return Promise.reject(e);
    }
    const key = `${req.multisig}:${req.txIndex}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const p = this.queue.then(() => this.spawnOnce(req));
    this.queue = p.catch(() => undefined);
    this.inFlight.set(key, p);
    void p.finally(() => this.inFlight.delete(key));
    return p;
  }

  /** Listener trigger: throws when the simulation did not complete, so the review is retried. */
  asTrigger(): Trigger {
    return {
      send: async (r) => {
        if (!this.o.broadcast)
          throw new Error(
            "listener delivery requires broadcast; a dry run cannot acknowledge a review",
          );
        const res = await this.run({
          multisig: r.multisig,
          txIndex: r.txIndex,
        });
        if (!res.ok)
          throw new Error(
            `simulation failed (exit ${res.exitCode}${res.timedOut ? ", timed out" : ""})`,
          );
      },
    };
  }

  private spawnOnce(req: ReviewRequest): Promise<CreRunResult> {
    const [bin, ...lead] = this.o.command;
    const args = [
      ...lead,
      "workflow",
      "simulate",
      this.o.workflow,
      "--target",
      this.o.target,
      "--non-interactive",
      "--trigger-index",
      "0",
      "--http-payload",
      JSON.stringify(req),
      ...(this.o.broadcast ? ["--broadcast"] : []),
    ];
    const started = Date.now();
    return new Promise((resolve) => {
      // No shell: identifiers are validated and passed as separate arguments.
      const child = spawn(bin, args, {
        cwd: this.o.projectDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      const lines: string[] = [];
      const keep = this.o.maxLogLines ?? 200;
      const collect = (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split(/\r?\n/)) {
          if (!line.trim()) continue;
          lines.push(line.replace(URL_RE, "<url>"));
          if (lines.length > keep) lines.shift();
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, this.o.timeoutMs);
      let finishing = false;
      const finish = async (exitCode: number | null) => {
        if (finishing) return;
        finishing = true;
        clearTimeout(timer);
        let ok = exitCode === 0 && !timedOut;
        if (ok && this.o.broadcast) {
          let verificationTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            if (!this.o.verifyReview)
              throw new Error("finalized Review verifier is not configured");
            ok = await Promise.race([
              this.o.verifyReview(req),
              new Promise<never>((_, reject) => {
                verificationTimer = setTimeout(
                  () => {
                    timedOut = true;
                    reject(new Error("Review verification timed out"));
                  },
                  Math.max(1, this.o.timeoutMs - (Date.now() - started)),
                );
              }),
            ]);
            if (!ok)
              lines.push(
                "delivery unconfirmed: finalized Review is not decided; retry required",
              );
          } catch {
            ok = false;
            lines.push(
              "delivery unconfirmed: finalized Review verification failed; retry required",
            );
          } finally {
            clearTimeout(verificationTimer);
          }
        }
        resolve({
          ok,
          exitCode,
          timedOut,
          durationMs: Date.now() - started,
          log: lines.slice(-keep),
        });
      };
      child.on("error", (e) => {
        lines.push(`spawn failed: ${e.message}`);
        finish(null);
      });
      child.on("close", (code) => finish(code));
    });
  }
}
