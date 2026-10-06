export type DecodedAction =
  | { instructionIndex: number; kind: 'system.assign'; account: string; newOwnerProgram: string }
  | { instructionIndex: number; kind: 'system.transfer'; source: string; destination: string; lamports: string }
  | { instructionIndex: number; kind: 'system.advanceNonce'; nonceAccount: string; recentBlockhashesSysvar: string; authority: string }
  | { instructionIndex: number; kind: 'system.withdrawNonce'; nonceAccount: string; destination: string; recentBlockhashesSysvar: string; rentSysvar: string; authority: string; lamports: string }
  | { instructionIndex: number; kind: 'system.initializeNonce'; nonceAccount: string; recentBlockhashesSysvar: string; rentSysvar: string; authority: string }
  | { instructionIndex: number; kind: 'system.authorizeNonce'; nonceAccount: string; currentAuthority: string; newAuthority: string }
  | { instructionIndex: number; kind: 'token.transfer'; sourceTokenAccount: string; destinationTokenAccount: string; authority: string; amount: string; multisigSigners?: string[] }
  | { instructionIndex: number; kind: 'token.approve'; sourceTokenAccount: string; delegate: string; authority: string; amount: string; multisigSigners?: string[] }
  | { instructionIndex: number; kind: 'token.approveChecked'; sourceTokenAccount: string; mint: string; delegate: string; authority: string; amount: string; decimals: number; multisigSigners?: string[] }
  | { instructionIndex: number; kind: 'token.revoke'; sourceTokenAccount: string; authority: string; multisigSigners?: string[] }
  | { instructionIndex: number; kind: 'token.setAuthority'; target: string; authorityType: 'mintTokens' | 'freezeAccount' | 'accountOwner' | 'closeAccount'; currentAuthority: string; newAuthority: string | null; multisigSigners?: string[] }
  | { instructionIndex: number; kind: 'token.closeAccount'; tokenAccount: string; destination: string; authority: string; multisigSigners?: string[] }
  | { instructionIndex: number; kind: 'token.transferChecked'; programId: string; sourceTokenAccount: string; mint: string; destinationTokenAccount: string; authority: string; amount: string; decimals: number; multisigSigners?: string[] }
  | { instructionIndex: number; kind: 'ata.create' | 'ata.createIdempotent'; payer: string; associatedTokenAccount: string; walletOwner: string; mint: string };

export type DecodeResult =
  | { schemaVersion: 1; status: 'success'; actions: DecodedAction[] }
  | { schemaVersion: 1; status: 'unsupported'; error: string; unsupportedInstructions: UnsupportedInstruction[] }
  | { schemaVersion: 1; status: 'malformed'; error: string; instructionIndex?: number; unsupportedInstructions?: UnsupportedInstruction[] };

export type UnsupportedInstruction = {
  instructionIndex: number;
  category: 'unknown_program' | 'unknown_instruction';
  programId: string;
  accountKeys: string[];
  dataHex: string;
};

type CompiledInstruction = { programIdIndex: number; accountIndexes: number[]; data: Uint8Array };
type Message = { accountKeys: Uint8Array[]; instructions: CompiledInstruction[]; lookups: number };

const DISCRIMINATOR = [0xa8, 0xfa, 0xa2, 0x64, 0x51, 0x0e, 0xa2, 0xcf];
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const RECENT_BLOCKHASHES_SYSVAR = 'SysvarRecentB1ockHashes11111111111111111111';
const RENT_SYSVAR = 'SysvarRent111111111111111111111111111111111';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const AUTHORITY_TYPES = ['mintTokens', 'freezeAccount', 'accountOwner', 'closeAccount'] as const;
const MAX_ACCOUNT_BYTES = 1_048_576;
const MAX_VECTOR_ITEMS = 4096;

function instructionHex(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += byte.toString(16).padStart(2, '0');
  return value;
}

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
  bytesVec(): Uint8Array {
    const length = this.u32();
    if (length > MAX_ACCOUNT_BYTES) throw new Error('length_out_of_range');
    return this.take(length);
  }
  vec(readItem: () => void): number {
    const count = this.u32();
    if (count > MAX_VECTOR_ITEMS) throw new Error('count_out_of_range');
    for (let i = 0; i < count; i++) readItem();
    return count;
  }
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

function readAmount(bytes: Uint8Array, offset: number): string {
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(bytes[offset + i]!);
  return value.toString(10);
}

function decodeOne(ix: CompiledInstruction, index: number, keys: Uint8Array[]): DecodedAction | 'unsupported' {
  const programId = encodeBase58(keys[ix.programIdIndex]!);
  const a = ix.accountIndexes.map((accountIndex) => encodeBase58(keys[accountIndex]!));
  const d = ix.data;
  const account = (required: number) => { if (a.length < required) throw new Error('missing_required_accounts'); };
  const dataLength = (required: number) => { if (d.length !== required) throw new Error('invalid_instruction_data_length'); };
  const signerKeys = (required: number) => a.length > required ? { multisigSigners: a.slice(required) } : {};
  if (programId === SYSTEM_PROGRAM) {
    if (d.length < 4) throw new Error('invalid_system_instruction_data');
    const tag = new Reader(d).u32();
    if (tag === 1) {
      dataLength(36); account(1);
      return { instructionIndex: index, kind: 'system.assign', account: a[0]!, newOwnerProgram: encodeBase58(d.subarray(4, 36)) };
    }
    if (tag === 2) {
      dataLength(12); account(2);
      return { instructionIndex: index, kind: 'system.transfer', source: a[0]!, destination: a[1]!, lamports: readAmount(d, 4) };
    }
    if (tag === 4) {
      dataLength(4); account(3);
      if (a[1] !== RECENT_BLOCKHASHES_SYSVAR) throw new Error('invalid_recent_blockhashes_sysvar');
      return { instructionIndex: index, kind: 'system.advanceNonce', nonceAccount: a[0]!, recentBlockhashesSysvar: a[1]!, authority: a[2]! };
    }
    if (tag === 5) {
      dataLength(12); account(5);
      if (a[2] !== RECENT_BLOCKHASHES_SYSVAR || a[3] !== RENT_SYSVAR) throw new Error('invalid_nonce_sysvar');
      return { instructionIndex: index, kind: 'system.withdrawNonce', nonceAccount: a[0]!, destination: a[1]!, recentBlockhashesSysvar: a[2]!, rentSysvar: a[3]!, authority: a[4]!, lamports: readAmount(d, 4) };
    }
    if (tag === 6) {
      dataLength(36); account(3);
      if (a[1] !== RECENT_BLOCKHASHES_SYSVAR || a[2] !== RENT_SYSVAR) throw new Error('invalid_nonce_sysvar');
      return { instructionIndex: index, kind: 'system.initializeNonce', nonceAccount: a[0]!, recentBlockhashesSysvar: a[1]!, rentSysvar: a[2]!, authority: encodeBase58(d.subarray(4, 36)) };
    }
    if (tag === 7) {
      dataLength(36); account(2);
      return { instructionIndex: index, kind: 'system.authorizeNonce', nonceAccount: a[0]!, currentAuthority: a[1]!, newAuthority: encodeBase58(d.subarray(4, 36)) };
    }
    return 'unsupported';
  }
  if (programId === SPL_TOKEN_PROGRAM) {
    if (d.length === 0) throw new Error('missing_token_instruction_tag');
    const tag = d[0]!;
    if (tag === 3 || tag === 4) {
      dataLength(9); account(3);
      return tag === 3
        ? { instructionIndex: index, kind: 'token.transfer', sourceTokenAccount: a[0]!, destinationTokenAccount: a[1]!, authority: a[2]!, amount: readAmount(d, 1), ...signerKeys(3) }
        : { instructionIndex: index, kind: 'token.approve', sourceTokenAccount: a[0]!, delegate: a[1]!, authority: a[2]!, amount: readAmount(d, 1), ...signerKeys(3) };
    }
    if (tag === 5) {
      dataLength(1); account(2);
      return { instructionIndex: index, kind: 'token.revoke', sourceTokenAccount: a[0]!, authority: a[1]!, ...signerKeys(2) };
    }
    if (tag === 9) {
      dataLength(1); account(3);
      return { instructionIndex: index, kind: 'token.closeAccount', tokenAccount: a[0]!, destination: a[1]!, authority: a[2]!, ...signerKeys(3) };
    }
    if (tag === 6) {
      if (d.length !== 3 && d.length !== 35) throw new Error('invalid_set_authority_data');
      account(2);
      const type = d[1]!;
      const option = d[2]!;
      if (type > 3 || option > 1 || (option === 0 && d.length !== 3) || (option === 1 && d.length !== 35)) throw new Error('invalid_set_authority_data');
      return { instructionIndex: index, kind: 'token.setAuthority', target: a[0]!, authorityType: AUTHORITY_TYPES[type]!, currentAuthority: a[1]!, newAuthority: option === 0 ? null : encodeBase58(d.subarray(3, 35)), ...signerKeys(2) };
    }
    if (tag === 12) {
      dataLength(10); account(4);
      return { instructionIndex: index, kind: 'token.transferChecked', programId, sourceTokenAccount: a[0]!, mint: a[1]!, destinationTokenAccount: a[2]!, authority: a[3]!, amount: readAmount(d, 1), decimals: d[9]!, ...signerKeys(4) };
    }
    if (tag === 13) {
      dataLength(10); account(4);
      return { instructionIndex: index, kind: 'token.approveChecked', sourceTokenAccount: a[0]!, mint: a[1]!, delegate: a[2]!, authority: a[3]!, amount: readAmount(d, 1), decimals: d[9]!, ...signerKeys(4) };
    }
    return 'unsupported';
  }
  if (programId === ASSOCIATED_TOKEN_PROGRAM) {
    if (d.length === 0) throw new Error('missing_ata_instruction_tag');
    if (d[0] !== 0 && d[0] !== 1) return 'unsupported';
    dataLength(1);
    account(6);
    if (a.length !== 6) throw new Error('invalid_ata_account_count');
    if (a[4] !== SYSTEM_PROGRAM || a[5] !== SPL_TOKEN_PROGRAM) throw new Error('invalid_ata_program_accounts');
    return { instructionIndex: index, kind: d[0] === 0 ? 'ata.create' : 'ata.createIdempotent', payer: a[0]!, associatedTokenAccount: a[1]!, walletOwner: a[2]!, mint: a[3]! };
  }
  return 'unsupported';
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
    if (message.lookups > 0) return { schemaVersion: 1, status: 'unsupported', error: 'address_table_lookups', unsupportedInstructions: [] };
    if (message.instructions.length === 0) return { schemaVersion: 1, status: 'malformed', error: 'empty_instructions' };
    for (const ix of message.instructions) {
      if (ix.programIdIndex >= message.accountKeys.length) return { schemaVersion: 1, status: 'malformed', error: 'program_index_out_of_range' };
      if (ix.accountIndexes.some((index) => index >= message.accountKeys.length)) return { schemaVersion: 1, status: 'malformed', error: 'account_index_out_of_range' };
    }
    const actions: DecodedAction[] = [];
    let firstMalformed: { error: string; instructionIndex: number } | undefined;
    const unsupportedInstructions: UnsupportedInstruction[] = [];
    for (let instructionIndex = 0; instructionIndex < message.instructions.length; instructionIndex++) {
      try {
        const ix = message.instructions[instructionIndex]!;
        const action = decodeOne(ix, instructionIndex, message.accountKeys);
        if (action === 'unsupported') {
          const programId = encodeBase58(message.accountKeys[ix.programIdIndex]!);
          unsupportedInstructions.push({
            instructionIndex,
            category: programId === SYSTEM_PROGRAM || programId === SPL_TOKEN_PROGRAM || programId === ASSOCIATED_TOKEN_PROGRAM ? 'unknown_instruction' : 'unknown_program',
            programId,
            accountKeys: ix.accountIndexes.map((accountIndex) => encodeBase58(message.accountKeys[accountIndex]!)),
            dataHex: instructionHex(ix.data),
          });
        } else actions.push(action);
      } catch (error) {
        firstMalformed ??= { error: error instanceof Error ? error.message : 'malformed_instruction', instructionIndex };
      }
    }
    if (firstMalformed) return { schemaVersion: 1, status: 'malformed', ...firstMalformed, ...(unsupportedInstructions.length > 0 ? { unsupportedInstructions } : {}) };
    if (unsupportedInstructions.length > 0) return { schemaVersion: 1, status: 'unsupported', error: 'unsupported_instruction', unsupportedInstructions };
    return { schemaVersion: 1, status: 'success', actions };
  } catch (error) {
    return { schemaVersion: 1, status: 'malformed', error: error instanceof Error ? error.message : 'malformed_account' };
  }
}
