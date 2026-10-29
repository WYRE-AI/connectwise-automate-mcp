/**
 * Stderr logging for failed tool calls.
 *
 * MCP's stdio transport owns stdout, so stderr is the only channel that
 * reaches the container logs. Until this existed a failed tool call left no
 * trace at all: customers saw an error while the logs stayed empty.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Start time of the tool call being handled, set once per CallTool request in
 * mcp-server.ts so every failure line can say how long the call ran before it
 * died — the difference between a WAF timeout and an immediate reset.
 */
export const toolCallTiming = new AsyncLocalStorage<number>();

/**
 * Log one line for a tool call that failed, in the form
 * `[MCP] tool <name> failed: <ErrorName>: <message>`, optionally followed by
 * a parenthesised note on what the server was doing at the time.
 *
 * Tool arguments and credentials are deliberately never logged; they can
 * carry customer data and secrets.
 */
export function logToolFailure(
  toolName: string,
  error: unknown,
  note?: string
): void {
  const label =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const startedAt = toolCallTiming.getStore();
  const parts = [note, startedAt !== undefined ? `after ${Date.now() - startedAt}ms` : undefined].filter(Boolean);
  const suffix = parts.length ? ` (${parts.join("; ")})` : "";
  console.error(`[MCP] tool ${toolName} failed: ${label}${suffix}`);
}

/** Remove credential values from upstream response text before logging it. */
export function redact(value: string): string {
  return value
    .replace(/bearer\s+[^\s"'&,}]+/gi, "Bearer [REDACTED]")
    .replace(/(["']?(?:password|secret|token|api[_-]?key|client[_-]?id)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s&,}]+)/gi,
      "$1\"[REDACTED]\"");
}

/** Mirror the SDK's JSON body, exposing parameter keys only, never values. */
export function describeScriptExecuteRequest(body: Record<string, unknown>) {
  const sent = JSON.parse(JSON.stringify({ EntityType: "Computer", ...body }));
  const parameters = sent.Parameters as { Key: string }[] | undefined;
  return {
    keys: Object.keys(sent).sort(),
    EntityType: sent.EntityType,
    ScriptId: sent.ScriptId,
    entity_count: sent.EntityIds?.length ?? 0,
    Priority: sent.Priority,
    OfflineActionFlags: sent.OfflineActionFlags,
    parameters: { count: parameters?.length ?? 0, keys: parameters?.map((p) => p.Key) ?? [] },
    has_StartDate: Object.hasOwn(sent, "StartDate"),
    has_Schedule: Object.hasOwn(sent, "Schedule"),
  };
}

/** Add one diagnostic line for upstream server errors; callers still rethrow. */
export function logScriptExecuteServerError(error: unknown, requestShape: unknown): void {
  if (typeof error !== "object" || error === null || !("statusCode" in error) ||
      typeof error.statusCode !== "number" || error.statusCode < 500) return;
  const response = "response" in error ? error.response : undefined;
  const body = typeof response === "string" ? response : JSON.stringify(response);
  console.error("[MCP] cwautomate_scripts_execute upstream 500 diagnostics: " + JSON.stringify({
    status: error.statusCode,
    response_body: redact(body ?? "").slice(0, 2000),
    request_shape: requestShape,
  }));
}
