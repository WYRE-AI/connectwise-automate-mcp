/**
 * Conduit aborts gateway writes at 30s (conduit src/proxy/unified-router.ts,
 * AbortSignal.timeout(30_000)). Every wait must finish well under that limit.
 */
export const MAX_WAIT_SECONDS = 20;

/** Scripts return a partial, still-running result after this wait; never relaunch. */
export const DEFAULT_WAIT_SECONDS = 20;

/** Commands return as soon as Automate queues them; read their execution later. */
export const DEFAULT_COMMAND_WAIT_SECONDS = 0;

export function clampWaitSeconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_WAIT_SECONDS, Math.max(0, value))
    : fallback;
}
