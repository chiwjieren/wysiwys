import { existsSync, readFileSync } from "node:fs";
import { parsePolicy, policyHash } from "@wysiwys/shared";
import type { Store } from "./store";

// Seeds the content-addressed policy store from the policy document(s) already on this box: the
// CRE project .env (CRE_POLICY_DOCUMENT, one document or a registry array). Members can then read the
// current policy without pasting it, and the workflow can fetch it by hash. Never logs contents.

export function seedPolicies(
  store: Pick<Store, "putPolicy">,
  envPath: string,
  decoderVersion: string,
  log: (line: string) => void = console.log,
): number {
  if (!existsSync(envPath)) return 0;
  const line = readFileSync(envPath, "utf8").split("\n").find((l) => l.startsWith("CRE_POLICY_DOCUMENT="));
  if (!line) return 0;
  const raw = line.slice("CRE_POLICY_DOCUMENT=".length).trim().replace(/^'(.*)'$/s, "$1").replace(/^"(.*)"$/s, "$1");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    log("[policies] CRE_POLICY_DOCUMENT is not valid JSON; nothing seeded");
    return 0;
  }
  let seeded = 0;
  (Array.isArray(value) ? value : [value]).forEach((entry, i) => {
    try {
      const doc = parsePolicy(entry);
      const hash = Buffer.from(policyHash(doc as unknown as Record<string, unknown>, decoderVersion)).toString("hex");
      store.putPolicy({ hash, multisig: "seed", document: JSON.stringify(doc), createdAt: Math.floor(Date.now() / 1000) });
      seeded++;
    } catch {
      log(`[policies] entry ${i} skipped: not a valid Policy v1 document`);
    }
  });
  return seeded;
}
