import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Read-only CRE replay. Local secret files are consumed here and by CRE, never printed or written
// into evidence. The local-simulation handler exits before report generation, even on decided reviews.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = resolve(root, "workflow/confidential-preflight");
for (const env of [resolve(root, ".env"), resolve(project, ".env")]) {
  if (existsSync(env)) process.loadEnvFile(env);
}
if (!process.env.CRE_POLICY_DOCUMENT) {
  const policy = resolve(root, "workflow/policy.json");
  if (!existsSync(policy))
    throw new Error(
      "Set CRE_POLICY_DOCUMENT locally or provide the gitignored workflow/policy.json before simulation",
    );
  process.env.CRE_POLICY_DOCUMENT = readFileSync(policy, "utf8");
}
const input = resolve(
  root,
  process.argv[2] ?? "evidence/cre/2026-10-07-review-local-input.json",
);
// Only identifiers may enter the public HTTP payload. No policy/API credentials are command arguments.
const identifiers = JSON.parse(readFileSync(input, "utf8")) as Record<
  string,
  unknown
>;
if (
  Object.keys(identifiers).sort().join(",") !== "multisig,txIndex" ||
  typeof identifiers.multisig !== "string" ||
  typeof identifiers.txIndex !== "string"
) {
  throw new Error(
    "HTTP payload must contain only multisig and txIndex strings",
  );
}
const child = spawn(
  "cre",
  [
    "workflow",
    "simulate",
    "review",
    "--target",
    "local-simulation",
    "--non-interactive",
    "--trigger-index",
    "0",
    "--http-payload",
    input,
  ],
  { cwd: project, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
);
// Buffer partial lines before redacting, so credentials in a split URL cannot escape sanitization.
for (const stream of [child.stdout, child.stderr]) {
  let pending = "";
  const emit = (line: string) =>
    console.log(line.replace(/\bhttps?:\/\/\S+/g, "<url>"));
  stream.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    const lines = pending.split(/\r?\n/);
    pending = lines.pop()!;
    for (const line of lines) emit(line);
  });
  stream.on("end", () => {
    if (pending) emit(pending);
  });
}
child.on("error", () => {
  console.error("CRE process could not start");
  process.exitCode = 1;
});
child.on("close", (code) => {
  process.exitCode = code ?? 1;
});
