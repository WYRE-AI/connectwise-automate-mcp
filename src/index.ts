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
 * - stdio: credentials via environment variables
 * - HTTP: credentials via env vars (AUTH_MODE=env) or per-request headers (AUTH_MODE=gateway)
 *
 * Gateway header mapping (from vendor-config.ts):
 *   X-CWA-Server      -> serverUrl
 *   X-CWA-Client-ID   -> clientId
 *   X-CWA-Username    -> username
 *   X-CWA-Password    -> password
 *   X-CWA-2FA         -> twoFactorCode (optional)
 *   X-CWA-Auth-Method -> authMethod ("integrator" | "user", optional; default integrator)
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { type CWAutomateCredentials } from "./utils/client.js";
import { createMcpServer, resolveGatewayCredentials } from "./mcp-server.js";
import { bindServerRef, runWithServerRef } from "./utils/server-ref.js";

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
 */
async function startHttpTransport(): Promise<void> {
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const host = process.env.MCP_HTTP_HOST || "0.0.0.0";
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
        console.error(
          `[MCP] ${req.method} /mcp from ${req.headers["x-forwarded-for"] || req.socket.remoteAddress}` +
            ` hasServer=${!!req.headers["x-cwa-server"]}` +
            ` hasClientId=${!!req.headers["x-cwa-client-id"]}`
        );

        // In gateway mode, extract per-request credentials from headers
        // and pass them directly to createMcpServer() for isolation.
        // No process.env mutation -- each request gets its own client.
        let credentialOverrides: CWAutomateCredentials | undefined;
        if (isGatewayMode) {
          const { creds } = resolveGatewayCredentials(
            (name) => req.headers[name] as string | undefined
          );
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

  await new Promise<void>((resolve) => {
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

  // Graceful shutdown
  const shutdown = async () => {
    console.error("Shutting down ConnectWise Automate MCP server...");
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Start the server
async function main() {
  const transportType = process.env.MCP_TRANSPORT || "stdio";

  if (transportType === "http") {
    await startHttpTransport();
  } else {
    await startStdioTransport();
  }
}

main().catch((error) => {
  console.error("Failed to start ConnectWise Automate MCP server:", error);
  process.exit(1);
});

// Export for testing
export { createMcpServer };
export { startHttpTransport, startStdioTransport };
