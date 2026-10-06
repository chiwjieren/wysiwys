// Stand-in for the cre CLI in tests. Echoes its arguments and behaves according to the txIndex.
const args = process.argv.slice(2);
const payload = JSON.parse(args[args.indexOf("--http-payload") + 1] ?? "{}");
console.log(`ARGS ${JSON.stringify(args)}`);
console.log(`CWD ${process.cwd()}`);
console.log("[USER LOG] reading https://devnet.helius-rpc.com/?api-key=SHOULD_NOT_LEAK");
if (payload.txIndex === "13") {
  console.error("workflow execution failed: boom");
  process.exit(1);
}
if (payload.txIndex === "99") setTimeout(() => {}, 60_000); // hangs until killed
else console.log("✓ Workflow Simulation Result: \"approved\"");
