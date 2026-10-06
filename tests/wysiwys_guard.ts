import * as anchor from "@anchor-lang/core";
import { expect } from "chai";

describe("wysiwys_guard", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.wysiwysGuard as anchor.Program;

  it("is deployed to the local validator", async () => {
    const info = await provider.connection.getAccountInfo(program.programId);
    expect(info?.executable).to.equal(true);
  });
});
