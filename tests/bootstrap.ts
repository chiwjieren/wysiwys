import * as multisig from "@sqds/multisig";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAccount, getMint } from "@solana/spl-token";
import { Metadata } from "@metaplex-foundation/mpl-token-metadata";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { bootstrap, checkSoleExecutor, guardFromEnv, type BootstrapOptions, type GuardInit } from "../scripts/lib/bootstrap";
import { testProvider } from "./helpers/provider";
import { expectError, guardProgram, payer } from "./helpers/guard";

const { Permission } = multisig.types;

describe("bootstrap", () => {
  const provider = testProvider();
  const connection = provider.connection;
  const keysDir = join(mkdtempSync(join(tmpdir(), "wysiwys-keys-")), "keys"); // does not exist yet
  const base = (): BootstrapOptions => ({
    connection,
    payer: payer(),
    guardProgramId: guardProgram().programId,
    keysDir,
    token: { name: "Mock USD", symbol: "mUSD", uri: "", decimals: 6 },
    vaultBalance: 10_000_000n * 10n ** 6n,
    lookalikePrefix: 1,
    log: () => {},
  });
  const guard = (policyByte = 7): GuardInit => ({
    forwarderProgram: Keypair.generate().publicKey,
    forwarderState: Keypair.generate().publicKey,
    policyHash: new Uint8Array(32).fill(policyByte),
    workflowOwner: new Uint8Array(20).fill(0x11),
    maxReviewLifetime: 3600n,
    reviewDeadlineSecs: 900n,
  });
  let first: Awaited<ReturnType<typeof bootstrap>>;

  it("creates the mUSD mint with Metaplex metadata", async () => {
    first = await bootstrap(base());
    const mint = await getMint(connection, new PublicKey(first.mint));
    expect(mint.decimals).to.equal(6);
    expect(mint.mintAuthority!.toBase58()).to.equal(payer().publicKey.toBase58());
    expect(mint.freezeAuthority).to.equal(null);
    const md = await Metadata.fromAccountAddress(connection, new PublicKey(first.mintMetadata));
    expect(md.mint.toBase58()).to.equal(first.mint);
    expect(md.data.name.replace(/\0/g, "")).to.equal("Mock USD");
    expect(md.data.symbol.replace(/\0/g, "")).to.equal("mUSD");
    expect(md.updateAuthority.toBase58()).to.equal(payer().publicKey.toBase58());
    expect(first.token).to.deep.equal({ name: "Mock USD", symbol: "mUSD", uri: "", decimals: 6 });
  });

  it("stores generated keys in the keys directory with owner-only permissions", () => {
    for (const f of ["multisig-create-key.json", "signer-1.json", "signer-3.json", "musd-mint.json", "recipient.json", "lookalike.json"]) {
      expect(statSync(join(keysDir, f)).mode & 0o777, f).to.equal(0o600);
    }
  });

  it("creates a 3 of 3 Squads multisig with the guard executor as the only Execute member", async () => {
    const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, new PublicKey(first.multisig));
    expect(ms.threshold).to.equal(3);
    expect(ms.timeLock).to.equal(0);
    expect(ms.configAuthority.toBase58()).to.equal(PublicKey.default.toBase58());
    const executor = PublicKey.findProgramAddressSync([Buffer.from("executor"), new PublicKey(first.multisig).toBuffer()], guardProgram().programId)[0];
    expect(first.executorPda).to.equal(executor.toBase58());
    const byKey = new Map(ms.members.map((m) => [m.key.toBase58(), m.permissions.mask]));
    expect(byKey.get(first.executorPda)).to.equal(Permission.Execute);
    expect(first.signers).to.have.length(3);
    for (const s of first.signers) expect(byKey.get(s)).to.equal(Permission.Initiate | Permission.Vote);
    expect(byKey.size).to.equal(4);
    expect(first.vault).to.equal(multisig.getVaultPda({ multisigPda: new PublicKey(first.multisig), index: 0 })[0].toBase58());
  });

  it("funds the vault with mUSD and creates recipient token accounts", async () => {
    const vault = await getAccount(connection, new PublicKey(first.vaultTokenAccount));
    expect(vault.owner.toBase58()).to.equal(first.vault);
    expect(vault.amount).to.equal(10_000_000n * 10n ** 6n);
    for (const r of [first.recipients.whitelisted, first.recipients.lookalike]) {
      const acc = await getAccount(connection, new PublicKey(r.tokenAccount));
      expect(acc.owner.toBase58()).to.equal(r.wallet);
      expect(acc.mint.toBase58()).to.equal(first.mint);
    }
    expect(first.recipients.lookalike.wallet[0]).to.equal(first.recipients.whitelisted.wallet[0]);
    expect(first.recipients.lookalike.wallet).to.not.equal(first.recipients.whitelisted.wallet);
  });

  it("gives every signer SOL for fees", async () => {
    for (const s of first.signers) expect(await connection.getBalance(new PublicKey(s))).to.be.at.least(50_000_000);
  });

  it("leaves the guard config uninitialized without CRE values", async () => {
    expect(first.guard).to.equal(null);
    expect(await connection.getAccountInfo(new PublicKey(first.configPda))).to.equal(null);
  });

  it("is idempotent: a second run returns the same deployment and mints nothing", async () => {
    const again = await bootstrap(base());
    expect(again).to.deep.equal(first);
    const vault = await getAccount(connection, new PublicKey(first.vaultTokenAccount));
    expect(vault.amount).to.equal(10_000_000n * 10n ** 6n);
  });

  it("initializes the guard config when the CRE values are given", async () => {
    const g = guard();
    const out = await bootstrap({ ...base(), guard: g });
    const cfg = await guardProgram().account.guardConfig.fetch(new PublicKey(out.configPda));
    expect(cfg.multisig.toBase58()).to.equal(out.multisig);
    expect(cfg.forwarderProgram.toBase58()).to.equal(g.forwarderProgram.toBase58());
    expect(Buffer.from(cfg.policyHash).toString("hex")).to.equal("07".repeat(32));
    expect(out.guard).to.deep.equal({
      forwarderProgram: g.forwarderProgram.toBase58(),
      forwarderState: g.forwarderState.toBase58(),
      policyHash: "07".repeat(32),
      workflowOwner: "11".repeat(20),
      maxReviewLifetime: "3600",
      reviewDeadlineSecs: "900",
    });
    // Same values again: no-op.
    const same = await bootstrap({ ...base(), guard: { ...g } });
    expect(same.guard).to.deep.equal(out.guard);
    // Without CRE values, an existing config is still reported.
    expect((await bootstrap(base())).guard).to.deep.equal(out.guard);
  });

  it("refuses to change an existing guard config (immutable)", async () => {
    const existing = await bootstrap(base());
    const g = guard(8);
    await expectError(
      bootstrap({
        ...base(),
        guard: { ...g, forwarderProgram: new PublicKey(existing.guard!.forwarderProgram), forwarderState: new PublicKey(existing.guard!.forwarderState) },
      }),
      "GuardConfig already exists with different values",
    );
  });

  it("rejects a multisig where someone other than the executor can execute", async () => {
    const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, new PublicKey(first.multisig));
    const executor = new PublicKey(first.executorPda);
    checkSoleExecutor(ms, executor);
    const humanExecutes = { ...ms, members: ms.members.map((m) => (m.key.equals(new PublicKey(first.signers[0])) ? { ...m, permissions: { mask: 7 } } : m)) };
    expect(() => checkSoleExecutor(humanExecutes as any, executor)).to.throw(/can execute/);
    expect(() => checkSoleExecutor({ ...ms, configAuthority: payer().publicKey } as any, executor)).to.throw(/autonomous/);
    const withoutExecutor = { ...ms, members: ms.members.filter((m) => !m.key.equals(executor)) };
    expect(() => checkSoleExecutor(withoutExecutor as any, executor)).to.throw(/not a member/);
  });
});

describe("guardFromEnv", () => {
  const full = {
    GUARD_FORWARDER_PROGRAM: "7kuEAA3mSC1Tz8gQjnvH7bKFda9xSPRRin9SZbH49cNK",
    GUARD_FORWARDER_STATE: "5Tipz3yhTBdVsDbaBxZkrp7Gjf3brGq5SKkxReefPMP7",
    GUARD_POLICY_HASH: "ab".repeat(32),
    GUARD_WORKFLOW_OWNER: "0x" + "cd".repeat(20),
  };

  it("returns null when no CRE value is set", () => {
    expect(guardFromEnv({})).to.equal(null);
  });

  it("parses all values with default lifetimes", () => {
    const g = guardFromEnv(full)!;
    expect(g.forwarderProgram.toBase58()).to.equal(full.GUARD_FORWARDER_PROGRAM);
    expect(Buffer.from(g.policyHash).toString("hex")).to.equal("ab".repeat(32));
    expect(Buffer.from(g.workflowOwner).toString("hex")).to.equal("cd".repeat(20));
    expect(g.maxReviewLifetime).to.equal(3600n);
    expect(g.reviewDeadlineSecs).to.equal(900n);
    expect(guardFromEnv({ ...full, GUARD_MAX_REVIEW_LIFETIME: "600", GUARD_REVIEW_DEADLINE_SECS: "300" })!.reviewDeadlineSecs).to.equal(300n);
  });

  it("refuses partial or malformed values before anything is sent", () => {
    expect(() => guardFromEnv({ GUARD_FORWARDER_PROGRAM: full.GUARD_FORWARDER_PROGRAM })).to.throw(/GUARD_FORWARDER_STATE/);
    expect(() => guardFromEnv({ ...full, GUARD_POLICY_HASH: "ab" })).to.throw(/32 bytes/);
    expect(() => guardFromEnv({ ...full, GUARD_WORKFLOW_OWNER: "cd".repeat(19) })).to.throw(/20 bytes/);
    expect(() => guardFromEnv({ ...full, GUARD_FORWARDER_STATE: "not-a-key" })).to.throw();
  });
});
