import { createPublicKey, verify } from "node:crypto";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { requestMessage } from "./request-proof";
import { assertSameOrigin } from "../squads/server-config";

export class AuthenticationError extends Error {}
function verifySignature(
  address: PublicKey,
  message: Uint8Array,
  signature: Uint8Array,
) {
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      address.toBuffer(),
    ]),
    format: "der",
    type: "spki",
  });
  return signature.length === 64 && verify(null, message, key, signature);
}
// A transaction's signatures prove control of its required signers; no hosted login token is needed.
export function verifySignedSubmission(encoded: unknown) {
  try {
    if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
      throw new Error();
    const tx = VersionedTransaction.deserialize(Buffer.from(encoded, "base64"));
    const message = tx.message.serialize();
    const required = tx.message.header.numRequiredSignatures;
    if (!required || tx.signatures.length !== required) throw new Error();
    for (let i = 0; i < required; i++) {
      if (
        !verifySignature(
          tx.message.staticAccountKeys[i],
          message,
          tx.signatures[i],
        )
      )
        throw new Error();
    }
    return tx.message.staticAccountKeys[0].toBase58();
  } catch {
    throw new AuthenticationError(
      "A valid signed transaction is required. Connect your wallet and approve the action.",
    );
  }
}
const usedProofs = new Map<string, number>();
const lifetime = 60000;
export async function authenticate(request: Request) {
  const address = request.headers.get("x-wallet-address") || "";
  const nonce = request.headers.get("x-wallet-nonce") || "";
  const signature = request.headers.get("x-wallet-signature") || "";
  const issuedAt = Number(request.headers.get("x-wallet-issued-at"));
  const now = Date.now();
  if (
    !address ||
    !/^[a-f0-9-]{36}$/i.test(nonce) ||
    !/^[A-Za-z0-9+/]{86}==$/.test(signature)
  )
    throw new AuthenticationError(
      "Connect your wallet and approve this request.",
    );
  if (
    !Number.isSafeInteger(issuedAt) ||
    now - issuedAt > lifetime ||
    issuedAt > now + 5000
  )
    throw new AuthenticationError("Wallet request expired. Please retry.");
  for (const [key, expiry] of usedProofs)
    if (expiry < now) usedProofs.delete(key);
  const key = `${address}:${nonce}`;
  if (usedProofs.has(key))
    throw new AuthenticationError("Wallet request already used. Please retry.");
  try {
    const body = await request.clone().text();
    if (body.length > 2048) throw new Error();
    const url = new URL(request.url);
    const origin = request.headers.get("origin") || "";
    assertSameOrigin(request);
    const message = await requestMessage({
      origin,
      path: url.pathname,
      address,
      nonce,
      issuedAt,
      body,
    });
    if (
      !verifySignature(
        new PublicKey(address),
        message,
        Buffer.from(signature, "base64"),
      )
    )
      throw new Error();
    // Checked again after asynchronous hashing so concurrent identical requests cannot both succeed.
    if (usedProofs.has(key))
      throw new AuthenticationError(
        "Wallet request already used. Please retry.",
      );
    usedProofs.set(key, issuedAt + lifetime);
    return address;
  } catch (error) {
    if (error instanceof AuthenticationError) throw error;
    throw new AuthenticationError(
      "Wallet request signature is invalid. Please retry.",
    );
  }
}
