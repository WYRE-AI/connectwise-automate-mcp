/**
 * Shared ScheduleScriptBatchRequest builder for both script launch tools.
 *
 * Field names match the official Automate swagger
 * (`Automate.Api.Domain.Contracts.BatchScripts.ScheduleScriptBatchRequest`).
 * Mirrors `@wyre-ai/node-connectwise-automate` `buildScriptExecuteBatchBody`
 * (node-connectwise-automate#113 successor). The current SDK still spreads
 * the request into POST /Batch/ScriptExecute, so these explicit fields go
 * out even before the MCP bumps to that SDK release.
 *
 * Prod logs (EpiOn / Corey, org mYRJKLjH-O0LwrClIqOwf): a sparse body
 * caused Automate HTTP 500 "Encountered unhandled exception."
 *   - cwautomate_scripts_execute: keys EntityIds, EntityType,
 *     OfflineActionFlags, ScriptId; OfflineActionFlags {}; no StartDate or
 *     Schedule (2026-11-10 2:16 PM PT script 363; 2026-11-11 9:37 AM PT
 *     scripts 363 and 3007).
 *   - cwautomate_computers_run_script: keys EntityIds, EntityType, ScriptId
 *     only (2026-11-11 9:37 AM PT script 3007).
 */

export const DEFAULT_SCRIPT_PRIORITY = 2;
export const SCRIPT_SCHEDULE_FREQUENCY_ONCE = 1;

export type ScriptPriorityName = "low" | "normal" | "high";

/** MCP high=1, normal=2, low=3. Omitted or unknown maps to normal (2). */
export function toPriority(priority?: ScriptPriorityName): number {
  switch (priority) {
    case "high":
      return 1;
    case "low":
      return 3;
    default:
      return DEFAULT_SCRIPT_PRIORITY;
  }
}

export function toParameterPairs(
  parameters?: Record<string, string>
): { Key: string; Value: string }[] {
  if (!parameters) return [];
  return Object.entries(parameters).map(([Key, Value]) => ({ Key, Value }));
}

export interface ScriptExecuteToolInput {
  scriptId: number;
  computerIds: number[];
  parameters?: Record<string, string>;
  priority?: ScriptPriorityName;
  skipOffline?: boolean;
  wakeOffline?: boolean;
  now?: Date;
}

export interface ScriptExecuteBatchBody {
  EntityType: "Computer";
  EntityIds: number[];
  ScriptId: number;
  Parameters: { Key: string; Value: string }[];
  Priority: number;
  OfflineActionFlags: {
    SkipsOfflineAgents: boolean;
    WakesOfflineAgents: boolean;
    OnlyRunsOnOfflineAgents: boolean;
  };
  UseAgentTime: boolean;
  StartDate: string;
  Schedule: { ScriptScheduleFrequency: { ScriptScheduleFrequencyId: number } };
}

/** Build the full request both tools pass to executeBatch / runAndWait. */
export function buildScriptExecuteBatchBody(
  input: ScriptExecuteToolInput
): ScriptExecuteBatchBody {
  const now = input.now ?? new Date();
  return {
    EntityType: "Computer",
    EntityIds: input.computerIds,
    ScriptId: input.scriptId,
    Parameters: toParameterPairs(input.parameters),
    Priority: toPriority(input.priority),
    OfflineActionFlags: {
      SkipsOfflineAgents: input.skipOffline ?? false,
      WakesOfflineAgents: input.wakeOffline ?? false,
      OnlyRunsOnOfflineAgents: false,
    },
    UseAgentTime: false,
    StartDate: now.toISOString(),
    Schedule: {
      ScriptScheduleFrequency: {
        ScriptScheduleFrequencyId: SCRIPT_SCHEDULE_FREQUENCY_ONCE,
      },
    },
  };
}

/** Automate HTTP 4xx/5xx (not a dropped socket) — do not retry. */
export function isAutomateApiError(
  error: unknown
): error is { statusCode: number; message?: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof (error as { statusCode: unknown }).statusCode === "number" &&
    (error as { statusCode: number }).statusCode >= 400
  );
}

/** Cap Automate's message at 500 chars; only use the error's own message. */
export function automateMessage(error: { message?: string }): string | undefined {
  const message = error.message?.trim();
  return message ? message.slice(0, 500) : undefined;
}
