/**
 * Shared MCP server factory for ConnectWise Automate.
 *
 * This module is **side-effect free** (importing it never starts a transport),
 * so it can be reused by every entrypoint:
 * - `index.ts` — stdio + Node HTTP transport
 * - `worker.ts` — Cloudflare Workers (Web Standard) transport
 *
 * All tools are exposed upfront (flat architecture) for universal MCP client
 * compatibility.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getDomainHandler, getAvailableDomains } from "./domains/index.js";
import { isDomainName, type DomainName } from "./utils/types.js";
import {
  getCredentials,
  hasCredentials,
  parseAuthMethod,
  type CWAutomateCredentials,
} from "./utils/client.js";
import { registerResourceHandlers } from "./resources.js";

export type { CWAutomateCredentials };

/**
 * Domain metadata for navigation
 */
const domainDescriptions: Record<DomainName, string> = {
  computers:
    "Endpoint management - list, get, manage computers and devices in ConnectWise Automate",
  clients:
    "Company management - list and get client/company information and relationships",
  alerts:
    "Alert monitoring - view system alerts and notifications (read-only in the Automate API)",
  scripts:
    "Script management - list, get, and execute automation scripts (DESTRUCTIVE operations available)",
};

/**
 * Navigation / discovery tool - helps the LLM find the right tools
 */
const navigateTool: Tool = {
  name: "cwautomate_navigate",
  description:
    "Discover available ConnectWise Automate tools by domain. Returns tool names and descriptions for the selected domain. All tools are callable at any time — this is a help/discovery aid, not a prerequisite.",
  inputSchema: {
    type: "object",
    properties: {
      domain: {
        type: "string",
        enum: getAvailableDomains(),
        description: `The domain to explore:
- computers: ${domainDescriptions.computers}
- clients: ${domainDescriptions.clients}
- alerts: ${domainDescriptions.alerts}
- scripts: ${domainDescriptions.scripts}`,
      },
    },
    required: ["domain"],
  },
};

/**
 * Status tool - shows credentials status and available domains
 */
const statusTool: Tool = {
  name: "cwautomate_status",
  description: "Show credentials status and available domains",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

/**
 * Map from domain name to its tool definitions (loaded lazily)
 */
const domainToolMap = new Map<DomainName, Tool[]>();

/**
 * All domain tools, collected once at startup
 */
let allDomainTools: Tool[] | null = null;

/**
 * Load all domain tools (memoized at module scope; the tool set is static and
 * credential-independent, but a fresh server is created per request).
 */
async function getAllDomainTools(): Promise<Tool[]> {
  if (allDomainTools !== null) {
    return allDomainTools;
  }

  const domains = getAvailableDomains();
  const tools: Tool[] = [];

  for (const domain of domains) {
    if (!domainToolMap.has(domain)) {
      const handler = await getDomainHandler(domain);
      const domainTools = handler.getTools();
      domainToolMap.set(domain, domainTools);
    }
    tools.push(...domainToolMap.get(domain)!);
  }

  allDomainTools = tools;
  return tools;
}

/**
 * Resolve per-request gateway credentials from a header accessor.
 *
 * Works with any transport: pass a getter that returns a (lowercased) header
 * value. Returns `{ creds }` when all required headers are present, or
 * `{ error }` otherwise.
 *
 * Gateway header mapping:
 *   X-CWA-Server      -> serverUrl
 *   X-CWA-Client-ID   -> clientId
 *   X-CWA-Username    -> username
 *   X-CWA-Password    -> password
 *   X-CWA-2FA         -> twoFactorCode (optional)
 *   X-CWA-Auth-Method -> authMethod ("integrator" | "user", optional; default integrator)
 */
export function resolveGatewayCredentials(
  getHeader: (lowerName: string) => string | undefined
): { creds?: CWAutomateCredentials; error?: string } {
  const serverUrl = getHeader("x-cwa-server");
  const clientId = getHeader("x-cwa-client-id");
  const username = getHeader("x-cwa-username");
  const password = getHeader("x-cwa-password");
  const twoFactorCode = getHeader("x-cwa-2fa");
  const authMethod = parseAuthMethod(getHeader("x-cwa-auth-method"));

  if (!serverUrl || !clientId || !username || !password) {
    return {
      error:
        "Missing credentials: X-CWA-Server / X-CWA-Client-ID / X-CWA-Username / X-CWA-Password",
    };
  }

  const creds: CWAutomateCredentials = {
    serverUrl,
    clientId,
    username,
    password,
  };
  if (twoFactorCode) {
    creds.twoFactorCode = twoFactorCode;
  }
  if (authMethod) {
    creds.authMethod = authMethod;
  }
  return { creds };
}

/**
 * Create a fresh MCP server instance with all handlers registered.
 * Called once for stdio, or per-request for HTTP / Workers transports.
 *
 * @param credentialOverrides - Optional credentials for gateway mode.
 *   When provided, a per-request client is created from these credentials
 *   instead of reading from process.env.
 */
export function createMcpServer(
  credentialOverrides?: CWAutomateCredentials
): Server {
  const server = new Server(
    {
      name: "connectwise-automate-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  // The caller owns binding this server into server-ref.ts's scope now
  // (bindServerRef for stdio's single session, runWithServerRef wrapping
  // the whole per-request chain for HTTP/Workers) — createMcpServer() stays
  // side-effect-free with respect to server-ref.
  registerResourceHandlers(server);

  /**
   * Handle ListTools requests - always returns ALL tools
   */
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const domainTools = await getAllDomainTools();
    return { tools: [navigateTool, statusTool, ...domainTools] };
  });

  /**
   * Handle CallTool requests
   */
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // credentialOverrides is captured in this closure per createMcpServer()
    // call (one per request in gateway mode) and threaded explicitly through
    // handler.handleCall(..., credentialOverrides) below -- no shared mutable
    // state, so concurrent requests cannot observe each other's credentials.
    try {
      // Handle navigation / discovery helper
      if (name === "cwautomate_navigate") {
        const { domain } = args as { domain: DomainName };

        if (!isDomainName(domain)) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid domain: ${domain}. Available domains: ${getAvailableDomains().join(", ")}`,
              },
            ],
            isError: true,
          };
        }

        const handler = await getDomainHandler(domain);
        const tools = handler.getTools();

        const toolSummary = tools
          .map((t) => `- ${t.name}: ${t.description}`)
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: `${domainDescriptions[domain]}\n\nAvailable tools:\n${toolSummary}\n\nYou can call any of these tools directly.`,
            },
          ],
        };
      }

      if (name === "cwautomate_status") {
        const hasCreds = hasCredentials(credentialOverrides);
        const envCreds = getCredentials();
        const credStatus = hasCreds
          ? credentialOverrides
            ? `Configured (gateway mode, server: ${credentialOverrides.serverUrl})`
            : `Configured (server: ${envCreds?.serverUrl})`
          : "NOT CONFIGURED - Please set environment variables";

        return {
          content: [
            {
              type: "text",
              text: `ConnectWise Automate MCP Server Status\n\nCredentials: ${credStatus}\nAvailable domains: ${getAvailableDomains().join(", ")}\n\nCall conduit__my_access to see which tools are available to you.`,
            },
          ],
        };
      }

      // Route to appropriate domain handler
      const toolArgs = (args ?? {}) as Record<string, unknown>;

      if (name.startsWith("cwautomate_computers_")) {
        const handler = await getDomainHandler("computers");
        return await handler.handleCall(name, toolArgs, credentialOverrides);
      }
      if (name.startsWith("cwautomate_clients_")) {
        const handler = await getDomainHandler("clients");
        return await handler.handleCall(name, toolArgs, credentialOverrides);
      }
      if (name.startsWith("cwautomate_alerts_")) {
        const handler = await getDomainHandler("alerts");
        return await handler.handleCall(name, toolArgs, credentialOverrides);
      }
      if (name.startsWith("cwautomate_scripts_")) {
        const handler = await getDomainHandler("scripts");
        return await handler.handleCall(name, toolArgs, credentialOverrides);
      }

      // Unknown tool
      return {
        content: [
          {
            type: "text",
            text: `Unknown tool: ${name}. Call conduit__my_access to see which tools are available to you.`,
          },
        ],
        isError: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}
