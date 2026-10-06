import { decodeVaultTransaction, inspectVaultTransaction } from '@wysiwys/decoder';

export async function main(): Promise<void> {
  const result = decodeVaultTransaction(new Uint8Array([1]));
  if (result.status === 'success') void result.actions.length;
  const inspection = inspectVaultTransaction(new Uint8Array([1]));
  if (inspection.status === 'inspected') void inspection.instructions.length;
}
