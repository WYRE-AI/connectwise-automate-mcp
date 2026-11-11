import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCRIPT_PRIORITY,
  SCRIPT_SCHEDULE_FREQUENCY_ONCE,
  SCRIPT_HISTORY_WINDOW,
  automateMessage,
  buildScriptExecuteBatchBody,
  isAutomateApiError,
  runScriptsAndWait,
  toParameterPairs,
  toPriority,
} from "../utils/script-execute.js";

const now = new Date("2026-01-01T00:00:00.000Z");

describe("buildScriptExecuteBatchBody", () => {
  it("serializes the documented run-now defaults", () => {
    expect(buildScriptExecuteBatchBody({ scriptId: 101, computerIds: [10], now })).toEqual({
      EntityType: "Computer",
      EntityIds: [10],
      ScriptId: 101,
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
      scriptId: 202,
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

describe("runScriptsAndWait", () => {
  const request = buildScriptExecuteBatchBody({
    scriptId: 101,
    computerIds: [10],
    now: new Date("2026-01-01T00:00:00.000Z"),
  });

  it("throws phase launch when the ScriptExecute POST is rejected", async () => {
    const error = Object.assign(new Error("Encountered unhandled exception."), { statusCode: 500 });
    const scripts = {
      historyForComputer: async () => [],
      executeBatch: async () => {
        throw error;
      },
    };
    await expect(runScriptsAndWait(scripts, request, { timeoutMs: 0 })).rejects.toMatchObject({
      name: "ScriptWaitError",
      phase: "launch",
      cause: error,
    });
  });

  it("throws phase baseline, without launching, when the pre-launch history read fails", async () => {
    const error = Object.assign(new Error("history failed"), { statusCode: 500 });
    let launched = false;
    const scripts = {
      historyForComputer: async () => {
        throw error;
      },
      executeBatch: async () => {
        launched = true;
        return { ScriptResults: [], ContainsUnsuccessfulResults: false };
      },
    };
    await expect(runScriptsAndWait(scripts, request, { timeoutMs: 20_000 })).rejects.toMatchObject({
      name: "ScriptWaitError",
      phase: "baseline",
      cause: error,
    });
    expect(launched).toBe(false);
  });

  it("keeps an Automate poll error on the target when the launch POST succeeded", async () => {
    const error = Object.assign(new Error("history failed"), { statusCode: 500 });
    let historyCalls = 0;
    const scripts = {
      historyForComputer: async () => {
        historyCalls += 1;
        if (historyCalls === 1) return [];
        throw error;
      },
      executeBatch: async () => ({ ScriptResults: [], ContainsUnsuccessfulResults: false }),
    };
    const results = await runScriptsAndWait(scripts, request, { timeoutMs: 20_000 });
    expect(results).toEqual([
      expect.objectContaining({
        computerId: 10,
        launched: true,
        completed: false,
        pollFailure: { statusCode: 500, message: "history failed" },
      }),
    ]);
  });

  it("does not let one target's poll failure hide another target's launch refusal", async () => {
    const error = Object.assign(new Error("history failed"), { statusCode: 500 });
    const polled = new Set<number>();
    const scripts = {
      historyForComputer: async (computerId: number) => {
        if (!polled.has(computerId)) {
          polled.add(computerId);
          return [];
        }
        throw error;
      },
      executeBatch: async () => ({
        ContainsUnsuccessfulResults: true,
        ScriptResults: [
          { EntityId: 10, ResultDetails: { ResultStatus: 1, Message: "Insufficient permissions" } },
        ],
      }),
    };
    const results = await runScriptsAndWait(
      scripts,
      buildScriptExecuteBatchBody({ scriptId: 101, computerIds: [10, 11] }),
      { timeoutMs: 20_000 }
    );
    expect(results).toEqual([
      expect.objectContaining({ computerId: 10, launched: false, launchMessage: "Insufficient permissions" }),
      expect.objectContaining({ computerId: 11, launched: true, completed: false, pollFailure: expect.objectContaining({ statusCode: 500 }) }),
    ]);
  });

  it("throws phase poll for a poll error that is neither transient nor an Automate HTTP error", async () => {
    const error = new Error("unexpected");
    let historyCalls = 0;
    const scripts = {
      historyForComputer: async () => {
        historyCalls += 1;
        if (historyCalls === 1) return [];
        throw error;
      },
      executeBatch: async () => ({ ScriptResults: [], ContainsUnsuccessfulResults: false }),
    };
    await expect(runScriptsAndWait(scripts, request, { timeoutMs: 20_000 })).rejects.toMatchObject({
      name: "ScriptWaitError",
      phase: "poll",
      cause: error,
    });
  });

  it("makes no history request after the launch when the timeout is zero", async () => {
    let historyCalls = 0;
    const scripts = {
      historyForComputer: async () => {
        historyCalls += 1;
        if (historyCalls > 1) throw new Error("must not poll");
        return [];
      },
      executeBatch: async () => ({ ScriptResults: [], ContainsUnsuccessfulResults: false }),
    };
    const results = await runScriptsAndWait(scripts, request, { timeoutMs: 0 });
    expect(results).toEqual([
      expect.objectContaining({ computerId: 10, launched: true, completed: false, pollErrors: 0 }),
    ]);
    expect(results[0].pollFailure).toBeUndefined();
    expect(historyCalls).toBe(1);
  });

  it("returns a completed run from the first post-launch history poll", async () => {
    let historyCalls = 0;
    const scripts = {
      historyForComputer: async (computerId: number, params?: { orderBy?: string; pageSize?: number }) => {
        expect(params).toEqual(SCRIPT_HISTORY_WINDOW);
        historyCalls += 1;
        if (historyCalls === 1) return [];
        return [
          {
            Id: 44,
            ScriptId: 101,
            Status: "Completed",
            State: "Success",
            DiagnosticMessage: "ok",
          },
        ];
      },
      executeBatch: async (body: { ScriptId: number; EntityIds: number[] }) => {
        expect(body.ScriptId).toBe(101);
        expect(body.EntityIds).toEqual([10]);
        return { ScriptResults: [], ContainsUnsuccessfulResults: false };
      },
    };
    const results = await runScriptsAndWait(scripts, request, { timeoutMs: 20_000 });
    expect(results).toEqual([
      expect.objectContaining({
        computerId: 10,
        launched: true,
        completed: true,
        state: "Success",
        diagnosticMessage: "ok",
      }),
    ]);
  });

  it("surfaces a per-target refusal from ContainsUnsuccessfulResults without polling", async () => {
    let historyCalls = 0;
    const scripts = {
      historyForComputer: async () => {
        historyCalls += 1;
        return [];
      },
      executeBatch: async () => ({
        ContainsUnsuccessfulResults: true,
        ScriptResults: [
          {
            EntityId: 10,
            ResultDetails: { ResultStatus: 1, Message: "Insufficient permissions" },
          },
        ],
      }),
    };
    const results = await runScriptsAndWait(scripts, request, { timeoutMs: 20_000 });
    expect(results).toEqual([
      {
        computerId: 10,
        launched: false,
        launchMessage: "Insufficient permissions",
        completed: false,
        waitedMs: 0,
        pollErrors: 0,
      },
    ]);
    expect(historyCalls).toBe(1);
  });
});
