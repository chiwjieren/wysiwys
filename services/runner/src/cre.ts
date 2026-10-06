import { spawn } from "node:child_process";
import { PublicKey } from "@solana/web3.js";
import type { Trigger } from "./trigger";

// Runs the CRE review workflow for one review with `cre workflow simulate`. Simulation-only demo:
// with --broadcast the report goes to the guard through the simulator's mock forwarder.

export type ReviewRequest = { multisig: string; txIndex: string };
export type CreRunResult = { ok: boolean; exitCode: number | null; timedOut: boolean; durationMs: number; log: string[] };

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
};

const URL_RE = /\bhttps?:\/\/\S+/g;

function validate(r: ReviewRequest): ReviewRequest {
  try {
    const multisig = new PublicKey(r.multisig).toBase58();
    if (multisig !== r.multisig || !/^\d{1,20}$/.test(r.txIndex) || BigInt(r.txIndex) < 1n) throw new Error();
    return { multisig, txIndex: r.txIndex };
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
        const res = await this.run({ multisig: r.multisig, txIndex: r.txIndex });
        if (!res.ok) throw new Error(`simulation failed (exit ${res.exitCode}${res.timedOut ? ", timed out" : ""})`);
      },
    };
  }

  private spawnOnce(req: ReviewRequest): Promise<CreRunResult> {
    const [bin, ...lead] = this.o.command;
    const args = [
      ...lead,
      "workflow", "simulate", this.o.workflow,
      "--target", this.o.target,
      "--non-interactive", "--trigger-index", "0",
      "--http-payload", JSON.stringify(req),
      ...(this.o.broadcast ? ["--broadcast"] : []),
    ];
    const started = Date.now();
    return new Promise((resolve) => {
      // No shell: identifiers are validated and passed as separate arguments.
      const child = spawn(bin, args, { cwd: this.o.projectDir, stdio: ["ignore", "pipe", "pipe"], env: process.env });
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
      const finish = (exitCode: number | null) => {
        clearTimeout(timer);
        resolve({ ok: exitCode === 0 && !timedOut, exitCode, timedOut, durationMs: Date.now() - started, log: lines });
      };
      child.on("error", (e) => {
        lines.push(`spawn failed: ${e.message}`);
        finish(null);
      });
      child.on("close", (code) => finish(code));
    });
  }
}
