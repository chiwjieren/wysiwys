import { decodeVaultTransaction } from '@omnicounter/decoder';

export async function main(): Promise<void> {
  const result = decodeVaultTransaction(new Uint8Array([1]));
  if (result.status === 'success') void result.actions.length;
}
