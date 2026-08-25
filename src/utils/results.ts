/**
 * Helpers for building MCP tool results.
 */

import type { CallToolResult } from "./types.js";

/**
 * Wrap any JSON-serializable value in the standard text tool result.
 */
export function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

/**
 * View an arbitrary value as a possible list envelope, without asserting its
 * fields actually exist. Centralizes the "is this a non-null object?" guard so
 * both the items and the count are read through one place.
 */
function asEnvelope(response: unknown): {
  Data?: unknown;
  TotalRecords?: unknown;
} {
  return response !== null && typeof response === "object"
    ? (response as { Data?: unknown; TotalRecords?: unknown })
    : {};
}

/**
 * Extract the array of items from a ConnectWise Automate list response.
 *
 * The Automate REST API returns list endpoints as a bare JSON array, even
 * though the client library's types model them as `{ Data, TotalRecords }`.
 * Accept either shape (and return an empty array for anything unexpected) so a
 * type/runtime mismatch can never crash a tool call (issue #35).
 *
 * This is a compensating shim; the root cause is the library's response types +
 * unchecked cast, tracked upstream in
 * WYRE-AI/node-connectwise-automate#38. Once that lands this can return
 * to trusting the library's typed shape.
 */
export function listItems<T = unknown>(response: unknown): T[] {
  if (Array.isArray(response)) {
    return response as T[];
  }
  const { Data } = asEnvelope(response);
  return Array.isArray(Data) ? (Data as T[]) : [];
}

/**
 * Shape a ConnectWise Automate list response into a friendly `{ total, <key> }`
 * tool result. Tolerant of both the bare-array shape returned by the live API
 * and the `{ Data, TotalRecords }` envelope described by the library's types.
 */
export function listResult(key: string, response: unknown): CallToolResult {
  const items = listItems(response);
  const { TotalRecords } = asEnvelope(response);
  const total = typeof TotalRecords === "number" ? TotalRecords : items.length;

  return jsonResult({ total, [key]: items });
}
