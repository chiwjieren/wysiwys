import { decodeVaultTransaction, inspectVaultTransaction } from '@wysiwys/decoder';
import type { DecodeResult, VaultInspectionResult } from '@wysiwys/decoder';

export function decodePreview(bytes: Uint8Array): DecodeResult {
  return decodeVaultTransaction(bytes);
}

export function inspectPreview(bytes: Uint8Array): VaultInspectionResult {
  return inspectVaultTransaction(bytes);
}
