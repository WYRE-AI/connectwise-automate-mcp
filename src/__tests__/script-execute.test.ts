import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCRIPT_PRIORITY,
  SCRIPT_SCHEDULE_FREQUENCY_ONCE,
  automateMessage,
  buildScriptExecuteBatchBody,
  isAutomateApiError,
  toParameterPairs,
  toPriority,
} from "../utils/script-execute.js";

const now = new Date("2026-11-11T17:37:20.000Z");

describe("buildScriptExecuteBatchBody", () => {
  it("serializes the documented run-now defaults", () => {
    expect(buildScriptExecuteBatchBody({ scriptId: 363, computerIds: [10], now })).toEqual({
      EntityType: "Computer",
      EntityIds: [10],
      ScriptId: 363,
      Parameters: [],
      Priority: DEFAULT_SCRIPT_PRIORITY,
      OfflineActionFlags: {
        SkipsOfflineAgents: false,
        WakesOfflineAgents: false,
        OnlyRunsOnOfflineAgents: false,
      },
      UseAgentTime: false,
      StartDate: now.toISOString(),
      Schedule: { ScriptScheduleFrequency: { ScriptScheduleFrequencyId: SCRIPT_SCHEDULE_FREQUENCY_ONCE } },
    });
    expect(DEFAULT_SCRIPT_PRIORITY).toBe(2);
    expect(SCRIPT_SCHEDULE_FREQUENCY_ONCE).toBe(1);
  });

  it("maps priority names onto 1/2/3 and parameter objects onto Key/Value pairs", () => {
    expect(toPriority("high")).toBe(1);
    expect(toPriority("normal")).toBe(2);
    expect(toPriority("low")).toBe(3);
    expect(toPriority(undefined)).toBe(2);
    expect(toParameterPairs({ arg1: "value1" })).toEqual([{ Key: "arg1", Value: "value1" }]);
    expect(toParameterPairs(undefined)).toEqual([]);
    const body = buildScriptExecuteBatchBody({
      scriptId: 3007,
      computerIds: [1],
      parameters: { arg1: "value1" },
      priority: "high",
      skipOffline: true,
      now,
    });
    expect(body.Priority).toBe(1);
    expect(body.Parameters).toEqual([{ Key: "arg1", Value: "value1" }]);
    expect(body.OfflineActionFlags.SkipsOfflineAgents).toBe(true);
    expect(body.OfflineActionFlags.WakesOfflineAgents).toBe(false);
  });
});

describe("isAutomateApiError", () => {
  it("accepts 4xx/5xx with a statusCode and caps the message", () => {
    expect(isAutomateApiError({ statusCode: 500, message: "Encountered unhandled exception." })).toBe(true);
    expect(isAutomateApiError({ statusCode: 400, message: "bad" })).toBe(true);
    expect(isAutomateApiError(new Error("Validation error"))).toBe(false);
    expect(isAutomateApiError(null)).toBe(false);
    expect(automateMessage({ message: "x".repeat(600) })).toHaveLength(500);
  });
});
