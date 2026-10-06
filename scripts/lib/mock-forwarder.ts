import { createHash, randomBytes } from "node:crypto";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

// Delivers a guard report through Chainlink's CRE simulator mock forwarder, byte for byte what
// `cre workflow simulate --broadcast` sends (chainlink-solana contracts/programs/mock-forwarder).
// The mock forwarder verifies no signatures: this is a test and stand-in path, never trust-bearing.

/** sha256("global:report")[..8] */
const REPORT_DISCRIMINATOR = Buffer.from([96, 121, 245, 84, 178, 45, 48, 91]);
const REPORT_CONTEXT_LEN = 96;

const u32le = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

/**
 * 109-byte forwarder metadata: version 1 | execution id 32 | timestamp 4 | don id 4 | config version 4 |
 * workflow_cid 32 | workflow_name 10 | workflow_owner 20 | report_id 2. The receiver gets bytes 45..109.
 */
function metadata(workflowOwner: Uint8Array): Buffer {
  if (workflowOwner.length !== 20) throw new Error("workflow owner must be 20 bytes");
  return Buffer.concat([
    Buffer.from([1]),
    randomBytes(32), // execution id: unique per delivery
    Buffer.alloc(12),
    Buffer.alloc(32, 0x11), // workflow_cid
    Buffer.from("wysiwys-e2", "utf8"), // workflow_name, 10 bytes
    Buffer.from(workflowOwner),
    Buffer.from([0, 1]),
  ]);
}

export function mockForwarderReportInstruction(o: {
  forwarderProgram: PublicKey;
  forwarderState: PublicKey;
  transmitter: PublicKey;
  receiverProgram: PublicKey;
  /** Receiver accounts after [state, authority]: for the guard, [config (ro), review (w)]. */
  receiverAccounts: { pubkey: PublicKey; isWritable: boolean }[];
  payload: Uint8Array;
  workflowOwner: Uint8Array;
}): TransactionInstruction {
  const [authority] = PublicKey.findProgramAddressSync(
    [Buffer.from("forwarder"), o.forwarderState.toBuffer(), o.receiverProgram.toBuffer()],
    o.forwarderProgram,
  );
  const accountHash = createHash("sha256")
    .update(Buffer.concat([o.forwarderState, authority, ...o.receiverAccounts.map((a) => a.pubkey)].map((k) => k.toBuffer())))
    .digest();
  const rawReport = Buffer.concat([metadata(o.workflowOwner), accountHash, u32le(o.payload.length), Buffer.from(o.payload)]);
  const data = Buffer.concat([Buffer.from([0]), rawReport, Buffer.alloc(REPORT_CONTEXT_LEN)]); // no signatures
  return new TransactionInstruction({
    programId: o.forwarderProgram,
    keys: [
      { pubkey: o.forwarderState, isSigner: false, isWritable: false },
      { pubkey: o.transmitter, isSigner: true, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: false },
      { pubkey: o.receiverProgram, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...o.receiverAccounts.map((a) => ({ pubkey: a.pubkey, isSigner: false, isWritable: a.isWritable })),
    ],
    data: Buffer.concat([REPORT_DISCRIMINATOR, u32le(data.length), data]),
  });
}
