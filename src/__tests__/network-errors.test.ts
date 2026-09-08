/**
 * Tests for transient-network-error detection.
 *
 * Regression coverage for the "Error: terminated" bug reported on
 * cwautomate_computers_reboot, cwautomate_computers_run_script, and
 * cwautomate_scripts_execute: a connection to ConnectWise Automate cut off
 * mid-response throws `TypeError: terminated` (undici's exact signature for
 * this failure — see network-errors.ts), and that raw message was
 * propagating straight to the tool result via mcp-server.ts's catch-all.
 */

import { describe, it, expect } from "vitest";
import { isTransientNetworkError } from "../utils/network-errors.js";

describe("isTransientNetworkError", () => {
  it("recognizes undici's premature-close TypeError", () => {
    expect(isTransientNetworkError(new TypeError("terminated"))).toBe(true);
  });

  it("rejects a TypeError with a different message", () => {
    expect(isTransientNetworkError(new TypeError("fetch failed"))).toBe(
      false
    );
  });

  it("rejects a plain Error even with a matching message", () => {
    expect(isTransientNetworkError(new Error("terminated"))).toBe(false);
  });

  it("rejects non-error values", () => {
    expect(isTransientNetworkError("terminated")).toBe(false);
    expect(isTransientNetworkError(undefined)).toBe(false);
    expect(isTransientNetworkError(null)).toBe(false);
  });
});
