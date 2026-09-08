/**
 * Tests for OData condition-building helpers.
 *
 * Regression coverage for the cwautomate_scripts_list bug: the client
 * library's `name` list param on ScriptListParams is not a real Automate
 * filter (Automate's REST API only understands the generic `condition`
 * expression), so passing `name` straight through returned every script
 * unfiltered regardless of `search`.
 */

import { describe, it, expect } from "vitest";
import { escapeConditionValue, containsCondition } from "../utils/odata.js";

describe("escapeConditionValue", () => {
  it("doubles single quotes", () => {
    expect(escapeConditionValue("O'Brien")).toBe("O''Brien");
  });

  it("leaves a value with no quotes unchanged", () => {
    expect(escapeConditionValue("Reboot")).toBe("Reboot");
  });
});

describe("containsCondition", () => {
  it("builds a like condition for the given field and value", () => {
    expect(containsCondition("Name", "Reboot")).toBe("Name like '%Reboot%'");
  });

  it("escapes single quotes in the value", () => {
    expect(containsCondition("Name", "O'Brien's script")).toBe(
      "Name like '%O''Brien''s script%'"
    );
  });

  it("returns undefined for an empty or missing value", () => {
    expect(containsCondition("Name", undefined)).toBeUndefined();
    expect(containsCondition("Name", "")).toBeUndefined();
  });
});
