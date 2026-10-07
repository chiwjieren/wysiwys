import { test, expect } from "@playwright/test";
import { createPrivateKey, sign } from "node:crypto";
import { createRequire } from "node:module";
import { reviewPda } from "../../src/lib/squads/review";
import { txHash } from "@wysiwys/shared";
const require = createRequire(import.meta.url);
const { BorshAccountsCoder, BN } = require("@anchor-lang/core");
const guardIdl = require("@wysiwys/shared/idl/wysiwys_guard.json");
const {
  Keypair,
  PublicKey,
  VersionedTransaction,
  SystemProgram,
  TransactionMessage,
  ComputeBudgetProgram,
} = require("@solana/web3.js") as typeof import("@solana/web3.js");
const sqds = require("@sqds/multisig") as typeof import("@sqds/multisig");

// Ephemeral test keys and SDK-serialized accounts. No network or funded keys.
const signer = Keypair.generate();
const createKey = Keypair.generate().publicKey;
const [multisig, bump] = sqds.getMultisigPda({ createKey });
const executor = PublicKey.findProgramAddressSync(
  [Buffer.from("fixture")],
  Keypair.generate().publicKey,
)[0];
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
    accountKeys: [vault, signer.publicKey, SystemProgram.programId],
    instructions: [
      {
        programIdIndex: 2,
        accountIndexes: new Uint8Array([0, 1]),
        data: SystemProgram.transfer({
          fromPubkey: vault,
          toPubkey: signer.publicKey,
          lamports: 100000000,
        }).data,
      },
    ],
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

for (const scenario of [
  "vote",
  "disconnect",
  "switch",
  "payment",
  "login-error",
  "create",
  "execute",
  "config-execute",
  "guard-reject",
]) {
  const cancelSigning = scenario === "switch";
  const proposing = scenario === "payment";
  const loginError = scenario === "login-error";
  const creating = scenario === "create";
  const executing = scenario === "execute";
  const configExecuting = scenario === "config-execute";
  // Memo payments without a guard review are the standard (opt-in) flow; guarded proposals
  // need the settlement runner, which these mocks do not provide.
  const guardRejected = scenario === "guard-reject";
  const standard = creating || executing || configExecuting || proposing;
  test(
    guardRejected
      ? "rejected review highlights the exact recipient and blocks execution on desktop and mobile"
      : scenario === "disconnect"
        ? "disconnect invalidates the account and allows reconnection without signing"
        : creating
          ? "create group signs multisigCreateV2 with creator Execute and opens the finalized treasury"
          : executing
            ? "standard creator executes a decoded payment only after the approval threshold"
            : configExecuting
              ? "standard creator applies an approved threshold change with the SDK"
              : loginError
                ? "failed Phantom connection shows an actionable error and can retry without submitting"
                : proposing
                  ? "payment review signs SDK transaction creation and proposal, without execution"
                  : cancelSigning
                    ? "an account change while signing prevents RPC submission"
                    : "Direct wallet connection and SDK signing update votes only after finalized submission",
    async ({ page }) => {
      let voted = false;
      let executed = false;
      let submissions = 0;
      let createdMultisig!: import("@solana/web3.js").PublicKey;
      let createdKey: import("@solana/web3.js").PublicKey;
      const otherMember = squad.members[1].key;
      const programConfig = sqds.accounts.ProgramConfig.fromArgs({
        authority: createKey,
        multisigCreationFee: 1000000,
        treasury: createKey,
        reserved: Array(64).fill(0),
      });
      const configTx = sqds.accounts.ConfigTransaction.fromArgs({
        multisig,
        creator: signer.publicKey,
        index: 1,
        bump: transactionBump,
        actions: [{ __kind: "ChangeThreshold", newThreshold: 2 }],
      });
      const liveSquad = () =>
        creating && createdMultisig
          ? sqds.accounts.Multisig.fromArgs({
              ...squad,
              createKey: createdKey,
              bump: sqds.getMultisigPda({ createKey: createdKey })[1],
              threshold: 2,
              transactionIndex: 0,
              members: [
                { key: signer.publicKey, permissions: { mask: 7 } },
                { key: otherMember, permissions: { mask: 3 } },
              ],
            })
          : standard
            ? sqds.accounts.Multisig.fromArgs({
                ...squad,
                threshold: executing ? 2 : 3,
                members: squad.members
                  .filter((m) => !m.key.equals(executor))
                  .map((m) => ({
                    ...m,
                    permissions: {
                      mask: m.key.equals(signer.publicKey) ? 7 : 3,
                    },
                  })),
              })
            : squad;
      let proposed = false;
      const transaction2 = sqds.getTransactionPda({
        multisigPda: multisig,
        index: 2n,
      })[0];
      const proposal2 = sqds.getProposalPda({
        multisigPda: multisig,
        transactionIndex: 2n,
      })[0];
      let submitted = false;
      let messageSignatures = 0;
      await page.exposeFunction("signFixtureMessage", (bytes: number[]) => {
        ++messageSignatures;
        const key = createPrivateKey({
          key: Buffer.concat([
            Buffer.from("302e020100300506032b657004220420", "hex"),
            Buffer.from(signer.secretKey.slice(0, 32)),
          ]),
          format: "der",
          type: "pkcs8",
        });
        return Array.from(sign(null, Buffer.from(bytes), key));
      });
      await page.exposeFunction(
        "signSquadsFixture",
        async (bytes: number[]) => {
          const tx = VersionedTransaction.deserialize(Uint8Array.from(bytes));
          if (creating) {
            expect(tx.message.compiledInstructions.length).toBe(3);
            const ix = tx.message.compiledInstructions[2];
            expect(
              tx.message.staticAccountKeys[ix.programIdIndex].equals(
                sqds.PROGRAM_ID,
              ),
            ).toBeTruthy();
            const [data] = sqds.generated.multisigCreateV2Struct.deserialize(
              Buffer.from(ix.data),
            );
            expect(data.instructionDiscriminator).toEqual(
              sqds.generated.multisigCreateV2InstructionDiscriminator,
            );
            expect(data.args.threshold).toBe(2);
            expect(data.args.configAuthority).toBe(null);
            expect(data.args.members.map((m) => m.permissions.mask)).toEqual([
              7, 3,
            ]);
            createdKey = tx.message.staticAccountKeys[ix.accountKeyIndexes[3]];
            createdMultisig = sqds.getMultisigPda({ createKey: createdKey })[0];
            expect(
              tx.message.staticAccountKeys[ix.accountKeyIndexes[2]].equals(
                createdMultisig,
              ),
            ).toBeTruthy();
            expect(
              tx.signatures[
                tx.message.staticAccountKeys.findIndex((k) =>
                  k.equals(createdKey),
                )
              ].some((b) => b !== 0),
            ).toBeTruthy();
            tx.sign([signer]);
            return Array.from(tx.serialize());
          }
          const expected = configExecuting
            ? [
                sqds.instructions.configTransactionExecute({
                  multisigPda: multisig,
                  transactionIndex: 1n,
                  member: signer.publicKey,
                  rentPayer: signer.publicKey,
                }),
              ]
            : executing && voted
              ? [
                  (
                    await sqds.instructions.vaultTransactionExecute({
                      connection: {
                        getAccountInfo: async () => ({
                          owner: sqds.PROGRAM_ID,
                          data: transaction.serialize()[0],
                          lamports: 1,
                          executable: false,
                          rentEpoch: 0,
                        }),
                      } as never,
                      multisigPda: multisig,
                      transactionIndex: 1n,
                      member: signer.publicKey,
                    })
                  ).instruction,
                ]
              : proposing
                ? [
                    sqds.instructions.vaultTransactionCreate({
                      multisigPda: multisig,
                      transactionIndex: 2n,
                      creator: signer.publicKey,
                      rentPayer: signer.publicKey,
                      vaultIndex: 0,
                      ephemeralSigners: 0,
                      memo: "Vendor payment",
                      transactionMessage: new TransactionMessage({
                        payerKey: vault,
                        recentBlockhash: createKey.toBase58(),
                        instructions: [
                          SystemProgram.transfer({
                            fromPubkey: vault,
                            toPubkey: signer.publicKey,
                            lamports: 1250000000,
                          }),
                        ],
                      }),
                    }),
                    sqds.instructions.proposalCreate({
                      multisigPda: multisig,
                      transactionIndex: 2n,
                      creator: signer.publicKey,
                      rentPayer: signer.publicKey,
                      isDraft: false,
                    }),
                  ]
                : [
                    sqds.instructions.proposalApprove({
                      multisigPda: multisig,
                      transactionIndex: 1n,
                      member: signer.publicKey,
                    }),
                  ];
          const instructions = [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 }),
            ...expected,
          ];
          expect(tx.message.compiledInstructions.length).toBe(
            instructions.length,
          );
          tx.message.compiledInstructions.forEach((ix, i) => {
            expect(
              tx.message.staticAccountKeys[ix.programIdIndex].equals(
                instructions[i].programId,
              ),
            ).toBeTruthy();
            expect(Array.from(ix.data)).toEqual(
              Array.from(instructions[i].data),
            );
          });
          expect(
            tx.message.staticAccountKeys.some((k) =>
              k.equals(proposing ? proposal2 : proposalPda),
            ),
          ).toBeTruthy();
          tx.sign([signer]);
          return Array.from(tx.serialize());
        },
      );
      await page.addInitScript(
        ({ address, publicKey, cancelSigning, loginError }) => {
          let accountsChanged:
            ((change: { accounts: unknown[] }) => void) | undefined;
          const account = {
            address,
            publicKey: Uint8Array.from(publicKey),
            chains: ["solana:mainnet", "solana:devnet", "solana:testnet"],
            features: ["solana:signTransaction", "solana:signMessage"],
          };
          const wallet = {
            version: "1.0.0",
            name: "Phantom",
            icon: "data:image/svg+xml,<svg/>",
            chains: ["solana:mainnet", "solana:devnet", "solana:testnet"],
            accounts: [] as (typeof account)[],
            features: {
              "standard:connect": {
                version: "1.0.0",
                connect: async () => {
                  if (loginError)
                    throw new Error(
                      "Connection rejected. Unlock Phantom and retry.",
                    );
                  wallet.accounts = [account];
                  accountsChanged?.({ accounts: wallet.accounts });
                  return { accounts: wallet.accounts };
                },
              },
              "standard:disconnect": {
                version: "1.0.0",
                disconnect: async () => {
                  wallet.accounts = [];
                  accountsChanged?.({ accounts: [] });
                },
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
              "solana:signMessage": {
                version: "1.0.0",
                signMessage: async ({ message }: { message: Uint8Array }) => [
                  {
                    signedMessage: message,
                    signature: Uint8Array.from(
                      await (
                        window as unknown as {
                          signFixtureMessage: (
                            bytes: number[],
                          ) => Promise<number[]>;
                        }
                      ).signFixtureMessage(Array.from(message)),
                    ),
                  },
                ],
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
                  if (cancelSigning) {
                    wallet.accounts = [];
                    accountsChanged?.({ accounts: [] });
                  }
                  return [{ signedTransaction: Uint8Array.from(signed) }];
                },
              },
            },
          };
          const register = (api: {
            register: (...wallets: unknown[]) => unknown;
          }) => {
            api.register(wallet);
            (
              window as unknown as { fixtureWalletRegistered: boolean }
            ).fixtureWalletRegistered = true;
          };
          window.addEventListener("wallet-standard:app-ready", (event) =>
            register((event as CustomEvent).detail),
          );
          window.dispatchEvent(
            new CustomEvent("wallet-standard:register-wallet", {
              detail: register,
            }),
          );
        },
        {
          address: signer.publicKey.toBase58(),
          publicKey: Array.from(signer.publicKey.toBytes()),
          cancelSigning,
          loginError,
        },
      );
      await page.route("**/api/squads/config", (route) =>
        route.fulfill({
          json: {
            config: creating
              ? null
              : standard
                ? {
                    multisig: multisig.toBase58(),
                    vaultIndex: 0,
                    settlementEnabled: false,
                    executionMode: "standard",
                  }
                : {
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
          status: {
            __kind: executed
              ? "Executed"
              : configExecuting || (executing && voted)
                ? "Approved"
                : "Active",
            timestamp: 100,
          },
          bump: proposalBump,
          approved: configExecuting
            ? liveSquad().members.map((m) => m.key)
            : executing
              ? voted
                ? [signer.publicKey, otherMember]
                : [otherMember]
              : voted
                ? [signer.publicKey]
                : [],
          rejected: [],
          cancelled: [],
        });
        switch (request.method) {
          case "getGenesisHash":
            result = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
            break;
          case "getAccountInfo":
            result = {
              context: { slot: 1 },
              value: accountInfo(
                request.params[0] === sqds.getProgramConfigPda({})[0].toBase58()
                  ? programConfig.serialize()[0]
                  : request.params[0] === transactionPda.toBase58()
                    ? (configExecuting ? configTx : transaction).serialize()[0]
                    : (proposed
                        ? sqds.accounts.Multisig.fromArgs({
                            ...liveSquad(),
                            transactionIndex: 2,
                          })
                        : configExecuting && executed
                          ? sqds.accounts.Multisig.fromArgs({
                              ...liveSquad(),
                              threshold: 2,
                            })
                          : liveSquad()
                      ).serialize()[0],
              ),
            };
            break;
          case "getMultipleAccounts": {
            const proposalNew = sqds.accounts.Proposal.fromArgs({
              ...proposal,
              transactionIndex: 2,
              bump: sqds.getProposalPda({
                multisigPda: multisig,
                transactionIndex: 2n,
              })[1],
            });
            const txNew = sqds.accounts.VaultTransaction.fromArgs({
              ...transaction,
              index: 2,
              bump: sqds.getTransactionPda({
                multisigPda: multisig,
                index: 2n,
              })[1],
              message: {
                ...transaction.message,
                instructions: [
                  {
                    ...transaction.message.instructions[0],
                    data: SystemProgram.transfer({
                      fromPubkey: vault,
                      toPubkey: signer.publicKey,
                      lamports: 1250000000,
                    }).data,
                  },
                ],
              },
            });
            const accounts: Record<string, ReturnType<typeof accountInfo>> = {
              [proposalPda.toBase58()]: accountInfo(proposal.serialize()[0]),
              [transactionPda.toBase58()]: accountInfo(
                (configExecuting
                  ? configTx
                  : executed
                    ? sqds.accounts.VaultTransaction.fromArgs({
                        multisig: PublicKey.default,
                        creator: PublicKey.default,
                        index: 0,
                        bump: 0,
                        vaultIndex: 0,
                        vaultBump: 0,
                        ephemeralSignerBumps: new Uint8Array(),
                        message: {
                          numSigners: 0,
                          numWritableSigners: 0,
                          numWritableNonSigners: 0,
                          accountKeys: [],
                          instructions: [],
                          addressTableLookups: [],
                        },
                      })
                    : transaction
                ).serialize()[0],
              ),
              ...(proposed
                ? {
                    [proposal2.toBase58()]: accountInfo(
                      proposalNew.serialize()[0],
                    ),
                    [transaction2.toBase58()]: accountInfo(
                      txNew.serialize()[0],
                    ),
                  }
                : {}),
            };
            if (guardRejected) {
              const bytes = await new BorshAccountsCoder(guardIdl).encode(
                "Review",
                {
                  version: 1,
                  multisig,
                  vault_transaction: transactionPda,
                  proposal: proposalPda,
                  tx_index: new BN(1),
                  tx_hash: Array.from(
                    txHash(transactionPda.toBytes(), transaction.serialize()[0]),
                  ),
                  status: { Rejected: {} },
                  reason: 8,
                  policy_hash: Array(32).fill(0),
                  action_kind: 0,
                  destination_hash: Array(32).fill(0),
                  issued_at: new BN(100),
                  expires_at: new BN(200),
                  created_at: new BN(90),
                  bump: 0,
                },
              );
              accounts[reviewPda(guard, multisig, 1n).toBase58()] = {
                ...accountInfo(bytes),
                owner: guard.toBase58(),
              };
            }
            result = {
              context: { slot: 1 },
              value: request.params[0].map(
                (key: string) => accounts[key] ?? null,
              ),
            };
            break;
          }
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
            submissions++;
            if (configExecuting || (executing && voted)) executed = true;
            voted = !proposing;
            proposed = proposing;
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
      // No treasury opens by default: open the mocked one through its invite link.
      await page.goto(creating ? "/" : `/?group=${multisig.toBase58()}`);
      if (!creating) {
        await expect(page.getByText("2.5 SOL", { exact: true })).toBeVisible();
        await expect(
          page.getByRole("button", { name: "New payment", exact: true }),
        ).toBeEnabled();
      }
      await page
        .getByRole("button", { name: "Connect wallet", exact: true })
        .click();
      await page.waitForFunction(
        () =>
          (window as unknown as { fixtureWalletRegistered: boolean })
            .fixtureWalletRegistered,
      );
      await page.getByRole("button", { name: "Phantom", exact: true }).click();
      if (loginError) {
        await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
        await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
          "Connection rejected",
        );
        // Closing an unsuccessful flow must not erase the useful failure or mark the wallet connected.
        await page.getByRole("button", { name: "Close" }).click();
        await expect(
          page.getByRole("button", {
            name: "Connect wallet",
            exact: true,
          }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Retry connection", exact: true })
          .click();
        await expect(
          page.getByRole("button", { name: "Phantom", exact: true }),
        ).toBeVisible();
        expect(submitted).toBeFalsy();
        return;
      }
      await expect(
        page.getByRole("button", { name: "Connect wallet", exact: true }),
      ).toHaveCount(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      // Connection itself must not ask for any off-chain signature.
      expect(messageSignatures).toBe(0);
      if (scenario === "disconnect") {
        await page
          .getByRole("button", {
            name: `${signer.publicKey.toBase58().slice(0, 4)}…${signer.publicKey.toBase58().slice(-4)}`,
            exact: true,
          })
          .click();
        await page
          .getByRole("button", { name: "Disconnect", exact: true })
          .click();
        await expect(
          page.getByRole("button", { name: "Connect wallet", exact: true }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Connect wallet", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Phantom", exact: true })
          .click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        expect(messageSignatures).toBe(0);
        expect(submitted).toBeFalsy();
        return;
      }
      if (creating) {
        await page
          .getByRole("button", { name: "Create treasury", exact: true })
          .click();
        await page.getByLabel("Treasury name").fill("Design team");
        await page.getByLabel("Standard group (no guard)").check();
        await page
          .getByLabel("Member 2 wallet address")
          .fill(otherMember.toBase58());
        await page.getByLabel("Required approvals").fill("2");
        await page
          .getByRole("button", { name: "Create group on devnet", exact: true })
          .click();
        await expect.poll(() => createdMultisig?.toBase58()).toBeTruthy();
        await expect(page).toHaveURL(
          new RegExp(`group=${createdMultisig.toBase58()}`),
        );
        await expect(
          page.getByText("Design team", { exact: true }).first(),
        ).toBeVisible();
        await expect(page.getByText("2 / 2", { exact: true })).toBeVisible();
        expect(submissions).toBe(1);
        await page
          .getByRole("link", { name: "Members", exact: true })
          .first()
          .click();
        await expect(
          page.getByRole("cell", {
            name: "Initiate + Vote + Execute",
            exact: true,
          }),
        ).toBeVisible();
        await page.screenshot({
          path: "test-results/created-group-members.png",
        });
        return;
      }
      if (proposing) {
        await page
          .getByRole("button", { name: "New payment", exact: true })
          .click();
        await page
          .getByLabel("Recipient wallet")
          .fill(signer.publicKey.toBase58());
        await page.getByLabel("Amount", { exact: true }).fill("1.25");
        await page.getByLabel("Memo (optional)").fill("Vendor payment");
        await page
          .getByRole("button", { name: "Review payment", exact: true })
          .click();
        await expect(
          page.getByRole("heading", { name: "Review your payment" }),
        ).toBeVisible();
        await expect(
          page.getByText(/Send 1.25 SOL from the treasury vault/),
        ).toBeVisible();
        // The draft is decoded by @wysiwys/decoder; its JSON is under Technical details.
        await page.getByText("Technical details", { exact: true }).click();
        await expect(page.getByTestId("decoder-json")).toContainText(
          '"kind": "system.transfer"',
        );
        await expect(page.getByTestId("decoder-json")).toContainText(
          '"lamports": "1250000000"',
        );
        await page.screenshot({ path: "test-results/payment-review.png" });
        await page
          .getByRole("button", { name: "Sign and propose payment" })
          .click();
        await expect(page).toHaveURL(/transactions\/2$/, { timeout: 45000 });
        await expect(
          page.getByText(/Send 1.25 SOL from the treasury vault/).first(),
        ).toBeVisible();
        // The stored proposal is decoded from its exact account bytes, with its tx_hash.
        await page.getByText("Technical details", { exact: true }).click();
        await expect(page.getByTestId("decoder-json")).toContainText(
          '"status": "success"',
        );
        await expect(
          page.getByText("Transaction hash (tx_hash)"),
        ).toBeVisible();
        expect(submitted).toBeTruthy();
        expect(voted).toBeFalsy();
        await expect(
          page.getByRole("button", { name: "Execute payment", exact: true }),
        ).toBeDisabled();
        return;
      }

      if (configExecuting)
        await page
          .getByRole("link", { name: "Transactions", exact: true })
          .first()
          .click();
      await page.getByRole("link", { name: "Inspect proposal #1" }).click();
      await expect(page).toHaveURL(/transactions\/1$/, { timeout: 45000 });
      if (guardRejected) {
        await expect(
          page.getByText("Recipient is not approved", { exact: true }),
        ).toBeVisible();
        await expect(
          page.getByText(signer.publicKey.toBase58(), { exact: true }).first(),
        ).toBeVisible();
        await expect(
          page.getByRole("button", {
            name: "Execute through guard",
            exact: true,
          }),
        ).toBeDisabled();
        await expect(
          page.getByRole("button", { name: "Reject proposal", exact: true }),
        ).toHaveAttribute("data-variant", "default");
        await page.screenshot({
          path: "test-results/redesign-rejected-payment-desktop.png",
          fullPage: true,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(390);
        await page.screenshot({
          path: "test-results/redesign-rejected-payment-mobile.png",
          fullPage: true,
        });
        expect(submissions).toBe(0);
        return;
      }
      if (configExecuting) {
        await expect(
          page.getByText("Change required approvals to 2.").first(),
        ).toBeVisible();
        await expect(
          page.getByRole("button", {
            name: "Apply approved changes",
            exact: true,
          }),
        ).toBeEnabled();
        await page
          .getByRole("button", { name: "Apply approved changes", exact: true })
          .click();
        await expect.poll(() => executed).toBe(true);
        await expect(
          page.getByRole("button", {
            name: "Apply approved changes",
            exact: true,
          }),
        ).toBeDisabled();
        await expect(
          page.getByText("Executed", { exact: true }).first(),
        ).toBeVisible();
        expect(submissions).toBe(1);
        return;
      }
      await expect(
        page.getByText(/Send 0.1 SOL from the treasury vault/).first(),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Approve proposal", exact: true }),
      ).toBeEnabled();
      await expect(
        page.getByRole("button", {
          name: executing ? "Execute payment" : "Execute through guard",
          exact: true,
        }),
      ).toBeDisabled();
      await page
        .getByRole("button", { name: "Approve proposal", exact: true })
        .click();
      if (executing) {
        await expect(
          page.getByText("Approved: 2 / 2", { exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", {
            name: "Execute payment",
            exact: true,
          }),
        ).toBeEnabled();
        await page
          .getByRole("button", {
            name: "Execute payment",
            exact: true,
          })
          .click();
        await expect.poll(() => executed).toBe(true);
        await expect(
          page.getByText("Executed", { exact: true }).first(),
        ).toBeVisible();
        await expect(
          page.getByRole("button", {
            name: "Execute payment",
            exact: true,
          }),
        ).toBeDisabled();
        expect(submissions).toBe(2);
        return;
      }
      if (cancelSigning) {
        await expect(
          page.getByRole("alert").filter({ hasText: "Wallet session changed" }),
        ).toContainText("Wallet session changed");
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
