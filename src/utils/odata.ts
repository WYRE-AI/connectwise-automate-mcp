/**
 * Helpers for building ConnectWise Automate `condition` filter expressions.
 *
 * The Automate REST API has no per-field search parameters on its list
 * endpoints — filtering is done entirely through the generic OData-style
 * `condition` string (`BaseListParams.condition` in the client library,
 * e.g. `ComputerName like '%web%'`). A field name passed as its own query
 * parameter (e.g. `?name=...`) is silently ignored by the API.
 */

/**
 * Escape single quotes for an OData-style condition string value.
 */
export function escapeConditionValue(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Build a `<field> like '%<value>%'` condition for a substring search,
 * or `undefined` when there is nothing to filter by.
 */
export function containsCondition(
  field: string,
  value?: string
): string | undefined {
  if (!value) return undefined;
  return `${field} like '%${escapeConditionValue(value)}%'`;
}
