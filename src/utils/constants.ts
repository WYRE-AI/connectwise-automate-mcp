/**
 * Shared tool-behaviour constants.
 */

/**
 * How long a script or command run is waited on before a partial result is
 * returned.
 *
 * Automate runs are asynchronous: work is picked up on the agent's next
 * check-in, which defaults to every 5 minutes unless the agent is in FasTalk
 * mode. A wait long enough to cover that would outlast the tool-call timeout
 * most MCP clients enforce, so this stays comfortably under it and a run that
 * takes longer comes back as "still running" with a pointer to the history
 * tools, rather than as a dead connection.
 */
export const DEFAULT_WAIT_SECONDS = 90;
