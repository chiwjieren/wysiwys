export type DecodedAction = {
  instructionIndex: number;
  kind: 'token.transferChecked';
  programId: string;
  sourceTokenAccount: string;
  mint: string;
  destinationTokenAccount: string;
  authority: string;
  amount: string;
  decimals: number;
};

export type DecodeResult =
  | { schemaVersion: 1; status: 'success'; actions: DecodedAction[] }
  | { schemaVersion: 1; status: 'unsupported'; error: string; instructionIndex?: number }
  | { schemaVersion: 1; status: 'malformed'; error: string };

type CompiledInstruction = { programIdIndex: number; accountIndexes: number[]; data: Uint8Array };
type Message = { accountKeys: Uint8Array[]; instructions: CompiledInstruction[]; lookups: number };

const DISCRIMINATOR = [0xa8, 0xfa, 0xa2, 0x64, 0x51, 0x0e, 0xa2, 0xcf];
const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAX_ACCOUNT_BYTES = 1_048_576;
const MAX_VECTOR_ITEMS = 4096;

class Reader {
  offset = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) { this.bytes = bytes; }
  take(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length) throw new Error('truncated');
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  u8(): number { return this.take(1)[0]!; }
  u32(): number {
    const b = this.take(4);
    return (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
  }
  u64Decimal(): string {
    const b = this.take(8);
    let value = 0n;
    for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(b[i]!);
    return value.toString(10);
  }
  vec(readItem: () => void): number {
    const count = this.u32();
    if (count > MAX_VECTOR_ITEMS) throw new Error('count_out_of_range');
    for (let i = 0; i < count; i++) readItem();
    return count;
  }
  bytesVec(): Uint8Array { return this.take(this.u32()); }
  key(): Uint8Array { return this.take(32); }
}

function encodeBase58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  let result = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) result += BASE58[digits[i]];
  return result;
}

function readMessage(reader: Reader): Message {
  const numSigners = reader.u8();
  const numWritableSigners = reader.u8();
  const numWritableNonSigners = reader.u8();
  const accountKeys: Uint8Array[] = [];
  reader.vec(() => accountKeys.push(reader.key()));
  if (numSigners > accountKeys.length || numWritableSigners > numSigners || numWritableNonSigners > accountKeys.length - numSigners) throw new Error('invalid_account_counts');
  const instructions: CompiledInstruction[] = [];
  reader.vec(() => {
    const programIdIndex = reader.u8();
    const accountIndexes = [...reader.bytesVec()];
    const data = reader.bytesVec();
    instructions.push({ programIdIndex, accountIndexes, data });
  });
  let lookups = 0;
  reader.vec(() => { reader.key(); reader.bytesVec(); reader.bytesVec(); lookups++; });
  return { accountKeys, instructions, lookups };
}

export function decodeVaultTransaction(data: Uint8Array): DecodeResult {
  if (!(data instanceof Uint8Array) || data.length > MAX_ACCOUNT_BYTES) return { schemaVersion: 1, status: 'malformed', error: 'account_size_out_of_range' };
  try {
    const reader = new Reader(data);
    const discriminator = [...reader.take(8)];
    if (discriminator.some((byte, i) => byte !== DISCRIMINATOR[i])) return { schemaVersion: 1, status: 'malformed', error: 'wrong_discriminator' };
    reader.key(); // multisig
    reader.key(); // creator
    reader.take(8); // index u64
    reader.take(3); // bump, vaultIndex, vaultBump
    reader.bytesVec(); // ephemeralSignerBumps
    const message = readMessage(reader);
    if (reader.offset !== data.length) return { schemaVersion: 1, status: 'malformed', error: 'trailing_data' };
    if (message.lookups > 0) return { schemaVersion: 1, status: 'unsupported', error: 'address_table_lookups' };
    for (const ix of message.instructions) {
      if (ix.programIdIndex >= message.accountKeys.length) return { schemaVersion: 1, status: 'malformed', error: 'program_index_out_of_range' };
      if (ix.accountIndexes.some((index) => index >= message.accountKeys.length)) return { schemaVersion: 1, status: 'malformed', error: 'account_index_out_of_range' };
    }

    const actions: DecodedAction[] = [];
    for (let instructionIndex = 0; instructionIndex < message.instructions.length; instructionIndex++) {
      const ix = message.instructions[instructionIndex]!;
      const programId = encodeBase58(message.accountKeys[ix.programIdIndex]!);
      if (programId !== SPL_TOKEN_PROGRAM || ix.data[0] !== 12) return { schemaVersion: 1, status: 'unsupported', error: programId !== SPL_TOKEN_PROGRAM ? 'unknown_program_or_instruction' : 'unsupported_token_instruction', instructionIndex };
      if (ix.data.length !== 10) return { schemaVersion: 1, status: 'malformed', error: 'invalid_transfer_checked_data' };
      if (ix.accountIndexes.length < 4) return { schemaVersion: 1, status: 'malformed', error: 'missing_required_accounts' };
      const amountBytes = ix.data.subarray(1, 9);
      let amount = 0n;
      for (let i = 7; i >= 0; i--) amount = (amount << 8n) | BigInt(amountBytes[i]!);
      const accounts = ix.accountIndexes.map((index) => encodeBase58(message.accountKeys[index]!));
      actions.push({ instructionIndex, kind: 'token.transferChecked', programId, sourceTokenAccount: accounts[0]!, mint: accounts[1]!, destinationTokenAccount: accounts[2]!, authority: accounts[3]!, amount: amount.toString(10), decimals: ix.data[9]! });
    }
    return { schemaVersion: 1, status: 'success', actions };
  } catch (error) {
    return { schemaVersion: 1, status: 'malformed', error: error instanceof Error ? error.message : 'malformed_account' };
  }
}
