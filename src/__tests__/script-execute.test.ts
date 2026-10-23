import { describe, expect, it, vi } from "vitest";
import { buildScriptExecuteBatchBody, scriptExecuteRequest, scriptLaunchFailure } from "../utils/script-execute.js";

const now = new Date("2026-10-23T12:00:00.000Z");
const defaults = {
  EntityType: "Computer", EntityIds: [1], ScriptId: 100, Parameters: [], Priority: 5,
  OfflineActionFlags: { SkipsOfflineAgents: false, WakesOfflineAgents: false, OnlyRunsOnOfflineAgents: false },
  UseAgentTime: false, StartDate: now.toISOString(),
  Schedule: { ScriptScheduleFrequency: { ScriptScheduleFrequencyId: 1 } },
};
describe("script execute mirror", () => {
  it("builds the exact default body from tool args", () => {
    expect(scriptExecuteRequest({ script_id: 100 }, [1], now)).toEqual(defaults);
    expect(scriptExecuteRequest({ script_id: 100, parameters: {} }, [1], now)).toEqual(defaults);
  });
  it("maps parameters and preserves the friendly priorities", () => {
    for (const [priority, number] of [["high", 1], ["normal", 2], ["low", 3]] as const) {
      expect(scriptExecuteRequest({ script_id: 100, priority, parameters: { arg: "value" }, skip_offline: true, wake_offline: true }, [1], now)).toEqual({
        ...defaults, Priority: number, Parameters: [{ Key: "arg", Value: "value" }],
        OfflineActionFlags: { SkipsOfflineAgents: true, WakesOfflineAgents: true, OnlyRunsOnOfflineAgents: false },
      });
    }
  });
  it("preserves explicit builder fields and supports ScriptGuid", () => {
    const request = {
      EntityType: "Computer" as const, EntityIds: [2], ScriptGuid: "guid", Parameters: [], Priority: 0,
      OfflineActionFlags: { SkipsOfflineAgents: true, WakesOfflineAgents: true, OnlyRunsOnOfflineAgents: true },
      UseAgentTime: true, StartDate: "explicit", Schedule: { ScriptScheduleFrequency: { ScriptScheduleFrequencyId: 2 } },
      ExpireDate: "expiry", DistributionWindow: { Amount: 10 }, IncludeSubGroups: false,
    };
    expect(buildScriptExecuteBatchBody(request, now)).toEqual(request);
  });
  it("rejects invalid targets or script selectors like the SDK builder", () => {
    for (const EntityIds of [[], [0], [1.5]]) {
      expect(() => buildScriptExecuteBatchBody({ EntityIds, ScriptId: 1 })).toThrow();
    }
    expect(() => buildScriptExecuteBatchBody({ EntityIds: [1] })).toThrow();
    expect(() => buildScriptExecuteBatchBody({ EntityIds: [1], ScriptId: 1, ScriptGuid: "guid" })).toThrow();
  });
  it.each([
    { Message: "server detail" }, { message: "server detail" },
    { error_description: "server detail" }, { ExceptionMessage: "server detail" },
    { Errors: [{ Message: "server detail" }] }, { ModelState: { field: ["server detail"] } },
    "server detail",
  ])("extracts server message fields without serializing the response: %j", (response) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = scriptLaunchFailure("test", Object.assign(new Error("generic"), { statusCode: 500, response }), { script_id: 1 });
      expect(result?.isError).toBe(true);
      expect(JSON.parse(result!.content[0].text)).toMatchObject({ automate_message: "server detail", status_code: 500, launched: false });
      expect(log).toHaveBeenCalledTimes(1);
    } finally { log.mockRestore(); }
  });
  it("caps messages and handles named Automate errors without statusCode", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const error = Object.assign(new Error("x".repeat(600)), { name: "ConnectWiseAutomateServerError", response: { headers: { authorization: "private" } } });
      const result = scriptLaunchFailure("test", error, {});
      const data = JSON.parse(result!.content[0].text);
      expect(data.automate_message).toHaveLength(500);
      expect(data.status_code).toBeNull();
      expect(result!.content[0].text).not.toContain("private");
      expect(String(log.mock.calls)).not.toContain("private");
    } finally { log.mockRestore(); }
  });
  it("leaves generic and dropped connection failures to existing handling", () => {
    expect(scriptLaunchFailure("test", new Error("other"), {})).toBeUndefined();
    expect(scriptLaunchFailure("test", new TypeError("terminated"), {})).toBeUndefined();
  });
});
