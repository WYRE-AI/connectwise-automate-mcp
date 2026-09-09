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
