import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export class AuthenticationError extends Error {}
export function bearerToken(request: Request) {
  const match = /^Bearer (\S+)$/i.exec(request.headers.get("authorization") || "");
  if (!match || match[1].length > 8192) throw new AuthenticationError("Sign in with your wallet to continue.");
  return match[1];
}
export async function verifyPrivyToken(token: string, appId: string, keys: JWTVerifyGetKey) {
  const { payload } = await jwtVerify(token, keys, {
    algorithms: ["ES256"], issuer: "privy.io", audience: appId,
    requiredClaims: ["sub", "iat", "exp"],
  });
  if (!payload.sub?.startsWith("did:privy:")) throw new AuthenticationError("Invalid Privy identity.");
  return payload;
}
let cached: { endpoint: string; keys: JWTVerifyGetKey } | undefined;
export async function authenticate(request: Request) {
  const token = bearerToken(request);
  const appId = process.env.PRIVY_APP_ID;
  if (!appId) throw new AuthenticationError("Wallet authentication is not configured.");
  const endpoint = process.env.PRIVYJWKS_ENDPOINT || `https://auth.privy.io/api/v1/apps/${encodeURIComponent(appId)}/jwks.json`;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.hostname !== "auth.privy.io") throw new Error("Invalid JWKS endpoint");
    if (cached?.endpoint !== endpoint) cached = { endpoint, keys: createRemoteJWKSet(url, { timeoutDuration: 5000 }) };
    return await verifyPrivyToken(token, appId, cached.keys);
  } catch {
    throw new AuthenticationError("Your wallet session is invalid or expired. Sign in again.");
  }
}
