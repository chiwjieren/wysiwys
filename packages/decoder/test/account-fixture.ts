const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function decodeBase58(text: string): Uint8Array {
  const digits = [0];
  for (const char of text) {
    let carry = alphabet.indexOf(char);
    if (carry < 0) throw new Error('invalid base58 fixture key');
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! * 58;
      digits[i] = carry & 255;
      carry >>= 8;
    }
    while (carry) { digits.push(carry & 255); carry >>= 8; }
  }
  let zeroes = 0;
  while (zeroes < text.length && text[zeroes] === '1') zeroes++;
  const bytes = new Uint8Array(zeroes + (digits.length === 1 && digits[0] === 0 ? 0 : digits.length));
  for (let i = 0; i < digits.length && (digits.length > 1 || digits[0] !== 0); i++) bytes[bytes.length - 1 - i] = digits[i]!;
  return bytes;
}

function encodeBase58(bytes: Uint8Array): string {
  let zeroes = 0;
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes++;
  const digits: number[] = [];
  for (let i = zeroes; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  let text = '1'.repeat(zeroes);
  for (let i = digits.length - 1; i >= 0; i--) text += alphabet[digits[i]];
  return text;
}

export const fixtureKeys = Array.from({ length: 12 }, (_, index) => encodeBase58(new Uint8Array(32).fill(index + 1)));
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const RECENT_BLOCKHASHES_SYSVAR = 'SysvarRecentB1ockHashes11111111111111111111';
export const RENT_SYSVAR = 'SysvarRent111111111111111111111111111111111';

const u32 = (value: number) => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255];
const byteVec = (bytes: number[]) => [...u32(bytes.length), ...bytes];
const itemVec = (count: number, bytes: number[]) => [...u32(count), ...bytes];

export function encodeU64(value: bigint): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < 8; i++) { bytes.push(Number(value & 255n)); value >>= 8n; }
  return bytes;
}

export function systemData(tag: number, payload: number[] = []): number[] { return [...u32(tag), ...payload]; }

export function makeVaultTransaction(programId: string, accounts: string[], instructionData: number[]): Uint8Array {
  return makeVaultTransactionMany([{ programId, accounts, instructionData }]);
}

export function makeVaultTransactionMany(instructions: { programId: string; accounts: string[]; instructionData: number[] }[]): Uint8Array {
  const keys: Uint8Array[] = [];
  const compiled = instructions.map(({ programId, accounts, instructionData }) => {
    const startIndex = keys.length;
    keys.push(...accounts.map(decodeBase58));
    const programIdIndex = keys.length;
    keys.push(decodeBase58(programId));
    return [programIdIndex, ...byteVec(accounts.map((_, i) => startIndex + i)), ...byteVec(instructionData)];
  });
  const accountKeyBytes = keys.flatMap((key) => [...key]);
  return Uint8Array.from([
    168, 250, 162, 100, 81, 14, 162, 207,
    ...decodeBase58(fixtureKeys[0]!), ...decodeBase58(fixtureKeys[1]!),
    ...Array(8).fill(0), 254, 0, 253,
    ...byteVec([]),
    1, 1, 0,
    ...itemVec(keys.length, accountKeyBytes),
    ...itemVec(compiled.length, compiled.flat()),
    ...itemVec(0, []),
  ]);
}
