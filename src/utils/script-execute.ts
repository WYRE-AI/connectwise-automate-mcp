/**
 * Shared ScheduleScriptBatchRequest builder for both script launch tools.
 *
 * Field names match the official Automate swagger
 * (`Automate.Api.Domain.Contracts.BatchScripts.ScheduleScriptBatchRequest`).
 * Mirrors `@wyre-ai/node-connectwise-automate` `buildScriptExecuteBatchBody`
 * (node-connectwise-automate#114). The current SDK still spreads
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

import { isTransientNetworkError } from "./network-errors.js";

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

/** Build the full request both tools pass to executeBatch / runScriptsAndWait. */
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


/** Newest 100 history rows, same window the SDK uses in runAndWait. */
export const SCRIPT_HISTORY_WINDOW = {
  orderBy: "HistoryDate desc",
  pageSize: 100,
} as const;

export const DEFAULT_SCRIPT_POLL_INTERVAL_MS = 3_000;

export const LAUNCH_REJECTED_LOG =
  "rejected by Automate; this tool made no further launch attempt";

export const LAUNCH_REJECTED_MESSAGE =
  "Rejected by Automate. This tool made no further launch attempt. The script was not launched.";

export const POLL_FAILED_MESSAGE =
  "The script launch was accepted by Automate, but reading script history failed. Check cwautomate_scripts_history. Do not launch the script again.";

export type ScriptWaitPhase = "baseline" | "launch" | "poll";

/** Thrown when baseline, the launch POST, or a later history poll fails. */
export class ScriptWaitError extends Error {
  readonly phase: ScriptWaitPhase;
  readonly cause: unknown;

  constructor(phase: ScriptWaitPhase, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message);
    this.name = "ScriptWaitError";
    this.phase = phase;
    this.cause = cause;
  }
}

export interface ScriptHistoryEntry {
  Id?: number;
  ScriptId?: number;
  Status?: string;
  State?: string;
  DiagnosticMessage?: string;
}

export interface ScriptExecuteBatchResponse {
  ScriptResults?: Array<{
    EntityId?: number;
    ResultDetails?: { ResultStatus?: number; Message?: string };
  }>;
  ContainsUnsuccessfulResults?: boolean;
}

export interface ScriptLaunchClient {
  executeBatch: (request: ScriptExecuteBatchBody) => Promise<ScriptExecuteBatchResponse>;
  historyForComputer: (
    computerId: number,
    params?: { orderBy?: string; pageSize?: number }
  ) => Promise<ScriptHistoryEntry[]>;
}

export interface ScriptRunWaitResult {
  computerId: number;
  launched: boolean;
  launchMessage?: string;
  completed: boolean;
  state?: string;
  diagnosticMessage?: string;
  waitedMs: number;
  pollErrors: number;
}

export interface RunScriptsWaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  delay?: (ms: number) => Promise<void>;
}

const defaultDelay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Launch via executeBatch, then poll history. Tracks the phase so a poll
 * failure is not reported as a rejected launch (the POST may already have
 * been accepted). Transient network errors during a poll are retried until
 * the deadline, matching the SDK.
 */
export async function runScriptsAndWait(
  scripts: ScriptLaunchClient,
  request: ScriptExecuteBatchBody,
  options: RunScriptsWaitOptions = {}
): Promise<ScriptRunWaitResult[]> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs =
    options.pollIntervalMs ?? DEFAULT_SCRIPT_POLL_INTERVAL_MS;
  const delay = options.delay ?? defaultDelay;
  const computerIds = request.EntityIds;
  const recentHistory = (computerId: number) =>
    scripts.historyForComputer(computerId, SCRIPT_HISTORY_WINDOW);

  const baselines = new Map<number, Set<number | undefined>>();
  try {
    await Promise.all(
      computerIds.map(async (computerId) => {
        const history = await recentHistory(computerId);
        baselines.set(computerId, new Set(history.map((entry) => entry.Id)));
      })
    );
  } catch (error) {
    throw new ScriptWaitError("baseline", error);
  }

  let batch: ScriptExecuteBatchResponse;
  try {
    batch = await scripts.executeBatch(request);
  } catch (error) {
    throw new ScriptWaitError("launch", error);
  }

  const refusals = new Map(
    batch.ContainsUnsuccessfulResults
      ? (batch.ScriptResults ?? [])
          .filter((result) => (result.ResultDetails?.ResultStatus ?? 0) !== 0)
          .map((result) => [result.EntityId, result] as const)
      : []
  );

  const startedAt = Date.now();

  try {
    return await Promise.all(
      computerIds.map(async (computerId) => {
        const refusal = refusals.get(computerId);
        if (refusal) {
          return {
            computerId,
            launched: false,
            launchMessage: refusal.ResultDetails?.Message,
            completed: false,
            waitedMs: 0,
            pollErrors: 0,
          };
        }

        const seen = baselines.get(computerId) ?? new Set();
        let pollErrors = 0;

        const inspect = (
          history: ScriptHistoryEntry[]
        ): ScriptRunWaitResult | undefined => {
          const match = history.find(
            (entry) =>
              !seen.has(entry.Id) &&
              entry.ScriptId === request.ScriptId &&
              entry.Status === "Completed"
          );
          if (!match) return undefined;
          return {
            computerId,
            launched: true,
            completed: true,
            state: match.State,
            diagnosticMessage: match.DiagnosticMessage,
            waitedMs: Date.now() - startedAt,
            pollErrors,
          };
        };

        // First poll immediately so a finished run does not wait a full
        // interval, and unit tests can complete without fake timers.
        try {
          const immediate = inspect(await recentHistory(computerId));
          if (immediate) return immediate;
        } catch (error) {
          if (!isTransientNetworkError(error)) {
            throw error;
          }
          pollErrors += 1;
        }

        while (Date.now() - startedAt < timeoutMs) {
          await delay(pollIntervalMs);
          try {
            const found = inspect(await recentHistory(computerId));
            if (found) return found;
          } catch (error) {
            if (!isTransientNetworkError(error)) {
              throw error;
            }
            pollErrors += 1;
          }
        }

        return {
          computerId,
          launched: true,
          completed: false,
          waitedMs: Date.now() - startedAt,
          pollErrors,
        };
      })
    );
  } catch (error) {
    throw error instanceof ScriptWaitError
      ? error
      : new ScriptWaitError("poll", error);
  }
}
