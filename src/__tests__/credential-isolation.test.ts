/**
 * Credential isolation tests
 *
 * Asserts that:
 *  1. getClient(creds) accepts an explicit per-request override and never
 *     reads process.env when one is supplied.
 *  2. Concurrent requests with different credentials never see each other's
 *     creds (no cross-tenant contamination via shared global state).
 *  3. process.env fallback still works for stdio / env mode.
 *  4. process.env is never mutated by getClient() or hasCredentials().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const MockConnectWiseAutomateClient = vi.fn().mockImplementation(function (
  this: unknown,
  config: unknown
) {
  Object.assign(this as object, { config });
});

vi.mock("@wyre-ai/node-connectwise-automate", () => ({
  ConnectWiseAutomateClient: MockConnectWiseAutomateClient,
}));

const ENV_KEYS = [
  "CW_AUTOMATE_SERVER_URL",
  "CW_AUTOMATE_CLIENT_ID",
  "CW_AUTOMATE_USERNAME",
  "CW_AUTOMATE_PASSWORD",
  "CW_AUTOMATE_2FA_CODE",
  "CW_AUTOMATE_AUTH_METHOD",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  MockConnectWiseAutomateClient.mockClear();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const creds = (suffix: string) => ({
  serverUrl: `https://tenant-${suffix}.example.com`,
  clientId: `client-${suffix}`,
  username: `user-${suffix}`,
  password: `pass-${suffix}`,
});

describe("getClient — explicit creds beat process.env", () => {
  it("uses the explicit override and never reads process.env", async () => {
    process.env.CW_AUTOMATE_SERVER_URL = "https://env-should-not-be-used.example.com";
    process.env.CW_AUTOMATE_CLIENT_ID = "env-client-id";
    process.env.CW_AUTOMATE_USERNAME = "env-user";
    process.env.CW_AUTOMATE_PASSWORD = "env-pass";

    const { getClient } = await import("../utils/client.js");
    await getClient(creds("scoped"));

    expect(MockConnectWiseAutomateClient).toHaveBeenCalledTimes(1);
    const config = MockConnectWiseAutomateClient.mock.calls[0][0] as {
      serverUrl: string;
      clientId: string;
    };
    expect(config.serverUrl).toBe("https://tenant-scoped.example.com");
    expect(config.clientId).toBe("client-scoped");
    expect(config.serverUrl).not.toContain("env-should-not-be-used");
  });

  it("falls back to process.env when no override is supplied (stdio mode)", async () => {
    process.env.CW_AUTOMATE_SERVER_URL = "https://automate.example.com";
    process.env.CW_AUTOMATE_CLIENT_ID = "env-client-id";
    process.env.CW_AUTOMATE_USERNAME = "env-user";
    process.env.CW_AUTOMATE_PASSWORD = "env-pass";

    const { getClient } = await import("../utils/client.js");
    await getClient();

    const config = MockConnectWiseAutomateClient.mock.calls[0][0] as {
      serverUrl: string;
    };
    expect(config.serverUrl).toBe("https://automate.example.com");
  });
});

describe("no cross-request credential contamination", () => {
  it("concurrent calls with different creds each receive a distinct client built from their own credentials", async () => {
    const { getClient } = await import("../utils/client.js");

    const [clientA, clientB] = await Promise.all([
      getClient(creds("a")),
      getClient(creds("b")),
    ]);

    // Distinct instances -- no shared mutable singleton across concurrent calls.
    expect(clientA).not.toBe(clientB);

    const configs = MockConnectWiseAutomateClient.mock.calls.map((c) => c[0] as { serverUrl: string; clientId: string });
    expect(configs).toContainEqual(expect.objectContaining({ serverUrl: "https://tenant-a.example.com", clientId: "client-a" }));
    expect(configs).toContainEqual(expect.objectContaining({ serverUrl: "https://tenant-b.example.com", clientId: "client-b" }));
  });

  it("does not contaminate a concurrent request with another tenant's credentials", async () => {
    const { getClient } = await import("../utils/client.js");
    const results: string[] = [];

    await Promise.all([
      (async () => {
        await new Promise((r) => setTimeout(r, 10));
        const client = await getClient(creds("a"));
        results.push((client as unknown as { config: { clientId: string } }).config.clientId);
      })(),
      (async () => {
        await new Promise((r) => setTimeout(r, 5));
        const client = await getClient(creds("b"));
        results.push((client as unknown as { config: { clientId: string } }).config.clientId);
      })(),
    ]);

    expect(results.sort()).toEqual(["client-a", "client-b"]);
  });

  it("process.env is never mutated by getClient with explicit creds", async () => {
    const { getClient } = await import("../utils/client.js");
    await getClient(creds("scoped"));

    expect(process.env.CW_AUTOMATE_SERVER_URL).toBeUndefined();
    expect(process.env.CW_AUTOMATE_CLIENT_ID).toBeUndefined();
  });
});
