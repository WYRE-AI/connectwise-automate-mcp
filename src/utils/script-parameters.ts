/**
 * Parse and resolve ConnectWise Automate script parameter declarations.
 *
 * `GET /Scripts/{id}` returns `Parameters` as a string array. Each entry is a
 * declared parameter name, optionally with a default after the first `=`:
 *   - `"ServiceName"`           → required, no default
 *   - `"ServiceName=Spooler"`   → optional; default "Spooler"
 *
 * Names may appear wrapped as `%name%` or `@name@` in catalog rows; the
 * ScriptExecute body uses the bare name as `Key`. Automate's swagger does not
 * expose a separate type field on these strings, so `type` is reported as
 * `"string"` unless the declaration itself carries a recognizable hint.
 *
 * Automate rejects ScriptExecute with HTTP 400 when a declared parameter is
 * omitted from the body, even when it has a default — so launches must always
 * send the full declared set as `{ Key, Value }` pairs.
 */

export interface DeclaredScriptParameter {
  /** Bare parameter name used as ScriptExecute `Key`. */
  name: string;
  /** Original catalog string from Automate. */
  raw: string;
  /** Default value when the declaration includes `=...`; otherwise undefined. */
  defaultValue?: string;
  /** True when the declaration has no default — the caller must supply a value. */
  required: boolean;
  /**
   * Best-effort type for tool errors and discovery. Automate's catalog strings
   * do not carry a typed schema; this is `"string"` unless a suffix like
   * `:number` / `:boolean` appears on the name segment.
   */
  type: string;
}

export interface ResolvedScriptParameters {
  /** Values to send on ScriptExecute, keyed by bare parameter name. */
  parameters: Record<string, string>;
  /** Declared parameters after parsing (declaration order). */
  declared: DeclaredScriptParameter[];
  /** Keys filled from a declaration default rather than the caller. */
  filled_defaults: string[];
  /** Caller keys that are not in the declared set (still forwarded). */
  unknown_keys: string[];
}

export interface MissingScriptParametersError {
  missing: DeclaredScriptParameter[];
  declared: DeclaredScriptParameter[];
}

/** Strip a single surrounding `%...%` or `@...@` pair from a parameter name. */
export function normalizeParameterName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "%" && last === "%") || (first === "@" && last === "@")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

/**
 * Parse one Automate `Parameters[]` entry into a structured declaration.
 *
 * Recognized forms:
 *   - `name`
 *   - `name=default`
 *   - `name:type` / `name:type=default` (type is informational only)
 */
export function parseDeclaredScriptParameter(raw: string): DeclaredScriptParameter {
  const source = raw ?? "";
  const eq = source.indexOf("=");
  const nameAndType = eq === -1 ? source : source.slice(0, eq);
  const defaultValue = eq === -1 ? undefined : source.slice(eq + 1);

  let type = "string";
  let namePart = nameAndType;
  const typeSep = nameAndType.lastIndexOf(":");
  if (typeSep > 0) {
    const maybeType = nameAndType.slice(typeSep + 1).trim().toLowerCase();
    if (/^[a-z][a-z0-9_-]*$/i.test(maybeType)) {
      type = maybeType;
      namePart = nameAndType.slice(0, typeSep);
    }
  }

  const name = normalizeParameterName(namePart);
  return {
    name,
    raw: source,
    ...(defaultValue !== undefined ? { defaultValue } : {}),
    required: defaultValue === undefined,
    type,
  };
}

export function parseDeclaredScriptParameters(
  rawParameters: string[] | undefined | null
): DeclaredScriptParameter[] {
  if (!rawParameters?.length) return [];
  const seen = new Set<string>();
  const declared: DeclaredScriptParameter[] = [];
  for (const raw of rawParameters) {
    if (typeof raw !== "string") continue;
    const parsed = parseDeclaredScriptParameter(raw);
    if (!parsed.name || seen.has(parsed.name)) continue;
    seen.add(parsed.name);
    declared.push(parsed);
  }
  return declared;
}

/**
 * Look up a caller-supplied value by bare name or `%name%` / `@name@` forms.
 */
function providedValue(
  provided: Record<string, string> | undefined,
  name: string
): string | undefined {
  if (!provided) return undefined;
  if (Object.prototype.hasOwnProperty.call(provided, name)) {
    return provided[name];
  }
  const pct = `%${name}%`;
  if (Object.prototype.hasOwnProperty.call(provided, pct)) {
    return provided[pct];
  }
  const at = `@${name}@`;
  if (Object.prototype.hasOwnProperty.call(provided, at)) {
    return provided[at];
  }
  return undefined;
}

/**
 * Merge caller parameters with the script's declared set.
 *
 * - Declared params with defaults are filled when the caller omits them.
 * - Declared params without defaults that are still missing become an error.
 * - Unknown caller keys are kept and appended so intentional extras are not dropped.
 */
export function resolveScriptParameters(
  rawDeclared: string[] | undefined | null,
  provided?: Record<string, string>
):
  | { ok: true; value: ResolvedScriptParameters }
  | { ok: false; error: MissingScriptParametersError } {
  const declared = parseDeclaredScriptParameters(rawDeclared);
  // Null prototype so a declared or caller key named `__proto__` is stored as
  // a real parameter instead of invoking Object.prototype.__proto__.
  const parameters: Record<string, string> = Object.create(null);
  const filled_defaults: string[] = [];
  const missing: DeclaredScriptParameter[] = [];
  const usedKeys = new Set<string>();

  for (const param of declared) {
    const fromCaller = providedValue(provided, param.name);
    if (fromCaller !== undefined) {
      parameters[param.name] = fromCaller;
      usedKeys.add(param.name);
      usedKeys.add(`%${param.name}%`);
      usedKeys.add(`@${param.name}@`);
      continue;
    }
    if (param.defaultValue !== undefined) {
      parameters[param.name] = param.defaultValue;
      filled_defaults.push(param.name);
      continue;
    }
    missing.push(param);
  }

  if (missing.length > 0) {
    return { ok: false, error: { missing, declared } };
  }

  const unknown_keys: string[] = [];
  if (provided) {
    for (const [key, value] of Object.entries(provided)) {
      if (usedKeys.has(key) || usedKeys.has(normalizeParameterName(key))) {
        continue;
      }
      // Skip alias forms of a declared name that was already filled.
      const bare = normalizeParameterName(key);
      if (Object.prototype.hasOwnProperty.call(parameters, bare)) {
        continue;
      }
      parameters[key] = value;
      unknown_keys.push(key);
    }
  }

  return {
    ok: true,
    value: { parameters, declared, filled_defaults, unknown_keys },
  };
}

function parameterDetail(param: DeclaredScriptParameter): Record<string, unknown> {
  return {
    name: param.name,
    type: param.type,
    required: param.required,
    ...(param.defaultValue !== undefined
      ? { defaultValue: param.defaultValue }
      : {}),
    raw: param.raw,
  };
}

/** Structured tool-error payload when required parameters are missing. */
export function missingParametersToolError(
  scriptId: number,
  error: MissingScriptParametersError
): Record<string, unknown> {
  return {
    script_id: scriptId,
    launched: false,
    missing_parameters: error.missing.map(parameterDetail),
    declared_parameters: error.declared.map(parameterDetail),
    message:
      "Missing required script parameter(s): " +
      error.missing
        .map((param) => `${param.name} (type: ${param.type}, no default)`)
        .join(", ") +
      ". Supply them in `parameters`, or inspect declared parameters via " +
      "cwautomate_scripts_get. The script was not launched.",
  };
}

/**
 * Structured tool-error when `GET /Scripts/{id}` fails before any launch.
 * This is a read-only failure — nothing was sent to ScriptExecute.
 */
export function scriptLookupFailedToolError(
  scriptId: number,
  cause: unknown
): Record<string, unknown> {
  const http: Record<string, unknown> = {};
  if (
    typeof cause === "object" &&
    cause !== null &&
    "statusCode" in cause &&
    typeof (cause as { statusCode: unknown }).statusCode === "number" &&
    (cause as { statusCode: number }).statusCode >= 400
  ) {
    http.status_code = (cause as { statusCode: number }).statusCode;
    const message =
      "message" in cause && typeof (cause as { message: unknown }).message === "string"
        ? (cause as { message: string }).message.trim()
        : "";
    if (message) http.automate_message = message.slice(0, 500);
  }
  return {
    script_id: scriptId,
    launched: false,
    ...http,
    message:
      "Could not read the script's declared parameters from Automate before " +
      "launch, so no launch was attempted. The script was not launched.",
  };
}

/** Attach parsed parameter details alongside Automate's raw Parameters array. */
export function withParameterDetails<T extends { Parameters?: string[] }>(
  script: T
): T & { parameter_details: DeclaredScriptParameter[] } {
  return {
    ...script,
    parameter_details: parseDeclaredScriptParameters(script.Parameters),
  };
}
