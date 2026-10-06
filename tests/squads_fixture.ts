import * as anchor from "@anchor-lang/core";
import * as multisig from "@sqds/multisig";
import { Keypair } from "@solana/web3.js";
import { expect } from "chai";
import { approve, createDesk, payoutIxs, proposePayout, usdc } from "./helpers/squads";
import { testProvider } from "./helpers/provider";

describe("squads desk fixture", () => {
  const provider = testProvider();
  const payer = (provider.wallet as anchor.Wallet).payer as Keypair;
  const guardId = (anchor.workspace.wysiwysGuard as anchor.Program).programId;

  it("creates an Active payout proposal", async () => {
    const desk = await createDesk(provider.connection, payer, guardId);
    const p = await proposePayout(provider.connection, desk, payoutIxs(desk, desk.counterpartyAta, usdc(500_000)));
    const proposal = await multisig.accounts.Proposal.fromAccountAddress(provider.connection, p.proposalPda, "confirmed");
    expect(proposal.status.__kind).to.equal("Active");
  });

  it("a human member cannot execute even after 3 of 3", async () => {
    const desk = await createDesk(provider.connection, payer, guardId);
    const p = await proposePayout(provider.connection, desk, payoutIxs(desk, desk.counterpartyAta, usdc(1)));
    await approve(provider.connection, desk, p.transactionIndex);
    const human = desk.members[0];
    let failed = false;
    try {
      await multisig.rpc.vaultTransactionExecute({
        connection: provider.connection, feePayer: human, multisigPda: desk.multisigPda,
        transactionIndex: p.transactionIndex, member: human.publicKey,
      });
    } catch (e) {
      failed = String(e).includes("Unauthorized") || JSON.stringify((e as any).logs ?? []).includes("Unauthorized");
    }
    expect(failed).to.equal(true);
  });
});
