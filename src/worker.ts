/**
 * Cloudflare Workers entry point for the ConnectWise Automate MCP Server.
 *
 * Serves the full MCP server over the Streamable HTTP transport using the SDK's
 * Web Standard transport (Request/Response), which runs natively on Workers.
 * It reuses the exact same `createMcpServer()` factory as the stdio / Node HTTP
 * entrypoints (see `mcp-server.ts`), so there is no second tool implementation
 * to maintain.
 *
 * Credentials are resolved per request, in order:
 * 1. Gateway headers (when AUTH_MODE=gateway):
 *    - X-CWA-Server    -> serverUrl
 *    - X-CWA-Client-ID -> clientId
 *    - X-CWA-Username  -> username
 *    - X-CWA-Password  -> password
 *    - X-CWA-2FA       -> twoFactorCode (optional)
 * 2. Worker secrets / vars (env mode):
 *    - CW_AUTOMATE_SERVER_URL
 *    - CW_AUTOMATE_CLIENT_ID
 *    - CW_AUTOMATE_USERNAME
 *    - CW_AUTOMATE_PASSWORD
 *    - CW_AUTOMATE_2FA_CODE (optional)
 *
 * `tools/list` and `initialize` work without credentials; only `tools/call`
 * requires them.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  createMcpServer,
  resolveGatewayCredentials,
  type CWAutomateCredentials,
} from "./mcp-server.js";
import { runWithServerRef } from "./utils/server-ref.js";

export interface Env {
  CW_AUTOMATE_SERVER_URL?: string;
  CW_AUTOMATE_CLIENT_ID?: string;
  CW_AUTOMATE_USERNAME?: string;
  CW_AUTOMATE_PASSWORD?: string;
  CW_AUTOMATE_2FA_CODE?: string;
  AUTH_MODE?: string;
  LOG_LEVEL?: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, X-CWA-Server, X-CWA-Client-ID, X-CWA-Username, X-CWA-Password, X-CWA-2FA",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * Build credentials from Worker env bindings (env mode). Returns undefined
 * when the required vars are absent (tools/list still works; tools/call errors).
 */
function credentialsFromEnv(env: Env): CWAutomateCredentials | undefined {
  if (
    !env.CW_AUTOMATE_SERVER_URL ||
    !env.CW_AUTOMATE_CLIENT_ID ||
    !env.CW_AUTOMATE_USERNAME ||
    !env.CW_AUTOMATE_PASSWORD
  ) {
    return undefined;
  }
  const creds: CWAutomateCredentials = {
    serverUrl: env.CW_AUTOMATE_SERVER_URL,
    clientId: env.CW_AUTOMATE_CLIENT_ID,
    username: env.CW_AUTOMATE_USERNAME,
    password: env.CW_AUTOMATE_PASSWORD,
  };
  if (env.CW_AUTOMATE_2FA_CODE) {
    creds.twoFactorCode = env.CW_AUTOMATE_2FA_CODE;
  }
  return creds;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Shallow, unauthenticated liveness probe.
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      return json({ status: "ok" });
    }

    if (url.pathname === "/mcp") {
      const isGatewayMode = (env.AUTH_MODE ?? "env") === "gateway";

      let credOverrides: CWAutomateCredentials | undefined;
      if (isGatewayMode) {
        const { creds, error } = resolveGatewayCredentials(
          (name) => request.headers.get(name) ?? undefined
        );
        if (error) {
          return json(
            {
              error: "Missing credentials",
              message: error,
              required: [
                "X-CWA-Server",
                "X-CWA-Client-ID",
                "X-CWA-Username",
                "X-CWA-Password",
              ],
              optional: ["X-CWA-2FA"],
            },
            401
          );
        }
        credOverrides = creds;
      } else {
        credOverrides = credentialsFromEnv(env);
      }

      // Fresh server + transport per request (stateless). The whole chain
      // below runs inside runWithServerRef so the server-ref binding — used
      // by elicitation (elicitText/elicitSelection) — survives every await
      // gap in this request's lifecycle without leaking into a concurrent
      // request's server-ref.
      const server = createMcpServer(credOverrides);
      return runWithServerRef(server, async () => {
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        await server.connect(transport);

        try {
          const response = await transport.handleRequest(request);
          return withCors(response);
        } finally {
          await transport.close();
          await server.close();
        }
      });
    }

    return json({ error: "Not found", endpoints: ["/mcp", "/health"] }, 404);
  },
};
