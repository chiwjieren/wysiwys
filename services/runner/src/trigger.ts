import type { TriggerRequest } from "./store";

export interface Trigger {
  /** Starts a CRE review. Throws when the request was not accepted, so the caller retries. */
  send(req: TriggerRequest): Promise<void>;
}

/** POSTs identifiers only to the CRE workflow HTTP trigger (or the runner's POST /review). */
export class HttpTrigger implements Trigger {
  constructor(
    private readonly url: string,
    private readonly token?: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async send(req: TriggerRequest): Promise<void> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ multisig: req.multisig, txIndex: req.txIndex }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`trigger returned ${res.status}`);
  }
}

/** Used when no trigger URL is configured: logs instead of calling CRE. */
export class LogTrigger implements Trigger {
  constructor(private readonly log: (line: string) => void = console.log) {}

  async send(req: TriggerRequest): Promise<void> {
    this.log(`[trigger] no CRE_TRIGGER_URL set; would start review multisig=${req.multisig} txIndex=${req.txIndex}`);
  }
}
