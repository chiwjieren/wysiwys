import test from "node:test";
import assert from "node:assert/strict";
import { callRunner, RunnerRequestError } from "../src/lib/squads/guard-groups";

test("guard preparation distinguishes configuration, connection and authentication errors without leaking upstream details", async (t) => {
  const originalUrl = process.env.WYSIWYS_SETTLEMENT_URL;
  const originalToken = process.env.WYSIWYS_SETTLEMENT_TOKEN;
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("{}"),
  );
  const call = () =>
    callRunner("frontend/groups/prepare", { method: "POST", body: "{}" });
  try {
    delete process.env.WYSIWYS_SETTLEMENT_URL;
    delete process.env.WYSIWYS_SETTLEMENT_TOKEN;
    await assert.rejects(call(), {
      message:
        "Treasury protection is not configured. Contact the app operator.",
    });
    process.env.WYSIWYS_SETTLEMENT_URL = "https://runner.example";
    await assert.rejects(call(), {
      message:
        "Treasury protection is not configured. Contact the app operator.",
    });
    assert.equal(fetchMock.mock.callCount(), 0);
    process.env.WYSIWYS_SETTLEMENT_TOKEN = "private-test-token";
    fetchMock.mock.mockImplementation(async () => {
      throw new Error("secret URL with credentials");
    });
    await assert.rejects(call(), {
      message:
        "The treasury protection service is unreachable. Try again shortly.",
    });
    for (const status of [401, 403]) {
      fetchMock.mock.mockImplementation(
        async () => new Response("private upstream text", { status }),
      );
      await assert.rejects(call(), {
        message:
          "Treasury protection authentication failed. Contact the app operator.",
      });
    }
    fetchMock.mock.mockImplementation(
      async () => new Response("private invalid response"),
    );
    await assert.rejects(call(), {
      message:
        "The treasury protection service returned an invalid response. Contact the app operator.",
    });
    fetchMock.mock.mockImplementation(async () =>
      Response.json({ ready: true }),
    );
    assert.deepEqual(await call(), { ready: true });
    assert.equal(
      new RunnerRequestError(503).message,
      "The treasury protection service is unavailable. Try again shortly.",
    );
  } finally {
    if (originalUrl === undefined) delete process.env.WYSIWYS_SETTLEMENT_URL;
    else process.env.WYSIWYS_SETTLEMENT_URL = originalUrl;
    if (originalToken === undefined)
      delete process.env.WYSIWYS_SETTLEMENT_TOKEN;
    else process.env.WYSIWYS_SETTLEMENT_TOKEN = originalToken;
  }
});
