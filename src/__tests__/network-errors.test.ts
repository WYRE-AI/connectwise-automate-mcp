/**
 * Tests for transient-network-error detection.
 *
 * Classification lives in `@wyre-ai/node-connectwise-automate`. This module
 * re-exports it so a dropped Automate connection is recognized the same way
 * the client already retried (GET) or refused to retry (POST/PATCH).
 */

import { describe, it, expect } from "vitest";
import {
  ConnectWiseAutomateAmbiguousRequestError,
  ConnectWiseAutomateError,
  isTransientNetworkError as sdkIsTransientNetworkError,
} from "@wyre-ai/node-connectwise-automate";
import {
  isDroppedConnection,
  isTransientNetworkError,
} from "../utils/network-errors.js";

describe("isTransientNetworkError", () => {
  it("re-exports the SDK classifier", () => {
    expect(isTransientNetworkError).toBe(sdkIsTransientNetworkError);
  });

  it("recognizes undici's premature-close TypeError", () => {
    expect(isTransientNetworkError(new TypeError("terminated"))).toBe(true);
  });

  it("recognizes a socket close reported as a plain Error message", () => {
    expect(isTransientNetworkError(new Error("other side closed"))).toBe(true);
    expect(isTransientNetworkError(new Error("terminated"))).toBe(true);
  });

  it("recognizes socket error codes, including on error.cause", () => {
    expect(isTransientNetworkError(Object.assign(new Error("fail"), { code: "ECONNRESET" }))).toBe(
      true
    );
    const wrapped = new TypeError("fetch failed");
    wrapped.cause = Object.assign(new Error("socket"), { code: "UND_ERR_SOCKET" });
    expect(isTransientNetworkError(wrapped)).toBe(true);
  });

  it("rejects a bare fetch-failed TypeError with no socket cause", () => {
    expect(isTransientNetworkError(new TypeError("fetch failed"))).toBe(false);
  });

  it("rejects an HTTP error whose message happens to say terminated", () => {
    expect(
      isTransientNetworkError(new ConnectWiseAutomateError("terminated", 500))
    ).toBe(false);
  });

  it("treats an ambiguous POST error as transient when its cause is a socket drop", () => {
    const error = new ConnectWiseAutomateAmbiguousRequestError(
      "Connection interrupted during POST /Batch/ScriptExecute.",
      { cause: new TypeError("terminated") }
    );
    expect(isTransientNetworkError(error)).toBe(true);
    expect(isDroppedConnection(error)).toBe(true);
  });

  it("rejects non-error values that are not a socket signal", () => {
    expect(isTransientNetworkError(undefined)).toBe(false);
    expect(isTransientNetworkError(null)).toBe(false);
    expect(isDroppedConnection(null)).toBe(false);
    expect(isDroppedConnection(new Error("Access forbidden"))).toBe(false);
  });
});
