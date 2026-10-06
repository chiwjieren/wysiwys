import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Keypair, PublicKey, VersionedTransaction } =
  require("@solana/web3.js") as typeof import("@solana/web3.js");
const sqds = require("@sqds/multisig") as typeof import("@sqds/multisig");

// Ephemeral test keys and SDK-serialized accounts. No network or funded keys.
const signer = Keypair.generate();
const createKey = Keypair.generate().publicKey;
const [multisig, bump] = sqds.getMultisigPda({ createKey });
const executor = Keypair.generate().publicKey;
const guard = Keypair.generate().publicKey;
const [vault, vaultBump] = sqds.getVaultPda({
  multisigPda: multisig,
  index: 0,
});
const [proposalPda, proposalBump] = sqds.getProposalPda({
  multisigPda: multisig,
  transactionIndex: 1n,
});
const [transactionPda, transactionBump] = sqds.getTransactionPda({
  multisigPda: multisig,
  index: 1n,
});
const squad = sqds.accounts.Multisig.fromArgs({
  createKey,
  configAuthority: PublicKey.default,
  threshold: 3,
  timeLock: 0,
  transactionIndex: 1,
  staleTransactionIndex: 0,
  rentCollector: null,
  bump,
  members: [
    { key: signer.publicKey, permissions: { mask: 3 } },
    { key: Keypair.generate().publicKey, permissions: { mask: 3 } },
    { key: Keypair.generate().publicKey, permissions: { mask: 3 } },
    { key: executor, permissions: { mask: 4 } },
  ],
});
const transaction = sqds.accounts.VaultTransaction.fromArgs({
  multisig,
  creator: signer.publicKey,
  index: 1,
  bump: transactionBump,
  vaultIndex: 0,
  vaultBump,
  ephemeralSignerBumps: new Uint8Array(),
  message: {
    numSigners: 1,
    numWritableSigners: 1,
    numWritableNonSigners: 0,
    accountKeys: [vault],
    instructions: [],
    addressTableLookups: [],
  },
});
const accountInfo = (data: Buffer) => ({
  data: [data.toString("base64"), "base64"],
  owner: sqds.PROGRAM_ID.toBase58(),
  lamports: 1000000,
  executable: false,
  rentEpoch: 0,
});

for (const cancelSigning of [false, true]) {
  test(
    cancelSigning
      ? "an account change while signing prevents RPC submission"
      : "SDK account reads and Wallet Standard signing update votes only after finalized submission",
    async ({ page }) => {
      let voted = false;
      let submitted = false;
      await page.exposeFunction("signSquadsFixture", (bytes: number[]) => {
        const tx = VersionedTransaction.deserialize(Uint8Array.from(bytes));
        expect(
          tx.message.staticAccountKeys.some((k) => k.equals(proposalPda)),
        ).toBeTruthy();
        const ix = tx.message.compiledInstructions[0];
        expect(
          tx.message.staticAccountKeys[ix.programIdIndex].equals(
            sqds.PROGRAM_ID,
          ),
        ).toBeTruthy();
        expect(Array.from(ix.data)).toEqual(
          Array.from(
            sqds.instructions.proposalApprove({
              multisigPda: multisig,
              transactionIndex: 1n,
              member: signer.publicKey,
            }).data,
          ),
        );
        tx.sign([signer]);
        return Array.from(tx.serialize());
      });
      await page.addInitScript(
        ({ address, publicKey, cancelSigning }) => {
          let accountsChanged:
            ((change: { accounts: unknown[] }) => void) | undefined;
          const account = {
            address,
            publicKey: Uint8Array.from(publicKey),
            chains: ["solana:devnet"],
            features: ["solana:signTransaction"],
          };
          const wallet = {
            version: "1.0.0",
            name: "Fixture wallet",
            icon: "data:image/svg+xml,<svg/>",
            chains: ["solana:devnet"],
            accounts: [account],
            features: {
              "standard:connect": {
                version: "1.0.0",
                connect: async () => ({ accounts: [account] }),
              },
              "standard:disconnect": {
                version: "1.0.0",
                disconnect: async () => {},
              },
              "standard:events": {
                version: "1.0.0",
                on: (
                  _event: string,
                  listener: (change: { accounts: unknown[] }) => void,
                ) => {
                  accountsChanged = listener;
                  return () => {
                    accountsChanged = undefined;
                  };
                },
              },
              "solana:signTransaction": {
                version: "1.0.0",
                supportedTransactionVersions: [0],
                signTransaction: async ({
                  transaction,
                }: {
                  transaction: Uint8Array;
                }) => {
                  const signed = await (
                    window as unknown as {
                      signSquadsFixture: (bytes: number[]) => Promise<number[]>;
                    }
                  ).signSquadsFixture(Array.from(transaction));
                  if (cancelSigning) accountsChanged?.({ accounts: [] });
                  return [{ signedTransaction: Uint8Array.from(signed) }];
                },
              },
            },
          };
          window.addEventListener("wallet-standard:app-ready", (event) =>
            (event as CustomEvent).detail.register(wallet),
          );
        },
        {
          address: signer.publicKey.toBase58(),
          publicKey: Array.from(signer.publicKey.toBytes()),
          cancelSigning,
        },
      );
      await page.route("**/api/squads/config", (route) =>
        route.fulfill({
          json: {
            config: {
              multisig: multisig.toBase58(),
              guardProgram: guard.toBase58(),
              executor: executor.toBase58(),
              vaultIndex: 0,
              settlementEnabled: false,
            },
          },
        }),
      );
      await page.route("**/api/squads/rpc", async (route) => {
        const request = route.request().postDataJSON();
        let result: unknown;
        const proposal = sqds.accounts.Proposal.fromArgs({
          multisig,
          transactionIndex: 1,
          status: { __kind: "Active", timestamp: 100 },
          bump: proposalBump,
          approved: voted ? [signer.publicKey] : [],
          rejected: [],
          cancelled: [],
        });
        switch (request.method) {
          case "getGenesisHash":
            result = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
            break;
          case "getAccountInfo":
            result = {
              context: { slot: 1 },
              value: accountInfo(squad.serialize()[0]),
            };
            break;
          case "getMultipleAccounts":
            result = {
              context: { slot: 1 },
              value: [
                accountInfo(proposal.serialize()[0]),
                accountInfo(transaction.serialize()[0]),
              ],
            };
            break;
          case "getBalance":
            result = { context: { slot: 1 }, value: 2500000000 };
            break;
          case "getTokenAccountsByOwner":
            result = { context: { slot: 1 }, value: [] };
            break;
          case "getLatestBlockhash":
            result = {
              context: { slot: 1 },
              value: {
                blockhash: createKey.toBase58(),
                lastValidBlockHeight: 500,
              },
            };
            break;
          case "sendTransaction":
            submitted = true;
            voted = true;
            result = "1".repeat(64);
            break;
          case "getSignatureStatuses":
            result = {
              context: { slot: 1 },
              value: [
                {
                  slot: 1,
                  confirmations: null,
                  err: null,
                  confirmationStatus: "finalized",
                },
              ],
            };
            break;
          case "getBlockHeight":
            result = 1;
            break;
          default:
            throw new Error(`Unexpected RPC ${request.method}`);
        }
        await route.fulfill({
          json: { jsonrpc: "2.0", id: request.id, result },
        });
      });
      await page.goto("/");
      await expect(page.getByText("2.5 SOL", { exact: true })).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Propose guarded payout" }),
      ).toBeDisabled();
      await page
        .getByRole("button", { name: "Connect wallet", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Fixture wallet", exact: true })
        .click();
      await page.getByRole("link", { name: "Inspect proposal" }).click();
      await expect(
        page.getByRole("button", { name: "Approve proposal", exact: true }),
      ).toBeEnabled();
      await expect(
        page.getByRole("button", { name: "Execute through guard" }),
      ).toBeDisabled();
      await page
        .getByRole("button", { name: "Approve proposal", exact: true })
        .click();
      if (cancelSigning) {
        await expect(
          page.getByRole("alert").filter({ hasText: "Wallet account changed" }),
        ).toContainText("Wallet account changed");
        expect(submitted).toBeFalsy();
        await expect(
          page.getByText("Approved: 0 / 3", { exact: false }),
        ).toBeVisible();
      } else {
        await expect(
          page.getByText("Approved: 1 / 3", { exact: false }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Approve proposal", exact: true }),
        ).toBeDisabled();
        expect(submitted).toBeTruthy();
      }
    },
  );
}
