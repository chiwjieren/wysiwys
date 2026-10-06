import { decodeVaultTransaction } from '@omnicounter/decoder';
import type { DecodeResult } from '@omnicounter/decoder';

export function decodePreview(bytes: Uint8Array): DecodeResult {
  return decodeVaultTransaction(bytes);
}
