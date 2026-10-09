/**
 * Socket-drop detection for ConnectWise Automate calls.
 *
 * The classifier lives in `@wyre-ai/node-connectwise-automate` and is
 * re-exported here so tool handlers and the CallTool catch-all agree with
 * the client. It matches a dropped socket (`terminated`, `other side closed`,
 * and codes `ECONNRESET`, `UND_ERR_SOCKET`, `UND_ERR_CLOSED`, `EPIPE`,
 * `ETIMEDOUT`), including on `error.cause`. A bare `TypeError: fetch failed`
 * is not enough: undici uses that wrapper for DNS and refused connections too.
 *
 * POST and PATCH are never retried by the client. A socket error on those
 * throws `ConnectWiseAutomateAmbiguousRequestError` (the original error stays
 * on `cause`): the request may already have been processed, and sending it
 * again can run a command or script twice.
 */
import {
  ConnectWiseAutomateAmbiguousRequestError,
  isTransientNetworkError,
} from "@wyre-ai/node-connectwise-automate";

export {
  ConnectWiseAutomateAmbiguousRequestError,
  isTransientNetworkError,
};

/**
 * A launch that died at the socket (`ConnectWiseAutomateAmbiguousRequestError`)
 * or any other dropped connection. The request may already have been
 * processed, so the caller must not send it again.
 */
export function isDroppedConnection(error: unknown): boolean {
  return (
    error instanceof ConnectWiseAutomateAmbiguousRequestError ||
    isTransientNetworkError(error)
  );
}
