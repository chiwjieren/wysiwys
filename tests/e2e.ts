import { Keypair, PublicKey } from "@solana/web3.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { policyHash } from "@wysiwys/shared";
import { bootstrap } from "../scripts/lib/bootstrap";
import { EXPECTED, SCENARIOS, loadE2eContext, runScenario, type E2eContext } from "../scripts/lib/e2e";
import { testProvider } from "./helpers/provider";
import { guardProgram, payer } from "./helpers/guard";

// The devnet end-to-end flow, on the local validator with the same forwarder, owner and policy setup.
describe("e2e scenarios (local validator, mock forwarder, stand-in reviewer)", () => {
  const provider = testProvider();
  const connection = provider.connection;
  const keysDir = join(mkdtempSync(join(tmpdir(), "wysiwys-e2e-")), "keys");
  const DECODER = "@wysiwys/decoder@test";
  let ctx: E2eContext;

  before(async () => {
    const base = {
      connection, payer: payer(), guardProgramId: guardProgram().programId, keysDir,
      token: { name: "Mock USD", symbol: "mUSD", uri: "", decimals: 6 }, vaultBalance: 1_000_000n * 10n ** 6n,
      lookalikePrefix: 1, log: () => {},
    };
    const first = await bootstrap(base);
    const policy = {
      version: 1,
      salt: "ab".repeat(16),
      allowedPrograms: ["11111111111111111111111111111111", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
      allowedInstructions: ["system:transfer", "spl-token:transferChecked"],
      allowedMints: [{ mint: first.mint, decimals: 6 }],
      maxAmountPerPayment: "100000000000",
      destinationWhitelist: [first.recipients.whitelisted.wallet],
      screening: { provider: "scorechain", blockOn: ["SANCTIONED"] },
    };
    const deployment = await bootstrap({
      ...base,
      guard: {
        forwarderProgram: new PublicKey("7kuEAA3mSC1Tz8gQjnvH7bKFda9xSPRRin9SZbH49cNK"),
        forwarderState: new PublicKey("5Tipz3yhTBdVsDbaBxZkrp7Gjf3brGq5SKkxReefPMP7"),
        policyHash: policyHash(policy, DECODER),
        workflowOwner: new Uint8Array(20).fill(0xaa),
        maxReviewLifetime: 3600n,
        reviewDeadlineSecs: 900n,
      },
    });
    ctx = loadE2eContext({ connection, payer: payer(), keysDir, deployment, policy, decoderVersion: DECODER, log: () => {} });
  });

  for (const name of SCENARIOS) {
    it(`${name}: ${EXPECTED[name].describe}`, async () => {
      const out = await runScenario(ctx, name);
      expect(out.matches, JSON.stringify(out, null, 2)).to.equal(true);
    });
  }

  it("the clean payment actually moved mUSD to the whitelisted recipient", async () => {
    const before = await ctx.recipientBalance();
    const out = await runScenario(ctx, "clean");
    expect(out.executed).to.equal(true);
    expect((await ctx.recipientBalance()) - before).to.equal(EXPECTED.clean.amount);
  });

  it("a report from another workflow owner is refused by the guard", async () => {
    const out = await runScenario({ ...ctx, workflowOwner: new Uint8Array(20).fill(0xbb) }, "clean");
    expect(out.reportError).to.match(/InvalidWorkflow/);
    expect(out.executed).to.equal(false);
  });

  it("loads the treasury's three generated signer keys", () => {
    expect(ctx.signers).to.have.length(3);
    expect(ctx.signers.every((s) => s instanceof Keypair)).to.equal(true);
  });
});
