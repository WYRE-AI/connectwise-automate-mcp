/**
 * Computers domain handler
 *
 * Provides tools for computer operations in ConnectWise Automate.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ComputerListParams } from "@wyre-technology/node-connectwise-automate";
import type { DomainHandler, CallToolResult } from "../utils/types.js";
import { getClient } from "../utils/client.js";
import { elicitText } from "../utils/elicitation.js";
import { toPage } from "../utils/pagination.js";
import { jsonResult, listResult } from "../utils/results.js";
import { buildDeviceCard, DEVICE_CARD_META } from "../card.builder.js";

/**
 * Escape single quotes for an OData-style condition string value.
 */
function escapeConditionValue(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Get computer domain tools
 */
function getTools(): Tool[] {
  return [
    {
      name: "cwautomate_computers_list",
      description:
        "List computers in ConnectWise Automate. Can filter by client, location, or online status.",
      inputSchema: {
        type: "object" as const,
        properties: {
          client_id: {
            type: "number",
            description: "Filter computers by client ID",
          },
          location_id: {
            type: "number",
            description: "Filter computers by location ID",
          },
          status: {
            type: "string",
            enum: ["online", "offline", "all"],
            description: "Filter by online status (default: all)",
          },
          limit: {
            type: "number",
            description: "Maximum number of results per page (default: 50)",
          },
          skip: {
            type: "number",
            description: "Number of results to skip for pagination",
          },
        },
      },
    },
    {
      name: "cwautomate_computers_get",
      description: "Get details for a specific computer by its ID",
      _meta: DEVICE_CARD_META,
      inputSchema: {
        type: "object" as const,
        properties: {
          computer_id: {
            type: "number",
            description: "The computer ID",
          },
        },
        required: ["computer_id"],
      },
    },
    {
      name: "cwautomate_computers_search",
      description: "Search for computers by name (matches any part of the computer name)",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Search query matched against the computer name",
          },
          client_id: {
            type: "number",
            description: "Limit search to a specific client",
          },
          limit: {
            type: "number",
            description: "Maximum number of results (default: 50)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "cwautomate_computers_reboot",
      description: "Send a restart command to a computer",
      inputSchema: {
        type: "object" as const,
        properties: {
          computer_id: {
            type: "number",
            description: "The computer ID to reboot",
          },
          force: {
            type: "boolean",
            description: "Force reboot even if users are logged in",
          },
        },
        required: ["computer_id"],
      },
    },
    {
      name: "cwautomate_computers_run_script",
      description: "Run a script on a specific computer",
      inputSchema: {
        type: "object" as const,
        properties: {
          computer_id: {
            type: "number",
            description: "The computer ID to run the script on",
          },
          script_id: {
            type: "number",
            description: "The script ID to execute",
          },
          parameters: {
            type: "object",
            description: "Script parameters as key-value pairs",
            additionalProperties: { type: "string" },
          },
        },
        required: ["computer_id", "script_id"],
      },
    },
  ];
}

/**
 * Handle a computer domain tool call
 */
async function handleCall(
  toolName: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const client = await getClient();

  switch (toolName) {
    case "cwautomate_computers_list": {
      let clientId = args.client_id as number | undefined;
      const locationId = args.location_id as number | undefined;
      const status = args.status as "online" | "offline" | "all" | undefined;
      const limit = (args.limit as number) || 50;
      const skip = (args.skip as number) || 0;

      // If no filters provided, ask the user if they want to narrow by client or location
      if (!clientId && !locationId && !status) {
        const filterValue = await elicitText(
          "Listing all computers can return a large result set. Would you like to filter by a client ID? Leave blank to list all.",
          "client_id",
          "Enter a client ID to filter by, or leave blank for all computers"
        );
        if (filterValue && !isNaN(Number(filterValue))) {
          clientId = Number(filterValue);
        }
      }

      const params: ComputerListParams = {
        clientId,
        locationId,
        pageSize: limit,
        page: toPage(skip, limit),
      };
      // Map the friendly status filter onto the library's online-state params.
      if (status === "online") {
        params.isOnline = true;
      } else if (status === "offline") {
        params.isOnline = false;
      } else if (status === "all") {
        params.includeOffline = true;
      }

      const response = await client.computers.list(params);

      return listResult("computers", response);
    }

    case "cwautomate_computers_get": {
      const computerId = args.computer_id as number;
      const computer = await client.computers.get(computerId);

      // MCP Apps: attach the normalized card payload the ui:// device card
      // renders from. Best-effort — any failure just means no UI surface,
      // never a failed tool result.
      const payload: Record<string, unknown> = { ...computer };
      try {
        const card = await buildDeviceCard(payload, client);
        if (card) payload._card = card;
      } catch {
        // Card building is progressive enhancement only.
      }

      return jsonResult(payload);
    }

    case "cwautomate_computers_search": {
      const query = args.query as string;
      const limit = (args.limit as number) || 50;
      const clientId = args.client_id as number | undefined;

      // The library has no dedicated search endpoint; use a name condition.
      const response = await client.computers.list({
        condition: `ComputerName like '%${escapeConditionValue(query)}%'`,
        clientId,
        pageSize: limit,
      });

      return listResult("computers", response);
    }

    case "cwautomate_computers_reboot": {
      const computerId = args.computer_id as number;
      const force = args.force as boolean | undefined;
      await client.computers.restart(computerId, force);

      return jsonResult({
        success: true,
        message: `Reboot command sent to computer ${computerId}`,
      });
    }

    case "cwautomate_computers_run_script": {
      const computerId = args.computer_id as number;
      const scriptId = args.script_id as number;
      const parameters = args.parameters as Record<string, string> | undefined;
      const result = await client.scripts.execute({
        ScriptId: scriptId,
        ComputerIds: [computerId],
        Parameters: parameters,
      });

      return jsonResult({
        success: true,
        message: `Script ${scriptId} queued for execution on computer ${computerId}`,
        result,
      });
    }

    default:
      return {
        content: [
          { type: "text", text: `Unknown computer tool: ${toolName}` },
        ],
        isError: true,
      };
  }
}

export const computersHandler: DomainHandler = {
  getTools,
  handleCall,
};
