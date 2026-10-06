import * as anchor from "@anchor-lang/core";
import { Keypair } from "@solana/web3.js";
import { expect } from "chai";
import { createDesk } from "./helpers/squads";
import { POLICY_HASH, WORKFLOW_OWNER, configPda, executorPda, expectError, guardProgram, payer, setupGuardedDesk } from "./helpers/guard";
import { testProvider } from "./helpers/provider";

describe("initialize_guard", () => {
  testProvider();
  const program = guardProgram();

  const init = (multisig: anchor.web3.PublicKey, createKey: Keypair) =>
    program.methods
      .initializeGuard(Keypair.generate().publicKey, Keypair.generate().publicKey, Array.from(POLICY_HASH), Array.from(WORKFLOW_OWNER))
      .accountsPartial({ multisig, createKey: createKey.publicKey, config: configPda(multisig), executor: executorPda(multisig), payer: payer().publicKey })
      .signers([createKey])
      .rpc();

  it("stores forwarder, policy hash and bumps", async () => {
    const forwarderProgram = Keypair.generate().publicKey;
    const forwarderState = Keypair.generate().publicKey;
    const desk = await setupGuardedDesk({ forwarderProgram, forwarderState });
    const cfg = await program.account.guardConfig.fetch(desk.config);
    expect(cfg.multisig.toBase58()).to.equal(desk.multisigPda.toBase58());
    expect(cfg.forwarderProgram.toBase58()).to.equal(forwarderProgram.toBase58());
    expect(cfg.forwarderState.toBase58()).to.equal(forwarderState.toBase58());
    expect(Buffer.from(cfg.policyHash).equals(Buffer.from(POLICY_HASH))).to.equal(true);
    expect(Buffer.from(cfg.workflowOwner).equals(Buffer.from(WORKFLOW_OWNER))).to.equal(true);
    expect(executorPda(desk.multisigPda).toBase58()).to.equal(desk.executorPda.toBase58());
  });

  it("rejects a second initialization for the same multisig", async () => {
    const desk = await setupGuardedDesk();
    await expectError(init(desk.multisigPda, desk.createKey), "already in use");
  });

  it("rejects an account not owned by Squads", async () => {
    const fake = Keypair.generate();
    await expectError(init(payer().publicKey, fake), "NotSquadsAccount");
  });

  it("rejects a create_key that did not create the multisig", async () => {
    const desk = await createDesk(program.provider.connection, payer(), program.programId);
    await expectError(init(desk.multisigPda, Keypair.generate()), "WrongMultisig");
  });

  it("rejects a multisig where a human can execute", async () => {
    const desk = await createDesk(program.provider.connection, payer(), program.programId, { humanExecute: true });
    await expectError(init(desk.multisigPda, desk.createKey), "InvalidMultisigConfig");
  });

  it("rejects a multisig without the executor", async () => {
    const desk = await createDesk(program.provider.connection, payer(), program.programId, { executor: "absent" });
    await expectError(init(desk.multisigPda, desk.createKey), "InvalidMultisigConfig");
  });

  it("rejects an executor that can also vote", async () => {
    const desk = await createDesk(program.provider.connection, payer(), program.programId, { executor: "with-vote" });
    await expectError(init(desk.multisigPda, desk.createKey), "InvalidMultisigConfig");
  });

  it("rejects a controlled multisig (config authority set)", async () => {
    const desk = await createDesk(program.provider.connection, payer(), program.programId, { configAuthority: payer().publicKey });
    await expectError(init(desk.multisigPda, desk.createKey), "InvalidMultisigConfig");
  });
});
