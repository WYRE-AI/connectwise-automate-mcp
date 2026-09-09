/**
 * Detection for the transport-level failure Node's `fetch` (undici) throws
 * when a ConnectWise Automate response is cut off mid-transfer: the request
 * went out and a connection was live, but the socket closed before the body
 * finished arriving. This happens when a WAF/proxy fronting a hosted
 * Automate instance gives up on a slow response, or when a pooled keep-alive
 * connection is reused just after the far end already closed it.
 *
 * There is no HTTP status to react to in this case — no complete response
 * was ever received, so the client library's own 5xx-retry logic
 * (`executeRequest`'s retry-once-on-500, in `@wyre-ai/node-connectwise-automate`)
 * never runs; that logic only sees requests that got a response at all.
 * Undici's documented behavior for this exact failure is
 * `TypeError: terminated` (see https://github.com/nodejs/undici/issues/1489),
 * which is also the raw text customers were seeing verbatim in tool results
 * (`mcp-server.ts`'s catch-all does `error.message`).
 */
export function isTransientNetworkError(error: unknown): boolean {
  return error instanceof TypeError && error.message === "terminated";
}
