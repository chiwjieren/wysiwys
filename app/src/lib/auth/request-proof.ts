type RequestProof = {
  origin: string;
  path: string;
  address: string;
  issuedAt: number;
  nonce: string;
  body: string;
};
// Only legacy Guard preparation needs an off-chain proof. Connecting a wallet does not sign a message.
export async function requestMessage(input: RequestProof) {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.body)),
  );
  const digest = Array.from(hash, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return new TextEncoder().encode(
    [
      "wysiwys request",
      `Origin: ${input.origin}`,
      `Path: ${input.path}`,
      `Wallet: ${input.address}`,
      `Issued At: ${input.issuedAt}`,
      `Nonce: ${input.nonce}`,
      `Body SHA-256: ${digest}`,
    ].join("\n"),
  );
}
