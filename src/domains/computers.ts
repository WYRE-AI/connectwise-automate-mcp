/**
 * Computers domain handler
 *
 * Provides tools for computer operations in ConnectWise Automate.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type {
  CommandRunResult,
  ComputerListParams,
} from "@wyre-ai/node-connectwise-automate";
import type { DomainHandler, CallToolResult } from "../utils/types.js";
import { getClient, type CWAutomateCredentials } from "../utils/client.js";
import { elicitText } from "../utils/elicitation.js";
import { toPage } from "../utils/pagination.js";
import { jsonResult, listResult } from "../utils/results.js";
import {
  clampWaitSeconds,
  DEFAULT_COMMAND_WAIT_SECONDS,
  DEFAULT_WAIT_SECONDS,
} from "../utils/constants.js";
import { buildDeviceCard, DEVICE_CARD_META } from "../card.builder.js";
import { escapeConditionValue } from "../utils/odata.js";
import {
  ConnectWiseAutomateAmbiguousRequestError,
  isDroppedConnection,
  isDuplicateCommandError,
} from "../utils/network-errors.js";
import {
  describeScriptExecuteRequest,
  logScriptExecuteServerError,
  logToolFailure,
} from "../utils/log.js";

/**
 * Every result carries the launch execution id for later reads. Unfinished
 * results also include poll_errors: reads that failed after SDK GET retries.
 */
function unfinishedCommand(result: CommandRunResult): {
  execution_id: number | undefined;
  poll_errors?: number;
} {
  if (result.completed) return { execution_id: result.execution.Id };
  return {
    execution_id: result.execution.Id,
    poll_errors: result.pollErrors ?? 0,
  };
}

// The SDK keeps isTerminalCommandStatus private; mirror its case-insensitive check.
function isTerminalCommandStatus(status: string | undefined): boolean {
  return ["success", "failed", "terminated"].includes(status?.toLowerCase() ?? "");
}

// Queue results include queued, completed, execution_id, status and optional output.
// Wait results additionally retain waited_seconds and poll_errors when unfinished.
function queuedCommand(execution: { Id?: number; Status?: string; Output?: string }) {
  return {
    queued: true,
    completed: isTerminalCommandStatus(execution.Status),
    execution_id: execution.Id,
    status: execution.Status,
    ...(execution.Output !== undefined ? { output: execution.Output } : {}),
    message: "Command queued. Automate runs it on the agent's next check-in. Poll cwautomate_computers_command_status with computer_id and execution_id for the result. Do not issue it again.",
  };
}

function duplicateCommandResult(toolName: string, error: unknown, computerId: number, commandId: string) {
  logToolFailure(toolName, error, "Automate reports this command is already pending on the computer; not re-issued");
  return jsonResult({
    queued: false, already_queued: true, computer_id: computerId, command_id: commandId,
    message: "Automate reports this command is already queued/pending for this computer (HTTP 400 'Duplicate command'). It was not issued again. Do not re-issue it: check cwautomate_computers_command_status (with the execution_id from the first call) or the computer's command history in Automate and wait for the agent to pick it up.",
  });
}

/**
 * Prefer the client's ambiguous-request message (it already says the call
 * was not retried) and keep the tool-specific "check before assuming it
 * failed" guidance after it.
 */
function droppedConnectionMessage(error: unknown, guidance: string): string {
  if (error instanceof ConnectWiseAutomateAmbiguousRequestError) {
    return `${error.message} ${guidance}`;
  }
  return guidance;
}

function droppedExecutionId(
  error: unknown
): { execution_id: number | string } | Record<string, never> {
  if (
    error instanceof ConnectWiseAutomateAmbiguousRequestError &&
    error.id !== undefined
  ) {
    return { execution_id: error.id };
  }
  return {};
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
      description:
        "Queue a reboot and return immediately by default with execution_id. Poll cwautomate_computers_command_status; never re-issue on a timeout or a Duplicate command result. Automate has " +
        "no dedicated restart route: the reboot is issued as a catalog " +
        "command (POST /Computers/{id}/CommandExecute). By default the " +
        "first catalog entry named like 'Reboot' or 'Restart' is used; pass " +
        "command_id (from cwautomate_commands_list) to choose a specific " +
        "one. The API user's command level caps which commands may be issued. " +
        "A result with completed: false includes execution_id and poll_errors " +
        "so the queued reboot can be re-read instead of issued again.",
      inputSchema: {
        type: "object" as const,
        properties: {
          wait_seconds: {
            type: "number", minimum: 0, maximum: 20, default: 0,
            description: "Wait for completion (default 0, max 20 seconds). Zero queues and returns immediately. Takes precedence over legacy timeout_seconds where supported.",
          },
          computer_id: {
            type: "number",
            description: "The computer ID to reboot",
          },
          command_id: {
            type: "string",
            description:
              "Catalog command ID to issue instead of auto-selecting the " +
              "reboot command, from cwautomate_commands_list",
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
          timeout_seconds: {
            type: "number",
            description: "Completion wait (default 20, max 20 seconds). Still-running scripts continue; read cwautomate_scripts_history, do NOT launch again.",
          },
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
    {
      name: "cwautomate_computers_command_status",
      description: "Read a queued command execution without re-issuing it.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        type: "object",
        properties: {
          computer_id: { type: "number", description: "The computer ID" },
          execution_id: { type: "number", description: "The execution ID returned at launch" },
        },
        required: ["computer_id", "execution_id"],
      },
    },
    {
      name: "cwautomate_commands_list",
      description:
        "List the Automate command catalog. Commands are a fixed, " +
        "server-defined set addressed by ID — call this to find the command " +
        "ID before using cwautomate_computers_run_command.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "cwautomate_computers_run_command",
      description:
        "Queue a catalog command and return immediately by default with execution_id. Poll cwautomate_computers_command_status; never re-issue on a timeout or a Duplicate command result. " +
        "The command_id must come from cwautomate_commands_list; free-text " +
        "commands are not accepted by Automate. Note that the API user's " +
        "command level and the group-level 'Send Commands' grant silently " +
        "cap which commands may be issued. A result with completed: false " +
        "includes execution_id and poll_errors so that execution can be " +
        "re-read instead of issued again.",
      inputSchema: {
        type: "object" as const,
        properties: {
          wait_seconds: {
            type: "number", minimum: 0, maximum: 20, default: 0,
            description: "Wait for completion (default 0, max 20 seconds). Zero queues and returns immediately. Takes precedence over legacy timeout_seconds where supported.",
          },
          computer_id: {
            type: "number",
            description: "The computer ID to send the command to",
          },
          command_id: {
            type: "string",
            description:
              "The catalog command ID, from cwautomate_commands_list",
          },
          parameters: {
            type: "array",
            items: { type: "string" },
            description:
              "Positional parameters for the command, in the order the " +
              "command expects them",
          },
          timeout_seconds: {
            type: "number",
            description:
              `How long to wait for the command to finish before returning ` +
              `a partial result (legacy alias for wait_seconds; default 0, max 20; wait_seconds wins)`,
          },
        },
        required: ["computer_id", "command_id"],
      },
    },
  ];
}

/**
 * Handle a computer domain tool call
 */
async function handleCall(
  toolName: string,
  args: Record<string, unknown>,
  creds?: CWAutomateCredentials
): Promise<CallToolResult> {
  const client = await getClient(creds);

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
      // Map the friendly status filter onto the library's online-state
      // param; "all" (or unset) means no filter.
      if (status === "online") {
        params.isOnline = true;
      } else if (status === "offline") {
        params.isOnline = false;
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
      let commandId = args.command_id ? String(args.command_id) : undefined;
      let commandName: string | undefined;

      // Automate has no restart route; a reboot is whatever the instance's
      // command catalog calls it. Resolve it unless the caller chose one.
      if (!commandId) {
        const catalog = await client.computers.commands();
        const reboot = catalog.find((c) => /reboot|restart/i.test(c.Name ?? ""));
        if (!reboot?.Id) {
          const names = catalog.map((c) => c.Name).filter(Boolean).join(", ");
          return {
            content: [
              {
                type: "text",
                text:
                  "No reboot/restart command found in this instance's " +
                  "command catalog. Pass command_id explicitly. Available " +
                  `commands: ${names || "(none)"}`,
              },
            ],
            isError: true,
          };
        }
        commandId = reboot.Id;
        commandName = reboot.Name;
      }

      const timeoutSeconds = clampWaitSeconds(args.wait_seconds, DEFAULT_COMMAND_WAIT_SECONDS);
      let result;
      try {
        if (timeoutSeconds === 0) {
          const execution = await client.computers.executeCommand(computerId, {
            Command: { Id: commandId },
            Parameters: [],
          });
          return jsonResult({
            computer_id: computerId, command_id: commandId,
            ...(commandName !== undefined ? { command_name: commandName } : {}),
            ...queuedCommand(execution),
          });
        }
        result = await client.computers.executeCommandAndWait(
          computerId,
          { Command: { Id: commandId }, Parameters: [] },
          { timeoutMs: timeoutSeconds * 1000 }
        );
      } catch (error) {
        if (isDuplicateCommandError(error)) {
          return duplicateCommandResult(toolName, error, computerId, commandId);
        }
        // The launch POST is not retried: a socket error means the reboot
        // may already be queued. Status-poll drops come back as
        // completed:false with the execution id, not as a throw.
        if (!isDroppedConnection(error)) throw error;
        logToolFailure(
          "cwautomate_computers_reboot",
          error,
          "connection to ConnectWise Automate terminated while issuing the " +
            "command or polling for its result"
        );
        return jsonResult({
          computer_id: computerId,
          command_id: commandId,
          command_name: commandName,
          completed: false,
          ...droppedExecutionId(error),
          message: droppedConnectionMessage(
            error,
            "Connection to ConnectWise Automate was interrupted while " +
              "waiting for the result. The reboot may still have been queued " +
              "— check the computer's status with cwautomate_computers_get " +
              "rather than assuming it failed."
          ),
        });
      }

      return jsonResult({
        computer_id: computerId,
        command_id: commandId,
        command_name: commandName,
        queued: true,
        completed: result.completed,
        status: result.status,
        output: result.output,
        waited_seconds: Math.round(result.waitedMs / 1000),
        ...unfinishedCommand(result),
      });
    }

    case "cwautomate_computers_run_script": {
      const computerId = args.computer_id as number;
      const scriptId = args.script_id as number;
      const parameters = args.parameters as Record<string, string> | undefined;

      const request = {
        ScriptId: scriptId,
        Parameters: parameters
          ? Object.entries(parameters).map(([Key, Value]) => ({ Key, Value }))
          : undefined,
      };
      let result;
      try {
        [result] = await client.scripts.runAndWait(
          [computerId],
          request,
          { timeoutMs: clampWaitSeconds(args.timeout_seconds, DEFAULT_WAIT_SECONDS) * 1000 }
        );
      } catch (error) {
        logScriptExecuteServerError(error, describeScriptExecuteRequest({ ...request, EntityIds: [computerId] }));
        // runAndWait launches the script and then polls for its result over
        // several requests. If a transient network failure hits mid-poll,
        // we genuinely don't know whether the script already launched —
        // retrying could run it a second time, so report that honestly
        // instead of guessing either way. See network-errors.ts for what this
        // failure looks like and why it happens.
        if (!isDroppedConnection(error)) throw error;
        logToolFailure(
          "cwautomate_computers_run_script",
          error,
          "connection to ConnectWise Automate terminated while launching " +
            "the script or polling for its result"
        );
        return jsonResult({
          computer_id: computerId,
          script_id: scriptId,
          completed: false,
          message: droppedConnectionMessage(
            error,
            "Connection to ConnectWise Automate was interrupted while " +
              "waiting for the result. The script may still have launched " +
              "— check cwautomate_scripts_history for this computer rather " +
              "than assuming it failed."
          ),
        });
      }

      return jsonResult({
        computer_id: computerId,
        script_id: scriptId,
        launched: result?.launched,
        launch_message: result?.launchMessage,
        completed: result?.completed,
        state: result?.state,
        diagnostic_message: result?.diagnosticMessage,
        waited_seconds: Math.round((result?.waitedMs ?? 0) / 1000),
      });
    }

    case "cwautomate_computers_command_status": {
      const computerId = Number(args.computer_id);
      const executionId = Number(args.execution_id);
      const rows = await client.computers.commandExecutions(computerId, { ids: String(executionId) });
      const execution = rows.find((row) => Number(row.Id) === executionId);
      if (!execution) return jsonResult({ computer_id: computerId, execution_id: executionId, found: false, message: "No command execution with that id on this computer." });
      return jsonResult({
        computer_id: computerId, execution_id: executionId, found: true,
        completed: isTerminalCommandStatus(execution.Status),
        status: execution.Status, output: execution.Output, command: execution.Command,
        execution,
      });
    }

    case "cwautomate_commands_list": {
      const commands = await client.computers.commands();

      return listResult("commands", commands);
    }

    case "cwautomate_computers_run_command": {
      const computerId = args.computer_id as number;
      const commandId = String(args.command_id);
      const timeoutSeconds =
        clampWaitSeconds(args.wait_seconds ?? args.timeout_seconds, DEFAULT_COMMAND_WAIT_SECONDS);

      let result;
      try {
        if (timeoutSeconds === 0) {
          const execution = await client.computers.executeCommand(computerId, {
            Command: { Id: commandId },
            Parameters: (args.parameters as string[] | undefined) ?? [],
          });
          return jsonResult({
            computer_id: computerId, command_id: commandId,
            ...queuedCommand(execution),
          });
        }
        result = await client.computers.executeCommandAndWait(
          computerId,
          {
            Command: { Id: commandId },
            Parameters: (args.parameters as string[] | undefined) ?? [],
          },
          { timeoutMs: timeoutSeconds * 1000 }
        );
      } catch (error) {
        if (isDuplicateCommandError(error)) {
          return duplicateCommandResult(toolName, error, computerId, commandId);
        }
        // The launch POST is not retried: a socket error means the command
        // may already be queued. Status-poll drops come back as
        // completed:false with the execution id, not as a throw.
        if (!isDroppedConnection(error)) throw error;
        logToolFailure(
          "cwautomate_computers_run_command",
          error,
          "connection to ConnectWise Automate terminated while issuing the " +
            "command or polling for its result"
        );
        return jsonResult({
          computer_id: computerId,
          command_id: commandId,
          completed: false,
          ...droppedExecutionId(error),
          message: droppedConnectionMessage(
            error,
            "Connection to ConnectWise Automate was interrupted while " +
              "waiting for the result. The command may still have been " +
              "issued — check the computer's command history in Automate " +
              "rather than assuming it failed."
          ),
        });
      }

      return jsonResult({
        computer_id: computerId,
        command_id: commandId,
        queued: true,
        completed: result.completed,
        status: result.status,
        output: result.output,
        waited_seconds: Math.round(result.waitedMs / 1000),
        ...unfinishedCommand(result),
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
