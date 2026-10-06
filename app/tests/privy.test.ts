import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
import { verifyPrivyToken, bearerToken } from "../src/lib/auth/server";

test("Privy tokens require the app audience, issuer, expiry and a valid ES256 signature", async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key" };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const token = (aud = "app-test", iss = "privy.io", exp = "1h") =>
    new SignJWT({ sid: "session-test" }).setProtectedHeader({ alg: "ES256", kid: jwk.kid })
      .setSubject("did:privy:test").setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime(exp).sign(privateKey);
  assert.equal((await verifyPrivyToken(await token(), "app-test", keys)).sub, "did:privy:test");
  await assert.rejects(verifyPrivyToken(await token("another-app"), "app-test", keys));
  await assert.rejects(verifyPrivyToken(await token("app-test", "attacker"), "app-test", keys));
  await assert.rejects(verifyPrivyToken(await token("app-test", "privy.io", "-1s"), "app-test", keys));
  const { publicKey: other } = await generateKeyPair("ES256");
  await assert.rejects(verifyPrivyToken(await token(), "app-test", createLocalJWKSet({ keys: [{ ...(await exportJWK(other)), kid: jwk.kid }] })));
});

test("missing and malformed bearer credentials fail closed", () => {
  for (const value of [null, "", "Basic abc", "Bearer ", "Bearer a b"]) {
    assert.throws(() => bearerToken(new Request("http://localhost", { headers: value ? { authorization: value } : {} })));
  }
  assert.equal(bearerToken(new Request("http://localhost", { headers: { authorization: "Bearer a.b.c" } })), "a.b.c");
});
