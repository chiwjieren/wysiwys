import { createHash, randomUUID } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import type { TriggerRequest } from "./store";
import type { Trigger } from "./trigger";

// Triggers a deployed CRE workflow through the CRE gateway. Format follows Chainlink's reference
// (cre-sdk-typescript packages/cre-http-trigger): JSON-RPC `workflows.execute`, sent as sorted-key JSON,
// with a Bearer JWT {alg: "ETH"} whose digest is sha256 of that body, signed EIP-191 by a key listed in
// the workflow's authorizedKeys; signature = base64url(r || s || recovery id 0/1).

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const b64url = (data: string | Uint8Array) => Buffer.from(data).toString("base64url");

function keyBytes(privateKey: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("gateway private key must be 0x + 64 hex characters");
  return Buffer.from(privateKey.slice(2), "hex");
}

/** EIP-55 checksummed address of a secp256k1 private key. */
export function evmAddress(privateKey: string): string {
  const addr = hex(keccak_256(secp256k1.getPublicKey(keyBytes(privateKey), false).subarray(1)).subarray(-20));
  const h = hex(keccak_256(Buffer.from(addr)));
  return `0x${[...addr].map((c, i) => (parseInt(h[i]!, 16) >= 8 ? c.toUpperCase() : c)).join("")}`;
}

/** EIP-191 personal_sign: r || s || recovery id (0 or 1). */
export function personalSign(message: string, privateKey: string): Uint8Array {
  const body = Buffer.from(message, "utf8");
  const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`), body]));
  const sig = secp256k1.sign(digest, keyBytes(privateKey));
  return Uint8Array.from([...sig.toCompactRawBytes(), sig.recovery]);
}

/** JSON with keys sorted at every level (json-stable-stringify semantics for plain JSON values). */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export type GatewayTriggerOptions = {
  url: string;
  /** Deployed workflow ID: 64 hex characters (a 0x prefix is stripped). */
  workflowId: string;
  /** EVM key whose address is in the workflow's authorizedKeys. */
  privateKey: string;
  timeoutMs?: number;
  now?: () => number;
  uuid?: () => string;
};

export class GatewayTrigger implements Trigger {
  private readonly workflowId: string;
  readonly address: string;

  constructor(private readonly opts: GatewayTriggerOptions) {
    const id = opts.workflowId.replace(/^0x/, "");
    if (!/^[0-9a-fA-F]{64}$/.test(id)) throw new Error("CRE workflow id must be 64 hex characters");
    this.workflowId = id.toLowerCase();
    this.address = evmAddress(opts.privateKey);
  }

  async send(req: TriggerRequest): Promise<void> {
    const uuid = this.opts.uuid ?? randomUUID;
    const body = stableStringify({
      jsonrpc: "2.0",
      id: uuid(),
      method: "workflows.execute",
      params: { input: { multisig: req.multisig, txIndex: req.txIndex }, workflow: { workflowID: this.workflowId } },
    });
    const iat = this.opts.now?.() ?? Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "ETH", typ: "JWT" }));
    const payload = b64url(
      JSON.stringify({
        digest: `0x${createHash("sha256").update(body).digest("hex")}`,
        iss: this.address,
        iat,
        exp: iat + 300,
        jti: uuid(),
      }),
    );
    const jwt = `${header}.${payload}.${b64url(personalSign(`${header}.${payload}`, this.opts.privateKey))}`;
    const res = await fetch(this.opts.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
      body,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
    });
    const text = await res.text();
    let reply: { error?: { message?: string }; result?: { status?: string } } = {};
    try {
      reply = JSON.parse(text);
    } catch {
      // Non-JSON reply: reported below with the status.
    }
    if (!res.ok || reply.error || reply.result?.status !== "ACCEPTED") {
      throw new Error(`CRE gateway did not accept the execution (HTTP ${res.status}): ${reply.error?.message ?? text.slice(0, 200)}`);
    }
  }
}
