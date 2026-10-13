/**
 * HTTP transport fail-closed auth.
 *
 * Startup requires a real CONDUIT_S2S_SECRET unless MCP_ALLOW_INSECURE_DEV=1.
 * Known placeholders are rejected even with that flag. The insecure-dev
 * bypass binds 127.0.0.1 only. /mcp rejects a missing or invalid
 * X-Gateway-S2S header. AUTH_MODE=gateway rejects requests that omit
 * vendor credential headers and must not fall back to CW_AUTOMATE_*.
 */

import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startHttpTransport } from "../index.js";

const S2S_SECRET = "s2s-do-not-log-7f3a";
const ENV_SERVER = "https://env-must-not-be-used.example";
const ENV_CLIENT_ID = "env-client-id-must-not-be-used";
const ENV_USERNAME = "env-user-must-not-be-used";
const ENV_PASSWORD = "env-pass-must-not-leak";
const HEADER_SERVER = "https://header-tenant.example";

const ENV_KEYS = [
  "CONDUIT_S2S_SECRET",
  "MCP_ALLOW_INSECURE_DEV",
  "MCP_HTTP_PORT",
  "MCP_HTTP_HOST",
  "AUTH_MODE",
  "CW_AUTOMATE_SERVER_URL",
  "CW_AUTOMATE_CLIENT_ID",
  "CW_AUTOMATE_USERNAME",
  "CW_AUTOMATE_PASSWORD",
  "CW_AUTOMATE_2FA_CODE",
  "CW_AUTOMATE_AUTH_METHOD",
  "MCP_TRANSPORT",
] as const;

const savedEnv = new Map<string, string | undefined>();
const servers: Server[] = [];

function mintS2sHeader(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac("sha256", secret).update(message).digest("hex");
  return `${message},v1=${hex}`;
}

function captureStderr(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  });
  return {
    text: () => lines.join("\n"),
    restore: () => spy.mockRestore(),
  };
}

function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as typeof process.exit);
}

interface HttpResult {
  status: number;
  body: string;
}

function mcpHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extra,
  };
}

const statusCall = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "cwautomate_status", arguments: {} },
});

async function sendHttp(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpResult> {
  const response = await fetch(`http://127.0.0.1:${options.port}${options.path}`, {
    method: options.method,
    headers: options.headers,
    body: options.body,
  });
  return { status: response.status, body: await response.text() };
}

async function listen(): Promise<{ port: number; address: string; close: () => Promise<void> }> {
  const server = await startHttpTransport();
  servers.push(server);
  const bound = server.address() as AddressInfo | string | null;
  if (!bound || typeof bound === "string") {
    throw new Error("HTTP server did not bind a TCP port");
  }
  return {
    port: bound.port,
    address: bound.address,
    close: () =>
      new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterAll(async () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server?.listening) continue;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

beforeEach(() => {
  process.env.MCP_HTTP_PORT = "0";
  process.env.MCP_HTTP_HOST = "127.0.0.1";
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.MCP_ALLOW_INSECURE_DEV;
  delete process.env.AUTH_MODE;
  delete process.env.CW_AUTOMATE_SERVER_URL;
  delete process.env.CW_AUTOMATE_CLIENT_ID;
  delete process.env.CW_AUTOMATE_USERNAME;
  delete process.env.CW_AUTOMATE_PASSWORD;
  delete process.env.CW_AUTOMATE_2FA_CODE;
  delete process.env.CW_AUTOMATE_AUTH_METHOD;
  delete process.env.MCP_TRANSPORT;
});

describe("HTTP startup", () => {
  it("refuses to start when CONDUIT_S2S_SECRET is empty", async () => {
    const logs = captureStderr();
    const exitSpy = mockExit();

    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(exitSpy).toHaveBeenCalledWith(1);
      const text = logs.text();
      expect(text).toContain("Refusing to start HTTP transport");
      expect(text).toContain("CONDUIT_S2S_SECRET is empty");
      expect(text).not.toContain(S2S_SECRET);
    } finally {
      exitSpy.mockRestore();
      logs.restore();
    }
  });

  it("still refuses when MCP_ALLOW_INSECURE_DEV is not exactly 1", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "true";
    process.env.CONDUIT_S2S_SECRET = "   ";
    const logs = captureStderr();
    const exitSpy = mockExit();

    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(logs.text()).toContain("CONDUIT_S2S_SECRET is empty");
      expect(logs.text()).not.toContain("known placeholder");
    } finally {
      exitSpy.mockRestore();
      logs.restore();
    }
  });

  it.each(["replace-with-a-real-secret", "  Your-S2S-Secret  ", "ChangeMe"])(
    "refuses a known placeholder (%j) and does not log it",
    async (placeholder) => {
      process.env.CONDUIT_S2S_SECRET = placeholder;
      process.env.MCP_ALLOW_INSECURE_DEV = "1";
      const logs = captureStderr();
      const exitSpy = mockExit();

      try {
        await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
        expect(exitSpy).toHaveBeenCalledWith(1);
        const text = logs.text();
        expect(text).toContain("known placeholder");
        expect(text).toContain("openssl rand -hex 32");
        expect(text).not.toContain(placeholder.trim());
        expect(text).not.toContain(S2S_SECRET);
      } finally {
        exitSpy.mockRestore();
        logs.restore();
      }
    }
  );

  it("allows startup with a warning when MCP_ALLOW_INSECURE_DEV=1", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    delete process.env.MCP_HTTP_HOST;
    const logs = captureStderr();
    let close: (() => Promise<void>) | undefined;
    try {
      const server = await listen();
      close = server.close;
      expect(server.address).toBe("127.0.0.1");
      const text = logs.text();
      expect(text).toContain("SECURITY WARNING");
      expect(text).toContain("CONDUIT_S2S_SECRET");
      expect(text).toContain("MCP_ALLOW_INSECURE_DEV=1");
      expect(text).toContain("127.0.0.1");
      expect(text).not.toContain("not a loopback address");
      expect(text).not.toContain(S2S_SECRET);
    } finally {
      logs.restore();
      await close?.();
    }
  });

  it.each(["0.0.0.0", "10.1.2.3"])(
    "forces 127.0.0.1 when the dev bypass is set and MCP_HTTP_HOST is %s",
    async (host) => {
      process.env.MCP_ALLOW_INSECURE_DEV = "1";
      process.env.MCP_HTTP_HOST = host;
      const logs = captureStderr();
      const exitSpy = mockExit();
      let close: (() => Promise<void>) | undefined;

      try {
        const server = await listen();
        close = server.close;
        expect(exitSpy).not.toHaveBeenCalled();
        expect(server.address).toBe("127.0.0.1");
        const text = logs.text();
        expect(text).toContain(`MCP_HTTP_HOST=${host} is not a loopback address`);
        expect(text).toContain("Binding 127.0.0.1 only");
        expect(text).not.toContain(S2S_SECRET);
      } finally {
        exitSpy.mockRestore();
        logs.restore();
        await close?.();
      }
    }
  );

  it("still binds a non-loopback host when CONDUIT_S2S_SECRET is set", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = "0.0.0.0";
    const logs = captureStderr();
    const server = await listen();
    try {
      expect(server.address).toBe("0.0.0.0");
      expect(logs.text()).not.toContain("not a loopback address");
      expect(logs.text()).not.toContain(S2S_SECRET);
    } finally {
      logs.restore();
      await server.close();
    }
  });

  it("binds 127.0.0.1 when MCP_HTTP_HOST is unset and a secret is set", async () => {
    delete process.env.MCP_HTTP_HOST;
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    const server = await listen();
    try {
      expect(server.address).toBe("127.0.0.1");
    } finally {
      await server.close();
    }
  });

  it("trims a real secret before verifying X-Gateway-S2S", async () => {
    process.env.CONDUIT_S2S_SECRET = `  ${S2S_SECRET}  `;
    process.env.AUTH_MODE = "gateway";
    const server = await listen();
    try {
      const response = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({
          "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
          "x-cwa-server": HEADER_SERVER,
          "x-cwa-client-id": "header-client",
          "x-cwa-username": "header-user",
          "x-cwa-password": "header-pass",
        }),
        body: statusCall,
      });
      expect(response.status).toBe(200);
      expect(response.body).toContain(HEADER_SERVER);
      expect(response.body).not.toContain(S2S_SECRET);
    } finally {
      await server.close();
    }
  });
});

describe("HTTP /mcp authentication", () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = "gateway";
    process.env.CW_AUTOMATE_SERVER_URL = ENV_SERVER;
    process.env.CW_AUTOMATE_CLIENT_ID = ENV_CLIENT_ID;
    process.env.CW_AUTOMATE_USERNAME = ENV_USERNAME;
    process.env.CW_AUTOMATE_PASSWORD = ENV_PASSWORD;
  });

  it("returns 401 when the S2S header is missing or invalid and does not log the secret", async () => {
    const logs = captureStderr();
    const server = await listen();
    try {
      const credentialHeaders = {
        "x-cwa-server": HEADER_SERVER,
        "x-cwa-client-id": "header-client",
        "x-cwa-username": "header-user",
        "x-cwa-password": "header-pass",
      };
      const missing = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders(credentialHeaders),
        body: statusCall,
      });
      const invalid = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({
          ...credentialHeaders,
          "x-gateway-s2s": mintS2sHeader("wrong-secret"),
        }),
        body: statusCall,
      });

      expect(missing.status).toBe(401);
      expect(invalid.status).toBe(401);
      expect(missing.body).toContain("X-Gateway-S2S");
      expect(invalid.body).toContain("X-Gateway-S2S");
      expect(missing.body).not.toContain(S2S_SECRET);
      expect(invalid.body).not.toContain(S2S_SECRET);
      expect(missing.body).not.toContain(ENV_PASSWORD);
      expect(missing.body).not.toContain(ENV_SERVER);
      expect(logs.text()).not.toContain(S2S_SECRET);
      expect(logs.text()).not.toContain(ENV_PASSWORD);
    } finally {
      logs.restore();
      await server.close();
    }
  });

  it("returns 401 in gateway mode without credential headers and does not use env credentials", async () => {
    const server = await listen();
    try {
      const response = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({ "x-gateway-s2s": mintS2sHeader(S2S_SECRET) }),
        body: statusCall,
      });

      expect(response.status).toBe(401);
      expect(response.body).toContain("Missing credentials");
      expect(response.body).toContain("X-CWA-Server");
      expect(response.body).toContain("X-CWA-Client-ID");
      expect(response.body).toContain("X-CWA-Username");
      expect(response.body).toContain("X-CWA-Password");
      expect(response.body).not.toContain(ENV_SERVER);
      expect(response.body).not.toContain(ENV_CLIENT_ID);
      expect(response.body).not.toContain(ENV_USERNAME);
      expect(response.body).not.toContain(ENV_PASSWORD);
      expect(response.body).not.toContain(S2S_SECRET);

      const partial = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({
          "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
          "x-cwa-username": "header-user",
        }),
        body: statusCall,
      });
      expect(partial.status).toBe(401);
      expect(partial.body).toContain("Missing credentials");
      expect(partial.body).not.toContain(ENV_PASSWORD);
    } finally {
      await server.close();
    }
  });

  it("accepts a valid S2S header plus credential headers and uses those credentials", async () => {
    const logs = captureStderr();
    const server = await listen();
    try {
      const response = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({
          "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
          "x-cwa-server": HEADER_SERVER,
          "x-cwa-client-id": "header-client",
          "x-cwa-username": "header-user",
          "x-cwa-password": "header-pass",
        }),
        body: statusCall,
      });

      expect(response.status).toBe(200);
      expect(response.body).toContain(`gateway mode, server: ${HEADER_SERVER}`);
      expect(response.body).not.toContain(ENV_SERVER);
      expect(response.body).not.toContain(ENV_CLIENT_ID);
      expect(response.body).not.toContain(ENV_USERNAME);
      expect(response.body).not.toContain(ENV_PASSWORD);
      expect(response.body).not.toContain(S2S_SECRET);
      expect(logs.text()).not.toContain(S2S_SECRET);
      expect(logs.text()).not.toContain(ENV_PASSWORD);
    } finally {
      logs.restore();
      await server.close();
    }
  });

  it("serves /health without authentication and without reading credentials", async () => {
    const server = await listen();
    try {
      const response = await sendHttp({
        port: server.port,
        method: "GET",
        path: "/health",
      });
      expect(response.status).toBe(200);
      const body = JSON.parse(response.body) as { status?: string; authMode?: string };
      expect(body.status).toBe("ok");
      expect(body.authMode).toBe("gateway");
      expect(response.body).not.toContain(S2S_SECRET);
      expect(response.body).not.toContain(ENV_SERVER);
      expect(response.body).not.toContain(ENV_PASSWORD);
    } finally {
      await server.close();
    }
  });
});
