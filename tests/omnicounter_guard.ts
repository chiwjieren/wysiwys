import * as anchor from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";

const SQUADS_PROGRAM_ID = new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
const SQUADS_PROGRAM_CONFIG = new PublicKey("BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr");

describe("smoke", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.omnicounterGuard as anchor.Program;

  it("guard is deployed to the local validator", async () => {
    const info = await provider.connection.getAccountInfo(program.programId);
    expect(info?.executable).to.equal(true);
  });

  it("Squads v4 and its ProgramConfig are loaded", async () => {
    const squads = await provider.connection.getAccountInfo(SQUADS_PROGRAM_ID);
    expect(squads?.executable).to.equal(true);
    const config = await provider.connection.getAccountInfo(SQUADS_PROGRAM_CONFIG);
    expect(config?.owner.toBase58()).to.equal(SQUADS_PROGRAM_ID.toBase58());
  });
});
