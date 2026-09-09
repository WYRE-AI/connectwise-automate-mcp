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

/**
 * Build a `<field> = <value>` condition for a numeric id (e.g.
 * `Client.Id = 42`), or `undefined` when no value is given.
 */
export function equalsCondition(
  field: string,
  value?: number
): string | undefined {
  if (value === undefined) return undefined;
  return `${field} = ${value}`;
}

/**
 * Combine condition clauses with `and`. Missing/empty clauses are dropped, a
 * lone clause is returned as-is, and two or more are each parenthesised and
 * joined: `(a) and (b)`. Returns `undefined` when nothing is left to filter by.
 */
export function andConditions(
  ...clauses: Array<string | undefined>
): string | undefined {
  const present = clauses.filter((clause): clause is string => !!clause);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return present.map((clause) => `(${clause})`).join(" and ");
}
