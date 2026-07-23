/**
 * Shared types for the MCP server
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CWAutomateCredentials } from "./client.js";

/**
 * Tool call result type - inline definition for MCP SDK compatibility
 */
export type CallToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/**
 * Domain handler interface
 */
export interface DomainHandler {
  /** Get the tools for this domain */
  getTools(): Tool[];
  /**
   * Handle a tool call.
   *
   * @param toolName - The tool to invoke.
   * @param args - Tool arguments.
   * @param creds - Per-request credentials (gateway mode). When omitted,
   *                getClient() falls back to process.env (stdio / env mode).
   */
  handleCall(
    toolName: string,
    args: Record<string, unknown>,
    creds?: CWAutomateCredentials
  ): Promise<CallToolResult>;
}

/**
 * Domain names
 */
export type DomainName = "computers" | "clients" | "alerts" | "scripts";

/**
 * Check if a string is a valid domain name
 */
export function isDomainName(value: string): value is DomainName {
  return ["computers", "clients", "alerts", "scripts"].includes(value);
}
