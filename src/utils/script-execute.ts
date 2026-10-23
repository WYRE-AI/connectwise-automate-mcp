// TODO(WYREAI-573): after @wyre-ai/node-connectwise-automate ships buildScriptExecuteBatchBody (node-connectwise-automate#113), bump the dependency/peerDependency and replace this mirror with the SDK export
import { ConnectWiseAutomateValidationError, type ScriptExecuteBatchRequest as SDKRequest } from "@wyre-ai/node-connectwise-automate";
import { jsonResult } from "./results.js";
import { isDroppedConnection } from "./network-errors.js";
import { logToolFailure } from "./log.js";

// SDK 4.0.1 lacks Schedule and DistributionWindow in its request type.
type ScriptExecuteBatchRequest = SDKRequest & {
  Schedule?: { ScriptScheduleFrequency: { ScriptScheduleFrequencyId: number } };
  DistributionWindow?: { DistributionWindowType?: { DistributionWindowTypeId?: number; Name?: string }; Amount?: number };
};

export const DEFAULT_SCRIPT_PRIORITY = 5;
export const SCRIPT_SCHEDULE_FREQUENCY_ONCE = 1;

/**
 * Build the explicit ScheduleScriptBatchRequest body. Field names come from
 * the official Batch swagger. The Priority scale, frequency id 1 meaning
 * "once / run now", and default flags mirror the Control Center "run now"
 * request and are PENDING verification against a captured Control Center
 * payload (WYREAI-573); they are not verified by the swagger.
 */
export function buildScriptExecuteBatchBody(
  request: ScriptExecuteBatchRequest,
  now: Date = new Date()
) {
  if (!Array.isArray(request.EntityIds) || request.EntityIds.length === 0 ||
      Array.from(request.EntityIds).some(id => !Number.isInteger(id) || id <= 0)) {
    throw new ConnectWiseAutomateValidationError('EntityIds must be a non-empty array of positive integers');
  }
  if ((request.ScriptId !== undefined) === (request.ScriptGuid !== undefined)) {
    throw new ConnectWiseAutomateValidationError('Exactly one of ScriptId or ScriptGuid is required');
  }
  return {
    EntityType: request.EntityType ?? 'Computer',
    EntityIds: request.EntityIds,
    ...(request.ScriptId !== undefined ? { ScriptId: request.ScriptId } : { ScriptGuid: request.ScriptGuid }),
    Parameters: request.Parameters ?? [],
    Priority: request.Priority ?? DEFAULT_SCRIPT_PRIORITY,
    OfflineActionFlags: {
      SkipsOfflineAgents: request.OfflineActionFlags?.SkipsOfflineAgents ?? false,
      WakesOfflineAgents: request.OfflineActionFlags?.WakesOfflineAgents ?? false,
      OnlyRunsOnOfflineAgents: request.OfflineActionFlags?.OnlyRunsOnOfflineAgents ?? false,
    },
    UseAgentTime: request.UseAgentTime ?? false,
    StartDate: request.StartDate ?? now.toISOString(),
    Schedule: request.Schedule ?? { ScriptScheduleFrequency: { ScriptScheduleFrequencyId: SCRIPT_SCHEDULE_FREQUENCY_ONCE } },
    ...(request.ExpireDate !== undefined && { ExpireDate: request.ExpireDate }),
    ...(request.DistributionWindow !== undefined && { DistributionWindow: request.DistributionWindow }),
    ...(request.IncludeSubGroups !== undefined && { IncludeSubGroups: request.IncludeSubGroups }),
  };
}

/** Explicit fields send the full body even on SDK 4.0.1, which spreads the request. */
export function scriptExecuteRequest(args: Record<string, unknown>, entityIds: number[], now?: Date) {
  // Preserve the existing friendly mapping; the Priority scale is pending
  // verification against a Control Center payload (WYREAI-573).
  const priority = args.priority === "high" ? 1 : args.priority === "normal" ? 2 : args.priority === "low" ? 3 : undefined;
  return buildScriptExecuteBatchBody({
    EntityIds: entityIds,
    ScriptId: args.script_id as number,
    Parameters: Object.entries((args.parameters as Record<string, string> | undefined) ?? {}).map(([Key, Value]) => ({ Key, Value })),
    Priority: priority,
    OfflineActionFlags: {
      SkipsOfflineAgents: (args.skip_offline as boolean | undefined) ?? false,
      WakesOfflineAgents: (args.wake_offline as boolean | undefined) ?? false,
      OnlyRunsOnOfflineAgents: false,
    },
  }, now);
}

/** Read only server-message fields, never serialize the raw error/response. */
function serverMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(serverMessage).filter(Boolean).join("; ") || undefined;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["Message", "message", "error_description", "ExceptionMessage", "Errors", "ModelState"]) {
      const field = record[key];
      const message = key === "ModelState" && field && typeof field === "object"
        ? serverMessage(Object.values(field)) : serverMessage(field);
      if (message) return message;
    }
  }
  return undefined;
}

export function scriptLaunchFailure(tool: string, error: unknown, ids: Record<string, unknown>) {
  if (isDroppedConnection(error) || !error || typeof error !== "object") return undefined;
  const api = error as { statusCode?: unknown; name?: string; message?: unknown; response?: unknown };
  if (typeof api.statusCode !== "number" && !/^ConnectWiseAutomate.*Error$/.test(api.name ?? "")) return undefined;
  const message = (serverMessage(api.response) ?? serverMessage(api.message) ?? "Automate rejected script").slice(0, 500);
  const hint = "The script launch was rejected by Automate and was not retried.";
  logToolFailure(tool, new Error(message), hint);
  return { ...jsonResult({ ...ids, launched: false, status_code: typeof api.statusCode === "number" ? api.statusCode : null, automate_message: message, hint }), isError: true };
}
