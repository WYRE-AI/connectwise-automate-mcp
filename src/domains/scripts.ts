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
import { DEFAULT_WAIT_SECONDS } from "../utils/constants.js";

/**
 * Convert the tool's key/value parameter object into the Key/Value pair array
 * the batch script endpoint expects.
 */
function toParameterPairs(
  parameters?: Record<string, string>
): { Key: string; Value: string }[] | undefined {
  if (!parameters) return undefined;
  return Object.entries(parameters).map(([Key, Value]) => ({ Key, Value }));
}

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
        "Run a script on one or more computers and wait for the result. " +
        "Automate has no synchronous run, so this schedules the script and " +
        "polls its history until it finishes, returning the per-computer " +
        "outcome and any diagnostic message. Use the computers domain to find " +
        "computer IDs first.",
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
          wait: {
            type: "boolean",
            description:
              "Wait for the run to finish (default: true). Set false to " +
              "schedule and return immediately without an outcome.",
          },
          timeout_seconds: {
            type: "number",
            description:
              `How long to wait for completion before returning a partial ` +
              `result (default: ${DEFAULT_WAIT_SECONDS}). The script keeps ` +
              `running server-side either way.`,
          },
          skip_offline: {
            type: "boolean",
            description:
              "Skip the run entirely if the agent is offline at fire time",
          },
          wake_offline: {
            type: "boolean",
            description: "Send a Wake-on-LAN first if the agent is offline",
          },
        },
        required: ["script_id", "computer_ids"],
      },
    },
    {
      name: "cwautomate_scripts_history",
      description:
        "Get completed script-run history for a computer, including the " +
        "pass/fail state and Automate's diagnostic message. Use this to pick " +
        "up the result of a run that was scheduled without waiting, or that " +
        "outlasted its wait timeout.",
      inputSchema: {
        type: "object" as const,
        properties: {
          computer_id: {
            type: "number",
            description: "The computer ID to read script history for",
          },
          limit: {
            type: "number",
            description: "Maximum number of results (default: 50)",
          },
        },
        required: ["computer_id"],
      },
    },
    {
      name: "cwautomate_scripts_running",
      description: "List scripts currently running on a computer",
      inputSchema: {
        type: "object" as const,
        properties: {
          computer_id: {
            type: "number",
            description: "The computer ID to check",
          },
        },
        required: ["computer_id"],
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
      const priority = args.priority as "low" | "normal" | "high" | undefined;
      const wait = (args.wait as boolean | undefined) ?? true;
      const timeoutMs =
        ((args.timeout_seconds as number | undefined) ?? DEFAULT_WAIT_SECONDS) *
        1000;

      const request = {
        ScriptId: scriptId,
        Parameters: toParameterPairs(
          args.parameters as Record<string, string> | undefined
        ),
        Priority: toPriority(priority),
        OfflineActionFlags: {
          SkipsOfflineAgents: args.skip_offline as boolean | undefined,
          WakesOfflineAgents: args.wake_offline as boolean | undefined,
        },
      };

      if (!wait) {
        const batch = await client.scripts.executeBatch({
          ...request,
          EntityIds: computerIds,
        });

        return jsonResult({
          script_id: scriptId,
          waited: false,
          message:
            "Script launched. Use cwautomate_scripts_history to read the outcome.",
          launch_results: batch.ScriptResults,
          contains_unsuccessful_results: batch.ContainsUnsuccessfulResults,
        });
      }

      const results = await client.scripts.runAndWait(computerIds, request, {
        timeoutMs,
      });

      const runs = results.map((result) => ({
        computer_id: result.computerId,
        launched: result.launched,
        launch_message: result.launchMessage,
        completed: result.completed,
        state: result.state,
        diagnostic_message: result.diagnosticMessage,
        waited_seconds: Math.round(result.waitedMs / 1000),
      }));

      const succeeded = runs.filter((r) => r.state === "Success").length;
      const failed = runs.filter(
        (r) => !r.launched || r.state === "Failure"
      ).length;
      const pending = runs.filter((r) => r.launched && !r.completed).length;

      return jsonResult({
        script_id: scriptId,
        summary:
          `${runs.length} target(s): ${succeeded} succeeded, ${failed} failed, ` +
          `${pending} still running after ${timeoutMs / 1000}s`,
        runs,
      });
    }

    case "cwautomate_scripts_history": {
      const computerId = args.computer_id as number;
      const limit = (args.limit as number) || 50;
      const history = await client.scripts.historyForComputer(computerId, {
        pageSize: limit,
      });

      return listResult("history", history);
    }

    case "cwautomate_scripts_running": {
      const computerId = args.computer_id as number;
      const running = await client.scripts.runningOnComputer(computerId);

      return listResult("running", running);
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
