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
import { clampWaitSeconds, DEFAULT_WAIT_SECONDS } from "../utils/constants.js";
import {
  andConditions,
  containsCondition,
  equalsCondition,
} from "../utils/odata.js";
import {
  ConnectWiseAutomateAmbiguousRequestError,
  isDroppedConnection,
} from "../utils/network-errors.js";
import {
  describeScriptExecuteRequest,
  logScriptExecuteServerError,
  logToolFailure,
} from "../utils/log.js";
import {
  automateMessage,
  buildScriptExecuteBatchBody,
  isAutomateApiError,
  LAUNCH_REJECTED_LOG,
  LAUNCH_REJECTED_MESSAGE,
  POLL_FAILED_MESSAGE,
  runScriptsAndWait,
  ScriptWaitError,
} from "../utils/script-execute.js";

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
      description:
        "Get a script's catalog metadata by ID: its Name, Folder, Comments, " +
        "the Is*Script kind flags, and the list of Parameters it accepts " +
        "(useful before cwautomate_scripts_execute). Note the script's Id " +
        "is a string in this response.",
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
        "computer IDs first. The launch body is a full ScheduleScriptBatchRequest " +
        "(StartDate now, once/run-now schedule, explicit offline flags, priority " +
        "default normal=2).",
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
            description: "Execution priority (default: normal). Mapped to Automate as high=1, normal=2, low=3.",
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
              `result (default: ${DEFAULT_WAIT_SECONDS}, max 20 seconds). Read cwautomate_scripts_history for a still-running run; do NOT launch again. The script keeps ` +
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

      // Automate's list routes only filter through the generic `condition`
      // expression; a `?name=` or `?folderId=` query param is silently
      // ignored and every script comes back unfiltered. `Folder.Id = N`
      // mirrors the nested-ref form the API accepts for `Client.Id` on
      // computers, but is unverified against a live instance.
      const response = await client.scripts.list({
        condition: andConditions(
          equalsCondition("Folder.Id", args.folder_id as number | undefined),
          containsCondition("Name", args.search as string | undefined)
        ),
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
        clampWaitSeconds(args.timeout_seconds, DEFAULT_WAIT_SECONDS) *
        1000;

      const request = buildScriptExecuteBatchBody({
        scriptId,
        computerIds,
        parameters: args.parameters as Record<string, string> | undefined,
        priority,
        skipOffline: args.skip_offline as boolean | undefined,
        wakeOffline: args.wake_offline as boolean | undefined,
      });

      if (!wait) {
        // POST /Batch/ScriptExecute is not idempotent. The client already
        // refuses to retry POST; retrying here can run the script twice when
        // the first request reached Automate and only the response was lost.
        let batch;
        try {
          batch = await client.scripts.executeBatch({
            ...request,
            EntityIds: computerIds,
          });
        } catch (error) {
        logScriptExecuteServerError(
            error,
            describeScriptExecuteRequest({ ...request, EntityIds: computerIds })
          );
          if (isAutomateApiError(error)) {
            logToolFailure(
              "cwautomate_scripts_execute",
              error,
              LAUNCH_REJECTED_LOG
            );
            return {
              ...jsonResult({
                script_id: scriptId,
              computer_ids: computerIds,
                launched: false,
                status_code: error.statusCode,
                automate_message: automateMessage(error),
                message: LAUNCH_REJECTED_MESSAGE,
              }),
              isError: true,
            };
          }
          if (!isDroppedConnection(error)) throw error;
          logToolFailure(
            "cwautomate_scripts_execute",
            error,
            "connection to ConnectWise Automate terminated while launching " +
              "the script; the launch was not retried"
          );
          const ambiguous =
            error instanceof ConnectWiseAutomateAmbiguousRequestError
              ? error
              : undefined;
          return jsonResult({
            script_id: scriptId,
            computer_ids: computerIds,
            waited: false,
            completed: false,
            interrupted: true,
            ambiguous: true,
            ...(ambiguous?.id !== undefined
              ? { execution_id: ambiguous.id }
              : {}),
            message: ambiguous
              ? `${ambiguous.message} Check cwautomate_scripts_history for each computer before launching again.`
              : "Connection to ConnectWise Automate was interrupted while " +
                "launching the script. It may or may not have been queued. " +
                "The request was not retried because a retry can run it " +
                "twice. Check cwautomate_scripts_history for each computer " +
                "before launching again.",
          });
        }

        return jsonResult({
          script_id: scriptId,
          waited: false,
          message:
            "Script launched. Use cwautomate_scripts_history to read the outcome.",
          launch_results: batch.ScriptResults,
          contains_unsuccessful_results: batch.ContainsUnsuccessfulResults,
        });
      }

      let results;
      try {
        results = await runScriptsAndWait(client.scripts, request, {
          timeoutMs,
        });
      } catch (error) {
        const phase = error instanceof ScriptWaitError ? error.phase : "launch";
        const cause = error instanceof ScriptWaitError ? error.cause : error;
        logScriptExecuteServerError(
          cause,
          describeScriptExecuteRequest({ ...request, EntityIds: computerIds })
        );
        // Phase is tracked so a history-poll HTTP error after a successful
        // launch POST is not reported as launched:false (a caller might
        // relaunch while the first run continues).
        if (
          (phase === "launch" || phase === "baseline") &&
          isAutomateApiError(cause)
        ) {
          logToolFailure(
            "cwautomate_scripts_execute",
            cause,
            LAUNCH_REJECTED_LOG
          );
          return {
            ...jsonResult({
              script_id: scriptId,
          computer_ids: computerIds,
              launched: false,
              status_code: cause.statusCode,
              automate_message: automateMessage(cause),
              message: LAUNCH_REJECTED_MESSAGE,
            }),
            isError: true,
          };
        }
        if (phase === "poll" && isAutomateApiError(cause)) {
          logToolFailure(
            "cwautomate_scripts_execute",
            cause,
            "script history poll failed after launch; this tool made no further launch attempt"
          );
          return {
            ...jsonResult({
              script_id: scriptId,
              computer_ids: computerIds,
              launched: true,
              completed: false,
              status_code: cause.statusCode,
              automate_message: automateMessage(cause),
              message: POLL_FAILED_MESSAGE,
            }),
            isError: true,
          };
        }
        if (!isDroppedConnection(cause)) throw cause;
        logToolFailure(
          "cwautomate_scripts_execute",
          cause,
          "connection to ConnectWise Automate terminated while launching " +
            "the script or polling for its result"
        );
        const guidance =
          phase === "baseline"
            ? `Connection to ConnectWise Automate was interrupted before ` +
              `the script was launched. This tool made no launch attempt. ` +
              `Check cwautomate_scripts_history if you need to confirm nothing started.`
            : `Connection to ConnectWise Automate was interrupted while ` +
              `waiting for ${computerIds.length} target(s). The script may ` +
              `still have launched — check cwautomate_scripts_history for ` +
              `each computer rather than assuming it failed.`;
        return jsonResult({
          script_id: scriptId,
          summary:
            cause instanceof ConnectWiseAutomateAmbiguousRequestError
              ? `${cause.message} ${guidance}`
              : guidance,
          computer_ids: computerIds,
        });
      }

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
