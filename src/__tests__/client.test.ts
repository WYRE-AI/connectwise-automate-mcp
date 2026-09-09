/**
 * Tests for lazy-loaded ConnectWise Automate client
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ConnectWiseAutomateConfig } from "@wyre-ai/node-connectwise-automate";
import { getCredentials, getClient, clearClient } from "../utils/client.js";

// Mock the node-connectwise-automate library. The constructor stores the
// resolved config so tests can assert the auth shape that was passed in.
vi.mock("@wyre-ai/node-connectwise-automate", () => ({
  ConnectWiseAutomateClient: vi.fn().mockImplementation(function (config) { return ({
    config,
    computers: {
      list: vi.fn(),
      get: vi.fn(),
      restart: vi.fn(),
    },
    clients: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    alerts: {
      list: vi.fn(),
      get: vi.fn(),
      listForComputer: vi.fn(),
    },
    scripts: {
      list: vi.fn(),
      get: vi.fn(),
      getDetail: vi.fn(),
      execute: vi.fn(),
    },
    locations: {
      list: vi.fn(),
    },
  }) }),
}));

/**
 * Read the config the mocked client was constructed with.
 */
function configOf(client: unknown): ConnectWiseAutomateConfig {
  return (client as { config: ConnectWiseAutomateConfig }).config;
}

describe("ConnectWise Automate Client Utilities", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment variables before each test
    process.env = { ...originalEnv };
    delete process.env.CW_AUTOMATE_AUTH_METHOD;
    delete process.env.CW_AUTOMATE_2FA_CODE;
    clearClient();
  });

  afterEach(() => {
    process.env = originalEnv;
    clearClient();
  });

  describe("getCredentials", () => {
    it("should return null when no credentials are set", () => {
      delete process.env.CW_AUTOMATE_SERVER_URL;
      delete process.env.CW_AUTOMATE_CLIENT_ID;
      delete process.env.CW_AUTOMATE_USERNAME;
      delete process.env.CW_AUTOMATE_PASSWORD;

      const creds = getCredentials();
      expect(creds).toBeNull();
    });

    it("should return null when server URL is missing", () => {
      delete process.env.CW_AUTOMATE_SERVER_URL;
      process.env.CW_AUTOMATE_CLIENT_ID = "test-client-id";
      process.env.CW_AUTOMATE_USERNAME = "test-username";
      process.env.CW_AUTOMATE_PASSWORD = "test-password";

      const creds = getCredentials();
      expect(creds).toBeNull();
    });

    it("should return null when client ID is missing", () => {
      process.env.CW_AUTOMATE_SERVER_URL = "https://automate.example.com";
      delete process.env.CW_AUTOMATE_CLIENT_ID;
      process.env.CW_AUTOMATE_USERNAME = "test-username";
      process.env.CW_AUTOMATE_PASSWORD = "test-password";

      const creds = getCredentials();
      expect(creds).toBeNull();
    });

    it("should return null when username is missing", () => {
      process.env.CW_AUTOMATE_SERVER_URL = "https://automate.example.com";
      process.env.CW_AUTOMATE_CLIENT_ID = "test-client-id";
      delete process.env.CW_AUTOMATE_USERNAME;
      process.env.CW_AUTOMATE_PASSWORD = "test-password";

      const creds = getCredentials();
      expect(creds).toBeNull();
    });

    it("should return null when password is missing", () => {
      process.env.CW_AUTOMATE_SERVER_URL = "https://automate.example.com";
      process.env.CW_AUTOMATE_CLIENT_ID = "test-client-id";
      process.env.CW_AUTOMATE_USERNAME = "test-username";
      delete process.env.CW_AUTOMATE_PASSWORD;

      const creds = getCredentials();
      expect(creds).toBeNull();
    });

    it("should return credentials when all required fields are provided", () => {
      process.env.CW_AUTOMATE_SERVER_URL = "https://automate.example.com";
      process.env.CW_AUTOMATE_CLIENT_ID = "test-client-id";
      process.env.CW_AUTOMATE_USERNAME = "test-username";
      process.env.CW_AUTOMATE_PASSWORD = "test-password";

      const creds = getCredentials();
      expect(creds).toEqual({
        serverUrl: "https://automate.example.com",
        clientId: "test-client-id",
        username: "test-username",
        password: "test-password",
        twoFactorCode: undefined,
        authMethod: undefined,
      });
    });

    it("should include 2FA code when provided", () => {
      process.env.CW_AUTOMATE_SERVER_URL = "https://automate.example.com";
      process.env.CW_AUTOMATE_CLIENT_ID = "test-client-id";
      process.env.CW_AUTOMATE_USERNAME = "test-username";
      process.env.CW_AUTOMATE_PASSWORD = "test-password";
      process.env.CW_AUTOMATE_2FA_CODE = "123456";

      const creds = getCredentials();
      expect(creds).toEqual({
        serverUrl: "https://automate.example.com",
        clientId: "test-client-id",
        username: "test-username",
        password: "test-password",
        twoFactorCode: "123456",
        authMethod: undefined,
      });
    });

    it("should parse an explicit auth method and ignore invalid values", () => {
      process.env.CW_AUTOMATE_SERVER_URL = "https://automate.example.com";
      process.env.CW_AUTOMATE_CLIENT_ID = "test-client-id";
      process.env.CW_AUTOMATE_USERNAME = "test-username";
      process.env.CW_AUTOMATE_PASSWORD = "test-password";

      process.env.CW_AUTOMATE_AUTH_METHOD = "USER";
      expect(getCredentials()?.authMethod).toBe("user");

      process.env.CW_AUTOMATE_AUTH_METHOD = "bogus";
      expect(getCredentials()?.authMethod).toBeUndefined();
    });
  });

  describe("getClient", () => {
    it("should throw error when no credentials are configured", async () => {
      delete process.env.CW_AUTOMATE_SERVER_URL;
      delete process.env.CW_AUTOMATE_CLIENT_ID;
      delete process.env.CW_AUTOMATE_USERNAME;
      delete process.env.CW_AUTOMATE_PASSWORD;

      await expect(getClient()).rejects.toThrow(
        "No API credentials provided"
      );
    });

    it("should create client when valid credentials are provided", async () => {
      process.env.CW_AUTOMATE_SERVER_URL = "https://automate.example.com";
      process.env.CW_AUTOMATE_CLIENT_ID = "test-client-id";
      process.env.CW_AUTOMATE_USERNAME = "test-username";
      process.env.CW_AUTOMATE_PASSWORD = "test-password";

      const client = await getClient();
      expect(client).toBeDefined();
      expect(client.computers).toBeDefined();
      expect(client.clients).toBeDefined();
      expect(client.alerts).toBeDefined();
      expect(client.scripts).toBeDefined();
    });

    it("should default to integrator auth with nested credentials", async () => {
      process.env.CW_AUTOMATE_SERVER_URL = "https://automate.example.com";
      process.env.CW_AUTOMATE_CLIENT_ID = "test-client-id";
      process.env.CW_AUTOMATE_USERNAME = "test-username";
      process.env.CW_AUTOMATE_PASSWORD = "test-password";

      const config = configOf(await getClient());
      expect(config.serverUrl).toBe("https://automate.example.com");
      expect(config.clientId).toBe("test-client-id");
      expect(config.credentials.method).toBe("integrator");
      if (config.credentials.method === "integrator") {
        expect(config.credentials.integratorUsername).toBe("test-username");
        expect(config.credentials.integratorPassword).toBe("test-password");
      }
    });

    it("should use user auth when a 2FA code is supplied", async () => {
      process.env.CW_AUTOMATE_SERVER_URL = "https://automate.example.com";
      process.env.CW_AUTOMATE_CLIENT_ID = "test-client-id";
      process.env.CW_AUTOMATE_USERNAME = "test-username";
      process.env.CW_AUTOMATE_PASSWORD = "test-password";
      process.env.CW_AUTOMATE_2FA_CODE = "123456";

      const config = configOf(await getClient());
      expect(config.credentials.method).toBe("user");
      if (config.credentials.method === "user") {
        expect(config.credentials.username).toBe("test-username");
        expect(config.credentials.password).toBe("test-password");
        expect(config.credentials.twoFactorCode).toBe("123456");
      }
    });

    it("should honor an explicit user auth method without 2FA", async () => {
      process.env.CW_AUTOMATE_SERVER_URL = "https://automate.example.com";
      process.env.CW_AUTOMATE_CLIENT_ID = "test-client-id";
      process.env.CW_AUTOMATE_USERNAME = "test-username";
      process.env.CW_AUTOMATE_PASSWORD = "test-password";
      process.env.CW_AUTOMATE_AUTH_METHOD = "user";

      const config = configOf(await getClient());
      expect(config.credentials.method).toBe("user");
    });

    it("builds a fresh client on every call — no shared singleton across calls", async () => {
      process.env.CW_AUTOMATE_SERVER_URL = "https://automate.example.com";
      process.env.CW_AUTOMATE_CLIENT_ID = "test-client-id";
      process.env.CW_AUTOMATE_USERNAME = "test-username";
      process.env.CW_AUTOMATE_PASSWORD = "test-password";

      const client1 = await getClient();
      const client2 = await getClient();

      // A shared cache/singleton is exactly the mechanism that caused the
      // cross-tenant credential leak this fix closes -- there must be none.
      expect(client1).not.toBe(client2);
    });

    it("should create new client when credentials change", async () => {
      process.env.CW_AUTOMATE_SERVER_URL = "https://automate.example.com";
      process.env.CW_AUTOMATE_CLIENT_ID = "test-client-id-1";
      process.env.CW_AUTOMATE_USERNAME = "test-username";
      process.env.CW_AUTOMATE_PASSWORD = "test-password";

      const client1 = await getClient();

      // Change credentials
      process.env.CW_AUTOMATE_CLIENT_ID = "test-client-id-2";
      clearClient();

      const client2 = await getClient();

      expect(client1).not.toBe(client2);
    });
  });

  describe("clearClient", () => {
    it("should clear cached client", async () => {
      process.env.CW_AUTOMATE_SERVER_URL = "https://automate.example.com";
      process.env.CW_AUTOMATE_CLIENT_ID = "test-client-id";
      process.env.CW_AUTOMATE_USERNAME = "test-username";
      process.env.CW_AUTOMATE_PASSWORD = "test-password";

      const client1 = await getClient();
      clearClient();
      const client2 = await getClient();

      expect(client1).not.toBe(client2);
    });
  });
});
