// Wallet session rules, kept free of React so they can be tested against a fake Phantom.

// Phantom is the only supported wallet for now.
export const SUPPORTED_WALLET = "Phantom";
export function isPhantom(wallet: { name: string }) {
  return wallet.name === SUPPORTED_WALLET;
}

type Connectable<W> = {
  features: {
    "standard:connect": {
      connect: (input?: { silent?: boolean }) => Promise<unknown>;
    };
  };
} & W;

// After a reload Phantom exposes no accounts until the site connects. A silent connect returns
// accounts the user already authorized for this site and never opens a prompt; anything else
// (not authorized, locked, rejected) means stay disconnected.
export async function restoreSession<W>(
  wallet: Connectable<W>,
  accounts: (wallet: Connectable<W>) => string[],
): Promise<string | undefined> {
  try {
    await wallet.features["standard:connect"].connect({ silent: true });
  } catch {
    return undefined;
  }
  return accounts(wallet)[0];
}

// Phantom emits "change" for more than account switches. Only a different address is a new
// session (which cancels in-flight actions); no accounts means the site lost access.
export function accountChange(
  accounts: string[],
  current: string | undefined,
): { kind: "same" } | { kind: "switched"; address: string } | { kind: "lost" } {
  if (!accounts.length) return { kind: "lost" };
  if (current && accounts.includes(current)) return { kind: "same" };
  return { kind: "switched", address: accounts[0] };
}
