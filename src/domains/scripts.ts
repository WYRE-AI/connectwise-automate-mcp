/**
 * Scripts domain handler
 *
 * Provides tools for script operations in ConnectWise Automate.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { DomainHandler, CallToolResult } from "../utils/types.js";
import { getClient, type CWAutomateCredentials } from "../utils/client.js";
import { toPage } from "../utils/pagination.js";
import { jsonResult, listResult } from "../utils/results.js";

/**
 * Map the friendly priority name to the library's numeric priority
 * (1 = high, 2 = normal, 3 = low).
 */
function toPriority(
  priority?: "low" | "normal" | "high"
): number | undefined {
  switch (priority) {
    case "high":
      return 1;
    case "normal":
      return 2;
    case "low":
      return 3;
    default:
      return undefined;
  }
}

/**
 * Get script domain tools
 */
function getTools(): Tool[] {
  return [
    {
      name: "cwautomate_scripts_list",
      description:
        "List available scripts in ConnectWise Automate with optional filtering.",
      inputSchema: {
        type: "object" as const,
        properties: {
          folder_id: {
            type: "number",
            description: "Filter scripts by folder ID",
          },
          search: {
            type: "string",
            description: "Search scripts by name",
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
      name: "cwautomate_scripts_get",
      description: "Get details for a specific script by ID",
      inputSchema: {
        type: "object" as const,
        properties: {
          script_id: {
            type: "number",
            description: "The script ID",
          },
        },
        required: ["script_id"],
      },
    },
    {
      name: "cwautomate_scripts_execute",
      description:
        "Execute a script on one or more computers. Use the computers domain to find specific computer IDs first.",
      inputSchema: {
        type: "object" as const,
        properties: {
          script_id: {
            type: "number",
            description: "The script ID to execute",
          },
          computer_ids: {
            type: "array",
            items: { type: "number" },
            description: "Array of computer IDs to run the script on",
          },
          parameters: {
            type: "object",
            description: "Script parameters as key-value pairs",
            additionalProperties: { type: "string" },
          },
          priority: {
            type: "string",
            enum: ["low", "normal", "high"],
            description: "Execution priority (default: normal)",
          },
        },
        required: ["script_id", "computer_ids"],
      },
    },
  ];
}

/**
 * Handle a script domain tool call
 */
async function handleCall(
  toolName: string,
  args: Record<string, unknown>,
  creds?: CWAutomateCredentials
): Promise<CallToolResult> {
  const client = await getClient(creds);

  switch (toolName) {
    case "cwautomate_scripts_list": {
      const limit = (args.limit as number) || 50;
      const skip = (args.skip as number) || 0;
      const response = await client.scripts.list({
        folderId: args.folder_id as number | undefined,
        name: args.search as string | undefined,
        pageSize: limit,
        page: toPage(skip, limit),
      });

      return listResult("scripts", response);
    }

    case "cwautomate_scripts_get": {
      const scriptId = args.script_id as number;
      const script = await client.scripts.get(scriptId);

      return jsonResult(script);
    }

    case "cwautomate_scripts_execute": {
      const scriptId = args.script_id as number;
      const computerIds = (args.computer_ids as number[] | undefined) ?? [];
      const parameters = args.parameters as Record<string, string> | undefined;
      const priority = args.priority as "low" | "normal" | "high" | undefined;

      const result = await client.scripts.execute({
        ScriptId: scriptId,
        ComputerIds: computerIds,
        Parameters: parameters,
        Priority: toPriority(priority),
      });

      return jsonResult({
        success: true,
        message: `Script ${scriptId} queued for execution on ${computerIds.length} computer(s)`,
        result,
      });
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown script tool: ${toolName}` }],
        isError: true,
      };
  }
}

export const scriptsHandler: DomainHandler = {
  getTools,
  handleCall,
};
