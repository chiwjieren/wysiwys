import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as anchor from "@anchor-lang/core";
import * as multisig from "@sqds/multisig";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, type TransactionInstruction,
} from "@solana/web3.js";
import {
  MINT_SIZE, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createInitializeMint2Instruction,
  createMintToInstruction, getAccount, getAssociatedTokenAddressSync, getMint,
} from "@solana/spl-token";
import {
  Metadata, PROGRAM_ID as TOKEN_METADATA_PROGRAM_ID, createCreateMetadataAccountV3Instruction,
} from "@metaplex-foundation/mpl-token-metadata";
import idlJson from "../../packages/shared/idl/wysiwys_guard.json";

const { Permission, Permissions } = multisig.types;
const SQUADS_PROGRAM_ID = new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
const SIGNER_MIN_LAMPORTS = 0.05 * LAMPORTS_PER_SOL;
const SIGNER_TOPUP_LAMPORTS = 0.1 * LAMPORTS_PER_SOL;

export type TokenSpec = { name: string; symbol: string; uri: string; decimals: number };

/** CRE-provided values for initialize_guard. GuardConfig is immutable, so these are set once. */
export type GuardInit = {
  forwarderProgram: PublicKey;
  forwarderState: PublicKey;
  policyHash: Uint8Array;
  workflowOwner: Uint8Array;
  maxReviewLifetime: bigint;
  reviewDeadlineSecs: bigint;
};

export type BootstrapOptions = {
  connection: Connection;
  payer: Keypair;
  guardProgramId: PublicKey;
  keysDir: string;
  token: TokenSpec;
  /** Target mUSD balance of the vault token account, in base units. */
  vaultBalance: bigint;
  /** How many leading base58 characters the lookalike shares with the whitelisted recipient. */
  lookalikePrefix: number;
  guard?: GuardInit | null;
  /** Named treasury (own multisig create key); default is the original test treasury. */
  treasury?: string;
  /** External human signers (e.g. Phantom wallets); default is keys/signer-1..3.json. */
  signers?: PublicKey[] | null;
  log?: (line: string) => void;
};

export type GuardRecord = {
  forwarderProgram: string;
  forwarderState: string;
  policyHash: string;
  workflowOwner: string;
  maxReviewLifetime: string;
  reviewDeadlineSecs: string;
};

/** Shape of deployments/devnet.json. Every address the other components use. */
export type Deployment = {
  cluster: string;
  programId: string;
  squadsProgram: string;
  tokenMetadataProgram: string;
  multisig: string;
  createKey: string;
  vault: string;
  vaultIndex: number;
  executorPda: string;
  configPda: string;
  guard: GuardRecord | null;
  mint: string;
  mintMetadata: string;
  token: TokenSpec;
  vaultTokenAccount: string;
  signers: string[];
  recipients: { whitelisted: { wallet: string; tokenAccount: string }; lookalike: { wallet: string; tokenAccount: string } };
};

const hex = (b: Uint8Array | number[]) => Buffer.from(b).toString("hex");

// ---------------------------------------------------------------- env

const GUARD_ENV = ["GUARD_FORWARDER_PROGRAM", "GUARD_FORWARDER_STATE", "GUARD_POLICY_HASH", "GUARD_WORKFLOW_OWNER"] as const;

function hexBytes(name: string, value: string, len: number): Uint8Array {
  const clean = value.trim().replace(/^0x/i, "");
  if (!/^[0-9a-f]*$/i.test(clean) || clean.length !== len * 2) throw new Error(`${name} must be ${len} bytes of hex`);
  return Uint8Array.from(Buffer.from(clean, "hex"));
}

/**
 * GuardInit from env, or null when none of the CRE values is set. All four are required together:
 * GuardConfig is immutable, so a half-configured guard is refused before anything is sent.
 */
export function guardFromEnv(env: Record<string, string | undefined>): GuardInit | null {
  const set = GUARD_ENV.filter((k) => env[k]);
  if (set.length === 0) return null;
  const unset = GUARD_ENV.filter((k) => !env[k]);
  if (unset.length) throw new Error(`guard config needs all CRE values; missing ${unset.join(", ")}`);
  return {
    forwarderProgram: new PublicKey(env.GUARD_FORWARDER_PROGRAM!),
    forwarderState: new PublicKey(env.GUARD_FORWARDER_STATE!),
    policyHash: hexBytes("GUARD_POLICY_HASH", env.GUARD_POLICY_HASH!, 32),
    workflowOwner: hexBytes("GUARD_WORKFLOW_OWNER", env.GUARD_WORKFLOW_OWNER!, 20),
    maxReviewLifetime: BigInt(env.GUARD_MAX_REVIEW_LIFETIME || 3600),
    reviewDeadlineSecs: BigInt(env.GUARD_REVIEW_DEADLINE_SECS || 900),
  };
}

/** SIGNERS=a,b,c: exactly three distinct on-curve wallet addresses, or null when unset. */
export function signersFromEnv(value: string | undefined): PublicKey[] | null {
  if (!value || !value.trim()) return null;
  const keys = value.split(",").map((s) => new PublicKey(s.trim()));
  if (keys.length !== 3) throw new Error("SIGNERS must list exactly 3 wallet addresses");
  if (new Set(keys.map((k) => k.toBase58())).size !== 3) throw new Error("SIGNERS must be distinct");
  for (const k of keys) {
    if (!PublicKey.isOnCurve(k.toBytes())) throw new Error(`SIGNERS entry ${k.toBase58()} is not a wallet (off-curve)`);
  }
  return keys;
}

// ---------------------------------------------------------------- keys

function writeKey(path: string, kp: Keypair) {
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  chmodSync(path, 0o600);
}

function loadOrCreateKey(dir: string, name: string, make: () => Keypair = Keypair.generate): Keypair {
  const path = join(dir, name);
  if (existsSync(path)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  const kp = make();
  writeKey(path, kp);
  return kp;
}

/** A wallet whose address starts like `target` (Demo scenario: lookalike destination). */
function grindLookalike(target: PublicKey, prefixLen: number): Keypair {
  const prefix = target.toBase58().slice(0, prefixLen);
  for (;;) {
    const kp = Keypair.generate();
    const addr = kp.publicKey.toBase58();
    if (addr.startsWith(prefix) && !kp.publicKey.equals(target)) return kp;
  }
}

// ---------------------------------------------------------------- sending

async function send(connection: Connection, ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: signers[0].publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  tx.sign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize());
  const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(res.value.err)}`);
  return sig;
}

const exists = async (c: Connection, k: PublicKey) => (await c.getAccountInfo(k, "confirmed")) !== null;

// ---------------------------------------------------------------- checks

/** Same rule as the guard's check_sole_executor: autonomous, executor is the only Execute member. */
export function checkSoleExecutor(ms: multisig.accounts.Multisig, executor: PublicKey): void {
  if (!ms.configAuthority.equals(PublicKey.default)) throw new Error("multisig has a config authority; it must be autonomous");
  let found = false;
  for (const m of ms.members) {
    const canExecute = (m.permissions.mask & Permission.Execute) !== 0;
    if (m.key.equals(executor)) {
      if (m.permissions.mask !== Permission.Execute) throw new Error("executor must have Execute permission only");
      found = true;
    } else if (canExecute) {
      throw new Error(`member ${m.key.toBase58()} can execute; only the guard executor may`);
    }
  }
  if (!found) throw new Error("guard executor is not a member of the multisig");
}

function guardRecord(cfg: any): GuardRecord {
  return {
    forwarderProgram: cfg.forwarderProgram.toBase58(),
    forwarderState: cfg.forwarderState.toBase58(),
    policyHash: hex(cfg.policyHash),
    workflowOwner: hex(cfg.workflowOwner),
    maxReviewLifetime: cfg.maxReviewLifetime.toString(),
    reviewDeadlineSecs: cfg.reviewDeadlineSecs.toString(),
  };
}

function guardInitRecord(g: GuardInit): GuardRecord {
  return {
    forwarderProgram: g.forwarderProgram.toBase58(),
    forwarderState: g.forwarderState.toBase58(),
    policyHash: hex(g.policyHash),
    workflowOwner: hex(g.workflowOwner),
    maxReviewLifetime: g.maxReviewLifetime.toString(),
    reviewDeadlineSecs: g.reviewDeadlineSecs.toString(),
  };
}

// ---------------------------------------------------------------- bootstrap

/**
 * Creates whatever is missing and verifies whatever exists. Safe to re-run: keys are reused from
 * keysDir, nothing is minted twice, and an existing GuardConfig is never changed.
 */
export async function bootstrap(o: BootstrapOptions): Promise<Deployment> {
  const { connection, payer } = o;
  const log = o.log ?? console.log;
  mkdirSync(o.keysDir, { recursive: true, mode: 0o700 });

  // Keys
  const treasury = o.treasury ?? "default";
  if (!/^[a-z0-9-]{1,32}$/.test(treasury)) throw new Error("treasury name must be lowercase letters, digits or dashes");
  const createKey = loadOrCreateKey(o.keysDir, treasury === "default" ? "multisig-create-key.json" : `multisig-create-key-${treasury}.json`);
  const signerKeys: PublicKey[] =
    o.signers ?? [1, 2, 3].map((i) => loadOrCreateKey(o.keysDir, `signer-${i}.json`).publicKey);
  const mintKp = loadOrCreateKey(o.keysDir, "musd-mint.json");
  const recipient = loadOrCreateKey(o.keysDir, "recipient.json");
  const lookalike = loadOrCreateKey(o.keysDir, "lookalike.json", () => grindLookalike(recipient.publicKey, o.lookalikePrefix));

  // Signer fees
  const topups: TransactionInstruction[] = [];
  for (const s of signerKeys) {
    if ((await connection.getBalance(s, "confirmed")) < SIGNER_MIN_LAMPORTS) {
      topups.push(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: s, lamports: SIGNER_TOPUP_LAMPORTS }));
    }
  }
  if (topups.length) {
    await send(connection, topups, [payer]);
    log(`[bootstrap] funded ${topups.length} signer(s) with ${SIGNER_TOPUP_LAMPORTS / LAMPORTS_PER_SOL} SOL`);
  }

  // mUSD mint (legacy SPL Token: the guard only accepts legacy Token accounts)
  const mint = mintKp.publicKey;
  if (!(await exists(connection, mint))) {
    await send(
      connection,
      [
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint,
          space: MINT_SIZE,
          lamports: await connection.getMinimumBalanceForRentExemption(MINT_SIZE),
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(mint, o.token.decimals, payer.publicKey, null),
      ],
      [payer, mintKp],
    );
    log(`[bootstrap] created mint ${mint.toBase58()}`);
  }
  const mintInfo = await getMint(connection, mint, "confirmed");

  // Metaplex metadata: name, symbol, uri
  const [mintMetadata] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID,
  );
  if (!(await exists(connection, mintMetadata))) {
    await send(
      connection,
      [
        createCreateMetadataAccountV3Instruction(
          { metadata: mintMetadata, mint, mintAuthority: payer.publicKey, payer: payer.publicKey, updateAuthority: payer.publicKey },
          {
            createMetadataAccountArgsV3: {
              data: { name: o.token.name, symbol: o.token.symbol, uri: o.token.uri, sellerFeeBasisPoints: 0, creators: null, collection: null, uses: null },
              isMutable: true,
              collectionDetails: null,
            },
          },
        ),
      ],
      [payer],
    );
    log(`[bootstrap] created metadata ${o.token.symbol} (${o.token.name})`);
  }
  const md = await Metadata.fromAccountAddress(connection, mintMetadata, "confirmed");
  const strip = (s: string) => s.replace(/\0/g, "");
  const token: TokenSpec = { name: strip(md.data.name), symbol: strip(md.data.symbol), uri: strip(md.data.uri), decimals: mintInfo.decimals };

  // Squads multisig: 3 of 3 humans (Initiate + Vote), guard executor PDA as the only Execute member
  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const [executorPda] = PublicKey.findProgramAddressSync([Buffer.from("executor"), multisigPda.toBuffer()], o.guardProgramId);
  if (!(await exists(connection, multisigPda))) {
    const [programConfigPda] = multisig.getProgramConfigPda({});
    const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(connection, programConfigPda, "confirmed");
    const ix = multisig.instructions.multisigCreateV2({
      treasury: programConfig.treasury,
      createKey: createKey.publicKey,
      creator: payer.publicKey,
      multisigPda,
      configAuthority: null,
      threshold: 3,
      members: [
        ...signerKeys.map((s) => ({ key: s, permissions: Permissions.fromPermissions([Permission.Initiate, Permission.Vote]) })),
        { key: executorPda, permissions: Permissions.fromPermissions([Permission.Execute]) },
      ],
      timeLock: 0,
      rentCollector: null,
    });
    await send(connection, [ix], [payer, createKey]);
    log(`[bootstrap] created multisig ${multisigPda.toBase58()}`);
  }
  const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda, "confirmed");
  checkSoleExecutor(ms, executorPda);
  const humans = ms.members.filter((m) => !m.key.equals(executorPda)).map((m) => m.key.toBase58()).sort();
  if (JSON.stringify(humans) !== JSON.stringify(signerKeys.map((k) => k.toBase58()).sort())) {
    throw new Error(`treasury "${treasury}" already exists with different signers; use a new --treasury name`);
  }
  if (ms.threshold !== 3) throw new Error(`multisig threshold is ${ms.threshold}, expected 3`);
  const [vault] = multisig.getVaultPda({ multisigPda, index: 0 });

  // Token accounts and vault funding
  const vaultTokenAccount = getAssociatedTokenAddressSync(mint, vault, true);
  const recipientAta = getAssociatedTokenAddressSync(mint, recipient.publicKey);
  const lookalikeAta = getAssociatedTokenAddressSync(mint, lookalike.publicKey);
  const missing: TransactionInstruction[] = [];
  for (const [ata, owner] of [[vaultTokenAccount, vault], [recipientAta, recipient.publicKey], [lookalikeAta, lookalike.publicKey]] as const) {
    if (!(await exists(connection, ata))) missing.push(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, owner, mint));
  }
  if (missing.length) await send(connection, missing, [payer]);
  const balance = (await getAccount(connection, vaultTokenAccount, "confirmed")).amount;
  if (balance < o.vaultBalance) {
    await send(connection, [createMintToInstruction(mint, vaultTokenAccount, payer.publicKey, o.vaultBalance - balance)], [payer]);
    log(`[bootstrap] minted ${o.vaultBalance - balance} base units of ${token.symbol} to the vault`);
  }

  // Guard config (immutable): create once with the CRE values, never change
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config"), multisigPda.toBuffer()], o.guardProgramId);
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
  const program = new anchor.Program({ ...(idlJson as anchor.Idl), address: o.guardProgramId.toBase58() }, provider);
  const fetchConfig = async () => ((await exists(connection, configPda)) ? guardRecord(await (program.account as any).guardConfig.fetch(configPda)) : null);
  let guard = await fetchConfig();
  if (o.guard) {
    const wanted = guardInitRecord(o.guard);
    if (guard) {
      if (JSON.stringify(guard) !== JSON.stringify(wanted)) {
        throw new Error(
          `GuardConfig already exists with different values (it is immutable).\nOn chain: ${JSON.stringify(guard)}\nRequested: ${JSON.stringify(wanted)}`,
        );
      }
    } else {
      await program.methods
        .initializeGuard(
          o.guard.forwarderProgram,
          o.guard.forwarderState,
          Array.from(o.guard.policyHash),
          Array.from(o.guard.workflowOwner),
          new anchor.BN(o.guard.maxReviewLifetime.toString()),
          new anchor.BN(o.guard.reviewDeadlineSecs.toString()),
        )
        .accountsPartial({ multisig: multisigPda, createKey: createKey.publicKey, config: configPda, executor: executorPda, payer: payer.publicKey })
        .signers([createKey])
        .rpc({ commitment: "confirmed" });
      guard = await fetchConfig();
      log(`[bootstrap] initialized guard config ${configPda.toBase58()}`);
    }
  }

  return {
    cluster: "devnet",
    programId: o.guardProgramId.toBase58(),
    squadsProgram: SQUADS_PROGRAM_ID.toBase58(),
    tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID.toBase58(),
    multisig: multisigPda.toBase58(),
    createKey: createKey.publicKey.toBase58(),
    vault: vault.toBase58(),
    vaultIndex: 0,
    executorPda: executorPda.toBase58(),
    configPda: configPda.toBase58(),
    guard,
    mint: mint.toBase58(),
    mintMetadata: mintMetadata.toBase58(),
    token,
    vaultTokenAccount: vaultTokenAccount.toBase58(),
    signers: signerKeys.map((s) => s.toBase58()),
    recipients: {
      whitelisted: { wallet: recipient.publicKey.toBase58(), tokenAccount: recipientAta.toBase58() },
      lookalike: { wallet: lookalike.publicKey.toBase58(), tokenAccount: lookalikeAta.toBase58() },
    },
  };
}
