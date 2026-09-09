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
import {
  escapeConditionValue,
  containsCondition,
  equalsCondition,
  andConditions,
} from "../utils/odata.js";

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

describe("equalsCondition", () => {
  it("builds an equality condition for a numeric id", () => {
    expect(equalsCondition("Client.Id", 42)).toBe("Client.Id = 42");
  });

  it("treats zero as a real value, not as missing", () => {
    expect(equalsCondition("Folder.Id", 0)).toBe("Folder.Id = 0");
  });

  it("returns undefined when no value is given", () => {
    expect(equalsCondition("Client.Id", undefined)).toBeUndefined();
  });
});

describe("andConditions", () => {
  it("returns undefined when every clause is missing", () => {
    expect(andConditions()).toBeUndefined();
    expect(andConditions(undefined, undefined)).toBeUndefined();
    expect(andConditions("", undefined)).toBeUndefined();
  });

  it("returns a single clause unchanged, without wrapping parentheses", () => {
    expect(andConditions("Client.Id = 1")).toBe("Client.Id = 1");
    expect(andConditions(undefined, "Client.Id = 1", "")).toBe(
      "Client.Id = 1"
    );
  });

  it("parenthesises and joins two or more clauses with and", () => {
    expect(andConditions("Client.Id = 1", "Severity.Id = 3")).toBe(
      "(Client.Id = 1) and (Severity.Id = 3)"
    );
    expect(
      andConditions("Folder.Id = 5", undefined, "Name like '%x%'", "A = 1")
    ).toBe("(Folder.Id = 5) and (Name like '%x%') and (A = 1)");
  });
});
