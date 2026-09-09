/**
 * Stderr logging for failed tool calls.
 *
 * MCP's stdio transport owns stdout, so stderr is the only channel that
 * reaches the container logs. Until this existed a failed tool call left no
 * trace at all: customers saw an error while the logs stayed empty.
 */

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
  const suffix = note ? ` (${note})` : "";
  console.error(`[MCP] tool ${toolName} failed: ${label}${suffix}`);
}
