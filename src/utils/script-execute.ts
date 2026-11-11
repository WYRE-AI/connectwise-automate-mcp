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
 * Prod logs showed a sparse body (no Parameters, Priority, StartDate or
 * Schedule, and for cwautomate_scripts_execute an empty OfflineActionFlags)
 * caused Automate HTTP 500 "Encountered unhandled exception." on both tools.
 */

import { isDroppedConnection, isTransientNetworkError } from "./network-errors.js";

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

/**
 * Appended to every message where a script may be running or queued. History
 * only lists finished runs, so the running tool is needed too.
 */
export const CHECK_RUNS_GUIDANCE =
  "Check cwautomate_scripts_history for the outcome and cwautomate_scripts_running " +
  "for runs still queued or running (history cannot see queued runs). " +
  "Do not launch the script again.";

export const POLL_FAILED_MESSAGE =
  "The script launch was accepted by Automate, but reading script history failed. " +
  CHECK_RUNS_GUIDANCE;

export const STILL_RUNNING_MESSAGE =
  "The script was launched but had not finished when the wait ended. It keeps " +
  "running on the computer. " +
  CHECK_RUNS_GUIDANCE;

export const LAUNCH_UNKNOWN_MESSAGE =
  "The launch request did not get a clear answer from Automate, so it is not " +
  "known whether the script started. It may or may not have been launched, " +
  "and this tool did not retry. " +
  CHECK_RUNS_GUIDANCE;

/** Statuses where Automate clearly refused the launch request. */
const LAUNCH_REJECTED_STATUSES = new Set([400, 401, 403, 404, 422]);

export type ScriptWaitPhase = "baseline" | "launch";

/** Thrown when the baseline history read or the launch POST fails. */
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

/** What to log and return (with `isError`) for a failure before the script started. */
export interface LaunchFailureReport {
  log: string;
  body: Record<string, unknown>;
}

/**
 * Classify a failure from the baseline history read or the launch POST.
 *
 * - baseline: nothing was sent, so an Automate HTTP error means not launched.
 * - launch, clear client rejection (400/401/403/404/422): not launched.
 * - launch, anything else (5xx, 408, a non-JSON reply, any raw error): the
 *   request may have reached Automate, so the outcome is unknown.
 *
 * Returns undefined for a dropped connection, and for a non-HTTP baseline
 * error; the caller handles those.
 */
export function describeLaunchFailure(
  phase: ScriptWaitPhase,
  cause: unknown
): LaunchFailureReport | undefined {
  const http = isAutomateApiError(cause)
    ? { status_code: cause.statusCode, automate_message: automateMessage(cause) }
    : {};

  if (phase === "baseline") {
    if (!isAutomateApiError(cause)) return undefined;
    return {
      log: "script history could not be read before launch; no launch was attempted",
      body: {
        launched: false,
        ...http,
        message:
          "Automate could not read script history before launch, so no launch was attempted. The script was not launched.",
      },
    };
  }

  if (isDroppedConnection(cause)) return undefined;

  if (isAutomateApiError(cause) && LAUNCH_REJECTED_STATUSES.has(cause.statusCode)) {
    return {
      log: "rejected by Automate; this tool made no further launch attempt",
      body: {
        launched: false,
        ...http,
        message:
          "Rejected by Automate. This tool made no further launch attempt. The script was not launched.",
      },
    };
  }

  return {
    log: "launch outcome unknown; this tool made no further launch attempt",
    body: { launched: "unknown", ...http, message: LAUNCH_UNKNOWN_MESSAGE },
  };
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
  /** A history poll error after the launch was accepted (HTTP status only when Automate sent one). */
  pollFailure?: { statusCode?: number; message?: string };
}

export interface RunScriptsWaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  delay?: (ms: number) => Promise<void>;
}

const defaultDelay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Launch via executeBatch, then poll history. Tracks the phase so a failure
 * before or at the launch is not confused with one after it. Once the launch
 * has been accepted this never throws: any non-transient history poll error
 * is kept on that target's result (`pollFailure`), so it cannot hide another
 * target's refusal or completion. Transient network errors during a poll are
 * retried until the deadline, matching the SDK. A zero timeout makes no
 * history request after the launch.
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

  return Promise.all(
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

      // The first poll is immediate so a finished run does not wait a full
      // interval; later polls wait. No poll at all when timeoutMs is 0.
      let firstPoll = true;
      while (Date.now() - startedAt < timeoutMs) {
        if (!firstPoll) await delay(pollIntervalMs);
        firstPoll = false;
        try {
          const found = inspect(await recentHistory(computerId));
          if (found) return found;
        } catch (error) {
          if (isTransientNetworkError(error)) {
            pollErrors += 1;
          } else {
            return {
              computerId,
              launched: true,
              completed: false,
              waitedMs: Date.now() - startedAt,
              pollErrors,
              pollFailure: {
                statusCode: isAutomateApiError(error) ? error.statusCode : undefined,
                message:
                  isAutomateApiError(error) || error instanceof Error
                    ? automateMessage(error)
                    : undefined,
              },
            };
          }
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
}
