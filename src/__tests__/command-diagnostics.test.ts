import { describe, expect, it, vi } from "vitest";
import { clampWaitSeconds } from "../utils/constants.js";
import { isDuplicateCommandError } from "../utils/network-errors.js";
import { describeScriptExecuteRequest, logScriptExecuteServerError, redact } from "../utils/log.js";

describe("wait bounds", () => {
  it.each([undefined, null, "10", NaN, Infinity, -Infinity])("uses fallback for %s", (value) => {
    expect(clampWaitSeconds(value, 20)).toBe(20);
  });
  it.each([[-3, 0], [0, 0], [3, 3], [999, 20]])("clamps %s to %s", (value, expected) => {
    expect(clampWaitSeconds(value, 0)).toBe(expected);
  });
});

describe("duplicate command classification", () => {
  it("requires both HTTP 400 and the duplicate message", () => {
    expect(isDuplicateCommandError(Object.assign(new Error("Duplicate command"), { statusCode: 400 }))).toBe(true);
    expect(isDuplicateCommandError(Object.assign(new Error("Duplicate command"), { statusCode: 500 }))).toBe(false);
    expect(isDuplicateCommandError(Object.assign(new Error("Bad parameters"), { statusCode: 400 }))).toBe(false);
    expect(isDuplicateCommandError(null)).toBe(false);
  });
});

describe("script execute diagnostics", () => {
  it("describes the serialized wire shape without parameter values or entity IDs", () => {
    const shape = describeScriptExecuteRequest({
      ScriptId: 42, EntityIds: [1001, 1002, 1003, 1004, 1005, 1006],
      Parameters: [{ Key: "arg", Value: "NEVER_LOG" }],
      Priority: 2,
      OfflineActionFlags: { SkipsOfflineAgents: undefined, WakesOfflineAgents: undefined },
      StartDate: undefined,
    });
    expect(shape).toEqual({
      keys: ["EntityIds", "EntityType", "OfflineActionFlags", "Parameters", "Priority", "ScriptId"],
      EntityType: "Computer", ScriptId: 42, entity_count: 6, Priority: 2,
      OfflineActionFlags: {}, parameters: { count: 1, keys: ["arg"] },
      has_StartDate: false, has_Schedule: false,
    });
    expect(JSON.stringify(shape)).not.toContain("NEVER_LOG");
    expect(JSON.stringify(shape)).not.toContain("1001");
  });

  it("preserves explicit fields as sent", () => {
    expect(describeScriptExecuteRequest({
      EntityType: "Computer", EntityIds: [], ScriptId: 1, Priority: 1,
      OfflineActionFlags: { SkipsOfflineAgents: false, WakesOfflineAgents: true },
      StartDate: "today", Schedule: {},
    })).toMatchObject({
      has_StartDate: true, has_Schedule: true,
      OfflineActionFlags: { SkipsOfflineAgents: false, WakesOfflineAgents: true },
    });
  });

  it("redacts JSON, query-string credentials and bearer tokens", () => {
    const result = redact('{"password":"p-one","secret":"s-two","token":"t-three","apikey":"a-four","clientid":"c-five"} ?password=q-six&token=q-seven Authorization: Bearer b-eight');
    for (const secret of ["p-one", "s-two", "t-three", "a-four", "c-five", "q-six", "q-seven", "b-eight"]) {
      expect(result).not.toContain(secret);
    }
    expect(result).toContain("[REDACTED]");
  });

  it("emits exactly one line with a redacted, bounded body", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const error = { statusCode: 503, response: { password: "private", message: "x".repeat(3000) } };
      logScriptExecuteServerError(error, { keys: ["ScriptId"] });
      expect(stderr).toHaveBeenCalledTimes(1);
      const line = stderr.mock.calls[0][0] as string;
      expect(line).toMatch(/^\[MCP\] cwautomate_scripts_execute upstream 500 diagnostics: /);
      const data = JSON.parse(line.slice(line.indexOf("{")));
      expect(data.status).toBe(503);
      expect(data.response_body).toHaveLength(2000);
      expect(data.response_body).not.toContain("private");
      expect(data.request_shape).toEqual({ keys: ["ScriptId"] });
    } finally {
      stderr.mockRestore();
    }
  });

  it("does not log client errors", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      logScriptExecuteServerError({ statusCode: 400 }, {});
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });
});
