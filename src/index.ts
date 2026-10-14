#!/usr/bin/env node
/**
 * ConnectWise Automate MCP Server
 *
 * This MCP server provides tools for interacting with the ConnectWise Automate API.
 * All tools are listed upfront so they work with every MCP client, including
 * remote connectors (claude.ai, mcp-remote) that do not support dynamic
 * tool-list changes. A helper `cwautomate_navigate` tool provides domain
 * discovery and guidance.
 *
 * Supports both stdio and HTTP (StreamableHTTP) transports.
 * - stdio: credentials via environment variables. Does not use CONDUIT_S2S_SECRET.
 * - HTTP: credentials via env vars (AUTH_MODE=env) or per-request headers (AUTH_MODE=gateway)
 *
 * HTTP transport refuses to start unless CONDUIT_S2S_SECRET is a real secret.
 * Known placeholders are rejected. MCP_ALLOW_INSECURE_DEV=1 is a local-only
 * escape hatch: it logs a warning, skips X-Gateway-S2S, and binds 127.0.0.1
 * only. A configured secret honors MCP_HTTP_HOST (default 127.0.0.1).
 * Gateway mode never falls back to CW_AUTOMATE_* env credentials.
 * /health stays unauthenticated and does not read credentials.
 *
 * Gateway header mapping (from vendor-config.ts):
 *   X-CWA-Server      -> serverUrl
 *   X-CWA-Client-ID   -> clientId
 *   X-CWA-Username    -> username
 *   X-CWA-Password    -> password
 *   X-CWA-2FA         -> twoFactorCode (optional)
 *   X-CWA-Auth-Method -> authMethod ("integrator" | "user", optional; default integrator)
 *   X-Gateway-S2S     -> HMAC proof keyed with CONDUIT_S2S_SECRET (required on /mcp)
 */

import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { type CWAutomateCredentials } from "./utils/client.js";
import { createMcpServer, resolveGatewayCredentials } from "./mcp-server.js";
import { bindServerRef, runWithServerRef } from "./utils/server-ref.js";
import { verifyS2sHeader, S2S_HEADER } from "./s2s-verify.js";

/**
 * Public example values. A copied placeholder must not verify as a real
 * secret, including when MCP_ALLOW_INSECURE_DEV=1 is set.
 */
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-real-secret",
  "your-s2s-secret",
  "your-secret",
  "changeme",
  "change-me",
  "placeholder",
  "secret",
  "example",
  "replace-me",
  "s2s-secret",
]);

const MISSING_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. " +
  "Set CONDUIT_S2S_SECRET to the gateway-provisioned secret (openssl rand -hex 32), " +
  "or set MCP_ALLOW_INSECURE_DEV=1 for local development only.";

const PLACEHOLDER_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. " +
  "Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value.";

const INSECURE_DEV_WARNING =
  "SECURITY WARNING: CONDUIT_S2S_SECRET is empty and MCP_ALLOW_INSECURE_DEV=1. " +
  "HTTP /mcp is starting with service-to-service authentication DISABLED, bound to 127.0.0.1 only. " +
  "Local development only; do not expose this port.";

const LOOPBACK_HOST = "127.0.0.1";

const S2S_UNAUTHORIZED = {
  error:
    "Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.",
};

function singleHeader(
  value: string | string[] | undefined
): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Hosts the insecure-dev bypass may treat as loopback. The listener is still 127.0.0.1. */
function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]"
  ) {
    return true;
  }
  const bare = normalized.startsWith("::ffff:")
    ? normalized.slice("::ffff:".length)
    : normalized;
  const parts = bare.split(".");
  if (parts.length !== 4) return false;
  if (parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    return false;
  }
  return parts[0] === "127";
}

/**
 * Secret for X-Gateway-S2S on /mcp. Read at HTTP startup, not module load.
 * Empty is fail-closed unless MCP_ALLOW_INSECURE_DEV=1. A known placeholder
 * always refuses to start. The secret value is never written to logs.
 */
function resolveS2sSecret(): { secret: string; insecureDev: boolean } {
  const raw = (process.env.CONDUIT_S2S_SECRET ?? "").trim();
  if (KNOWN_PLACEHOLDER_SECRETS.has(raw.toLowerCase())) {
    console.error(PLACEHOLDER_S2S_SECRET_ERROR);
    process.exit(1);
  }
  if (raw) return { secret: raw, insecureDev: false };
  if (process.env.MCP_ALLOW_INSECURE_DEV === "1") {
    console.error(INSECURE_DEV_WARNING);
    return { secret: "", insecureDev: true };
  }
  console.error(MISSING_S2S_SECRET_ERROR);
  process.exit(1);
}

/**
 * No secret (insecure-dev bypass only) always binds 127.0.0.1, even when
 * MCP_HTTP_HOST is a wider address. A configured secret honors MCP_HTTP_HOST
 * and defaults to 127.0.0.1 when that variable is unset.
 */
function resolveListenHost(insecureDev: boolean): string {
  const configured = (process.env.MCP_HTTP_HOST ?? "").trim();
  if (!insecureDev) {
    return configured === "" ? LOOPBACK_HOST : configured;
  }
  if (configured !== "" && !isLoopbackHost(configured)) {
    console.error(
      `WARNING: MCP_HTTP_HOST=${configured} is not a loopback address. ` +
        "MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET cannot listen there. " +
        `Binding ${LOOPBACK_HOST} only.`
    );
  }
  return LOOPBACK_HOST;
}

/**
 * Start the server with stdio transport (default)
 */
async function startStdioTransport(): Promise<void> {
  const server = createMcpServer();
  // stdio is single-session for the whole process — no concurrent tenants
  // to isolate from each other, so enterWith's process-lifetime binding is
  // safe.
  bindServerRef(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    "ConnectWise Automate MCP server running on stdio"
  );
}

/**
 * Start the server with HTTP Streamable transport.
 * In gateway mode, credentials are extracted from request headers on each request.
 * No process.env mutation -- each request gets its own isolated client.
 * Missing gateway credential headers are rejected; they never fall back to
 * CW_AUTOMATE_* in the process environment.
 */
export async function startHttpTransport(): Promise<HttpServer> {
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const { secret: s2sSecret, insecureDev } = resolveS2sSecret();
  const host = resolveListenHost(insecureDev);
  const isGatewayMode = process.env.AUTH_MODE === "gateway";

  const httpServer = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(
        req.url || "/",
        `http://${req.headers.host || "localhost"}`
      );

      // Health endpoint - no auth required
      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            transport: "http",
            authMode: isGatewayMode ? "gateway" : "env",
            timestamp: new Date().toISOString(),
          })
        );
        return;
      }

      // MCP endpoint -- create a new Server + Transport per request so that
      // each initialize handshake gets a fresh server (the MCP SDK rejects
      // initialize on an already-initialized server).
      if (url.pathname === "/mcp") {
        // Empty s2sSecret is only reachable when MCP_ALLOW_INSECURE_DEV=1;
        // startup refuses otherwise. A configured secret is always enforced,
        // before any credential extraction.
        if (
          s2sSecret &&
          !verifyS2sHeader(singleHeader(req.headers[S2S_HEADER]), s2sSecret)
        ) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify(S2S_UNAUTHORIZED));
          return;
        }

        console.error(
          `[MCP] ${req.method} /mcp from ${req.headers["x-forwarded-for"] || req.socket.remoteAddress}` +
            ` hasServer=${!!req.headers["x-cwa-server"]}` +
            ` hasClientId=${!!req.headers["x-cwa-client-id"]}`
        );

        // In gateway mode, extract per-request credentials from headers
        // and pass them directly to createMcpServer() for isolation.
        // No process.env mutation -- each request gets its own client.
        // Missing headers are a 401. Falling through would resolve
        // CW_AUTOMATE_* from the process environment, which is not
        // request-scoped.
        let credentialOverrides: CWAutomateCredentials | undefined;
        if (isGatewayMode) {
          const { creds, error } = resolveGatewayCredentials((name) =>
            singleHeader(req.headers[name])
          );
          if (!creds) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: "Missing credentials",
                message:
                  error ??
                  "Missing credentials: X-CWA-Server / X-CWA-Client-ID / X-CWA-Username / X-CWA-Password",
                required: [
                  "X-CWA-Server",
                  "X-CWA-Client-ID",
                  "X-CWA-Username",
                  "X-CWA-Password",
                ],
                optional: ["X-CWA-2FA", "X-CWA-Auth-Method"],
              })
            );
            return;
          }
          credentialOverrides = creds;
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });

        const server = createMcpServer(credentialOverrides);

        res.on("close", () => {
          transport.close();
          server.close();
        });

        // The whole chain below (connect through the catch handler) runs
        // inside runWithServerRef so the server-ref binding — used by
        // elicitation (elicitText/elicitSelection) — survives every await
        // gap in this request's lifecycle without leaking into a
        // concurrent request's server-ref.
        runWithServerRef(server, () =>
          server
            .connect(transport)
            .then(() => {
              transport.handleRequest(req, res);
            })
            .catch((err) => {
              console.error("[MCP] transport error:", err);
              if (!res.headersSent) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    error: { code: -32603, message: "Internal error" },
                    id: null,
                  })
                );
              }
            })
        );
        return;
      }

      // 404 for everything else
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Not found",
          endpoints: ["/mcp", "/health"],
        })
      );
    }
  );

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      console.error(
        `ConnectWise Automate MCP server listening on http://${host}:${port}/mcp`
      );
      console.error(
        `Health check available at http://${host}:${port}/health`
      );
      console.error(
        `Authentication mode: ${isGatewayMode ? "gateway (header-based)" : "env (environment variables)"}`
      );
      resolve();
    });
  });

  return httpServer;
}

// Start the server
async function main() {
  const transportType = process.env.MCP_TRANSPORT || "stdio";

  if (transportType === "http") {
    const httpServer = await startHttpTransport();
    const shutdown = async () => {
      console.error("Shutting down ConnectWise Automate MCP server...");
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else {
    await startStdioTransport();
  }
}

// Vitest imports this module to call startHttpTransport. Skip the CLI
// entrypoint there. `node dist/index.js` still starts stdio or HTTP.
if (process.env.VITEST !== "true") {
  main().catch((error) => {
    console.error("Failed to start ConnectWise Automate MCP server:", error);
    process.exit(1);
  });
}

// Export for testing
export { createMcpServer };
export { startStdioTransport };
