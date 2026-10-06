import {
  CronCapability, handler, Runner, type Runtime,
  calculateAccountsHash, encodeForwarderReport, prepareSolanaReportRequest, solanaAccountMeta,
} from "@chainlink/cre-sdk";

// Spike: what metadata (workflow owner) and raw report size does the simulator produce for a
// Solana report carrying the guard's 117-byte payload v2? No write is attempted.

export type Config = { schedule: string };

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export const onCronTrigger = (runtime: Runtime<Config>): string => {
  // Payload v2 shape: 117 bytes (version 2, approve, SPL, dummy hashes and times).
  const payload = new Uint8Array(117);
  payload[0] = 2;
  payload[1] = 1;
  payload[68] = 2;
  payload.fill(0x11, 4, 36);
  payload.fill(0x22, 36, 68);
  payload.fill(0x33, 69, 101);

  // Receiver accounts as the forwarder hashes them: [state, authority, config, review].
  const accounts = [
    solanaAccountMeta("5Tipz3yhTBdVsDbaBxZkrp7Gjf3brGq5SKkxReefPMP7"),
    solanaAccountMeta("11111111111111111111111111111111"),
    solanaAccountMeta("3CkstZUS4JguoceC12wP9aMkGq41xmAY4dU9McYzQuUb"),
    solanaAccountMeta("9wCcjb74o2cWcFx8GimQQMcR1nJay9X86v1JiyV9kwya", true),
  ];
  const forwarderReport = encodeForwarderReport({ accountHash: calculateAccountsHash(accounts), payload });
  const report = runtime.report(prepareSolanaReportRequest(forwarderReport)).result();

  const raw = report.rawReport();
  const metadata = raw.slice(45, 109); // what the forwarder passes to on_report
  runtime.log(`SDK workflowOwner(): ${report.workflowOwner()}`);
  runtime.log(`SDK workflowName(): ${report.workflowName()}`);
  runtime.log(`raw report length: ${raw.length} (limit 265)`);
  runtime.log(`metadata length: ${metadata.length}`);
  runtime.log(`metadata[42..62] (guard owner slice): ${hex(metadata.slice(42, 62))}`);
  runtime.log(`metadata[32..42] (workflow_name): ${hex(metadata.slice(32, 42))}`);
  runtime.log(`payload echoed intact: ${hex(raw.slice(109 + 32 + 4)) === hex(payload)}`);
  return "ok";
};

export const initWorkflow = (config: Config) => {
  const cron = new CronCapability();
  return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
