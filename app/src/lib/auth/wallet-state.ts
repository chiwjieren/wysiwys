// Wallet Standard updates synchronously; React account state may update after signing returns.
export function assertWalletConnected(
  wallet: { accounts: readonly { address: string }[] },
  address: string,
) {
  if (!wallet.accounts.some((account) => account.address === address))
    throw new Error("Wallet session changed. Reconnect and retry.");
}
