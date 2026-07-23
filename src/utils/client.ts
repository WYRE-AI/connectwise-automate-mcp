/**
 * ConnectWise Automate client factory — request-scoped, no global singleton.
 *
 * Credentials are resolved per-call in priority order:
 *   1. An explicit CWAutomateCredentials object (gateway / request-scoped)
 *   2. process.env CW_AUTOMATE_* vars (stdio / single-tenant env mode)
 *
 * process.env is never mutated by request handlers; callers pass credentials
 * directly to getClient() so concurrent requests cannot contaminate each other.
 */

import {
  ConnectWiseAutomateClient,
  type ConnectWiseAutomateConfig,
} from "@wyre-technology/node-connectwise-automate";

/**
 * Authentication method for ConnectWise Automate.
 * - "integrator": machine-to-machine integrator account (no 2FA). Default.
 * - "user": interactive user login, supports a 2FA passcode.
 */
export type CWAutomateAuthMethod = "integrator" | "user";

export interface CWAutomateCredentials {
  serverUrl: string;
  clientId: string;
  username: string;
  password: string;
  twoFactorCode?: string;
  /**
   * Authentication method (default: "integrator"). When unset, "user" is
   * inferred if a twoFactorCode is supplied, since 2FA is only valid for
   * interactive user authentication.
   */
  authMethod?: CWAutomateAuthMethod;
}

/**
 * Get credentials from environment variables.
 * Used by stdio / single-tenant deployments; never called during gateway
 * requests that supply explicit credentials to getClient().
 */
export function getCredentials(): CWAutomateCredentials | null {
  const serverUrl = process.env.CW_AUTOMATE_SERVER_URL;
  const clientId = process.env.CW_AUTOMATE_CLIENT_ID;
  const username = process.env.CW_AUTOMATE_USERNAME;
  const password = process.env.CW_AUTOMATE_PASSWORD;
  const twoFactorCode = process.env.CW_AUTOMATE_2FA_CODE;

  if (!serverUrl || !clientId || !username || !password) {
    return null;
  }

  return {
    serverUrl,
    clientId,
    username,
    password,
    twoFactorCode,
    authMethod: parseAuthMethod(process.env.CW_AUTOMATE_AUTH_METHOD),
  };
}

/**
 * Parse an auth method string from configuration, ignoring invalid values.
 */
export function parseAuthMethod(
  value?: string
): CWAutomateAuthMethod | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === "user" || normalized === "integrator"
    ? normalized
    : undefined;
}

/**
 * Resolve the effective auth method for a set of credentials.
 * Honors an explicit choice; otherwise defaults to "integrator", upgrading to
 * "user" only when a 2FA code is present (2FA is invalid for integrator auth).
 */
function resolveAuthMethod(creds: CWAutomateCredentials): CWAutomateAuthMethod {
  if (creds.authMethod) {
    return creds.authMethod;
  }
  return creds.twoFactorCode ? "user" : "integrator";
}

/**
 * Build the library client config (with its nested `credentials` object) from
 * the flat credential set the MCP server collects from env/headers.
 */
function buildClientConfig(
  creds: CWAutomateCredentials
): ConnectWiseAutomateConfig {
  if (resolveAuthMethod(creds) === "user") {
    return {
      serverUrl: creds.serverUrl,
      clientId: creds.clientId,
      credentials: {
        method: "user",
        username: creds.username,
        password: creds.password,
        twoFactorCode: creds.twoFactorCode,
      },
    };
  }

  return {
    serverUrl: creds.serverUrl,
    clientId: creds.clientId,
    credentials: {
      method: "integrator",
      integratorUsername: creds.username,
      integratorPassword: creds.password,
    },
  };
}

/**
 * Check if credentials are available (from an explicit override or env).
 */
export function hasCredentials(overrides?: CWAutomateCredentials | null): boolean {
  return !!(overrides || getCredentials());
}

/**
 * Construct a ConnectWise Automate client from the supplied credentials.
 *
 * When `credsOverride` is provided (gateway / request-scoped mode) it is used
 * directly and process.env is never consulted. When omitted the function
 * falls back to getCredentials() (env / stdio mode).
 *
 * A new client instance is created for every call — there is no shared
 * mutable cache — so there is no cross-tenant leak surface regardless of how
 * many requests are in flight concurrently.
 */
export async function getClient(
  credsOverride?: CWAutomateCredentials
): Promise<ConnectWiseAutomateClient> {
  const creds = credsOverride ?? getCredentials();

  if (!creds) {
    throw new Error(
      "No API credentials provided. Please configure CW_AUTOMATE_SERVER_URL, CW_AUTOMATE_CLIENT_ID, CW_AUTOMATE_USERNAME, and CW_AUTOMATE_PASSWORD environment variables."
    );
  }

  return new ConnectWiseAutomateClient(buildClientConfig(creds));
}

/**
 * No-op kept for test compatibility — no singleton to clear.
 * @deprecated Tests should no longer rely on a module-level singleton.
 */
export function clearClient(): void {
  // intentional no-op: there is no shared client or override to clear
}
