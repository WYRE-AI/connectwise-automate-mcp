/**
 * Tests for scripts domain handler
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConnectWiseAutomateAmbiguousRequestError } from "@wyre-ai/node-connectwise-automate";

// Create mock functions using vi.hoisted
const {
  mockScriptsList,
  mockScriptsGet,
  mockRunAndWait,
  mockExecuteBatch,
  mockHistoryForComputer,
  mockRunningOnComputer,
  mockClient,
} = vi.hoisted(() => {
  const mockScriptsList = vi.fn();
  const mockScriptsGet = vi.fn();
  const mockRunAndWait = vi.fn();
  const mockExecuteBatch = vi.fn();
  const mockHistoryForComputer = vi.fn();
  const mockRunningOnComputer = vi.fn();

  const mockClient = {
    scripts: {
      list: mockScriptsList,
      get: mockScriptsGet,
      runAndWait: mockRunAndWait,
      executeBatch: mockExecuteBatch,
      historyForComputer: mockHistoryForComputer,
      runningOnComputer: mockRunningOnComputer,
    },
  };

  return {
    mockScriptsList,
    mockScriptsGet,
    mockRunAndWait,
    mockExecuteBatch,
    mockHistoryForComputer,
    mockRunningOnComputer,
    mockClient,
  };
});

// Mock the client module before importing the handler
vi.mock("../../utils/client.js", () => ({
  getClient: () => Promise.resolve(mockClient),
  clearClient: vi.fn(),
  getCredentials: () => ({
    serverUrl: "https://automate.example.com",
    clientId: "test-client-id",
    username: "test-username",
    password: "test-password",
  }),
}));

// Import handler after mocking
import { scriptsHandler } from "../../domains/scripts.js";

// A failure the handler absorbs must leave exactly one line in the container
// logs (stderr); one it rethrows is logged by mcp-server.ts's catch-all
// instead, so the handler must stay silent to avoid a double entry.
const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

describe("Scripts Domain Handler", () => {
  beforeEach(() => {
    // Clear call history
    stderr.mockClear();
    mockScriptsList.mockClear();
    mockScriptsGet.mockClear();
    mockRunAndWait.mockClear();
    mockExecuteBatch.mockClear();
    mockHistoryForComputer.mockClear();
    mockRunningOnComputer.mockClear();

    // Reset mock implementations to the real API response shape:
    // Automate list endpoints return a bare JSON array (issue #35).
    // v1 `GET /Scripts` rows carry a string Id ...
    mockScriptsList.mockResolvedValue([
      { Id: "1", Name: "Script 1" },
      { Id: "2", Name: "Script 2" },
    ]);
    // ... and so does the v1 `GET /Scripts/{id}` row, which also carries the
    // parameter list. (The v2 ScriptDetail route is not served by every
    // hosted instance, so the tool no longer uses it.)
    // Default: no declared parameters, so execute tests keep the v2.0.6 body
    // behaviour unless a case overrides Parameters.
    mockScriptsGet.mockResolvedValue({
      Id: "1",
      Name: "Script 1",
      Comments: "Test script",
      Folder: { Id: "5", Name: "Maintenance" },
      Parameters: [],
    });
    mockRunAndWait.mockResolvedValue([]);
    let launchedScriptId: number | undefined;
    mockExecuteBatch.mockImplementation(async (request: { ScriptId: number }) => {
      launchedScriptId = request.ScriptId;
      return { ScriptResults: [], ContainsUnsuccessfulResults: false };
    });
    const historyCalls = new Map<number, number>();
    mockHistoryForComputer.mockImplementation(async (computerId: number) => {
      const n = (historyCalls.get(computerId) ?? 0) + 1;
      historyCalls.set(computerId, n);
      if (n === 1 || launchedScriptId === undefined) return [];
      return [
        {
          Id: 900 + computerId,
          ScriptId: launchedScriptId,
          Status: "Completed",
          State: "Success",
        },
      ];
    });
    mockRunningOnComputer.mockResolvedValue([]);
  });


  it.each([undefined, 999])("launches through executeBatch when script wait is %s", async (timeout_seconds) => {
    await scriptsHandler.handleCall("cwautomate_scripts_execute", { script_id: 100, computer_ids: [1], timeout_seconds });
    expect(mockExecuteBatch).toHaveBeenCalledTimes(1);
    expect(mockExecuteBatch.mock.calls[0][0]).toMatchObject({ ScriptId: 100, EntityIds: [1] });
  });

  it.each([true, false])("logs diagnostics and returns a structured isError for server errors (wait %s)", async (wait) => {
    const error = Object.assign(new Error("upstream"), { statusCode: 500, response: { password: "private", message: "Encountered unhandled exception" } });
    mockExecuteBatch.mockReset().mockRejectedValueOnce(error);
    const result = await scriptsHandler.handleCall("cwautomate_scripts_execute", {
      script_id: 100, computer_ids: [1], wait, parameters: { arg: "NEVER_LOG" },
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data).toMatchObject({ launched: "unknown", status_code: 500, script_id: 100, computer_ids: [1] });
    expect(data.automate_message).toBe("upstream");
    expect(stderr.mock.calls[0][0]).toContain("upstream 500 diagnostics");
    expect(stderr.mock.calls[0][0]).not.toContain("private");
    expect(stderr.mock.calls[0][0]).not.toContain("NEVER_LOG");
    expect(stderr.mock.calls.map(String).join("\n")).toContain("launch outcome unknown; this tool made no further launch attempt");
  });

  describe.each([true, false])("launch POST status classification (wait %s)", (wait) => {
    const launch = () =>
      scriptsHandler.handleCall("cwautomate_scripts_execute", { script_id: 101, computer_ids: [1, 2], wait });

    it.each([400, 401, 403, 404, 422])("reports HTTP %i as not launched", async (statusCode) => {
      mockExecuteBatch.mockReset().mockRejectedValueOnce(Object.assign(new Error("refused"), { statusCode }));
      const result = await launch();
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data).toMatchObject({ launched: false, status_code: statusCode, computer_ids: [1, 2] });
      expect(data.message).toContain("The script was not launched");
    });

    it.each([408, 500, 502, 503, 504])("reports HTTP %i as unknown, with do-not-relaunch guidance", async (statusCode) => {
      mockExecuteBatch.mockReset().mockRejectedValueOnce(Object.assign(new Error("upstream"), { statusCode }));
      const result = await launch();
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data).toMatchObject({ launched: "unknown", status_code: statusCode, computer_ids: [1, 2] });
      expect(data.message).not.toContain("was not launched");
      expect(data.message).toContain("may or may not have been launched");
      expect(data.message).toContain("cwautomate_scripts_history");
      expect(data.message).toContain("cwautomate_scripts_running");
      expect(data.message).toContain("Do not launch the script again");
    });

    it("reports a 2xx non-JSON reply (a raw error with no status) as unknown, not a thrown error", async () => {
      mockExecuteBatch.mockReset().mockRejectedValueOnce(new Error("Expected JSON but received text/html"));
      const result = await launch();
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.launched).toBe("unknown");
      expect(data).not.toHaveProperty("status_code");
      expect(data.message).toContain("Do not launch the script again");
    });
  });

  describe("getTools", () => {
    it("should return all script tools", () => {
      const tools = scriptsHandler.getTools();

      expect(tools.length).toBe(5);

      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain("cwautomate_scripts_history");
      expect(toolNames).toContain("cwautomate_scripts_running");
      expect(toolNames).toContain("cwautomate_scripts_list");
      expect(toolNames).toContain("cwautomate_scripts_get");
      expect(toolNames).toContain("cwautomate_scripts_execute");
    });

    it("cwautomate_scripts_get should require script_id", () => {
      const tools = scriptsHandler.getTools();
      const getTool = tools.find((t) => t.name === "cwautomate_scripts_get");

      expect(getTool).toBeDefined();
      expect(getTool?.inputSchema.required).toContain("script_id");
    });

    it("cwautomate_scripts_execute should require script_id and computer_ids", () => {
      const tools = scriptsHandler.getTools();
      const executeTool = tools.find(
        (t) => t.name === "cwautomate_scripts_execute"
      );

      expect(executeTool).toBeDefined();
      expect(executeTool?.inputSchema.required).toContain("script_id");
      expect(executeTool?.inputSchema.required).toContain("computer_ids");
    });
  });

  describe("handleCall", () => {
    describe("cwautomate_scripts_list", () => {
      it("should list scripts with default parameters", async () => {
        const result = await scriptsHandler.handleCall(
          "cwautomate_scripts_list",
          {}
        );

        expect(result.isError).toBeUndefined();
        expect(result.content[0].type).toBe("text");

        const data = JSON.parse(result.content[0].text);
        expect(data.total).toBe(2);
        expect(data.scripts).toHaveLength(2);
      });

      it("should map search to a Name condition, not a no-op name param", async () => {
        await scriptsHandler.handleCall("cwautomate_scripts_list", {
          search: "install",
          limit: 25,
        });

        // Automate only understands the generic `condition` expression on
        // list routes (see utils/odata.ts); a `name` query param is silently
        // ignored. Asserting `condition` here (and NOT `name`) is what
        // catches the regression where `search: "Reboot"` returned every
        // script unfiltered.
        expect(mockScriptsList).toHaveBeenCalledWith({
          condition: "Name like '%install%'",
          pageSize: 25,
          page: undefined,
        });
      });

      it("should fold folder_id into a Folder.Id condition, not a query param", async () => {
        await scriptsHandler.handleCall("cwautomate_scripts_list", {
          folder_id: 5,
        });

        // `folderId` was never a real Automate filter either; it now has to
        // travel through `condition` like everything else.
        expect(mockScriptsList).toHaveBeenCalledWith({
          condition: "Folder.Id = 5",
          pageSize: 50,
          page: undefined,
        });
      });

      it("should combine folder_id and search with and", async () => {
        await scriptsHandler.handleCall("cwautomate_scripts_list", {
          folder_id: 5,
          search: "install",
        });

        expect(mockScriptsList).toHaveBeenCalledWith({
          condition: "(Folder.Id = 5) and (Name like '%install%')",
          pageSize: 50,
          page: undefined,
        });
      });

      it("should omit the condition entirely when no filter is given", async () => {
        await scriptsHandler.handleCall("cwautomate_scripts_list", {});

        expect(mockScriptsList).toHaveBeenCalledWith({
          condition: undefined,
          pageSize: 50,
          page: undefined,
        });
      });

      it("should escape single quotes in the search term", async () => {
        await scriptsHandler.handleCall("cwautomate_scripts_list", {
          search: "O'Brien's script",
        });

        expect(mockScriptsList).toHaveBeenCalledWith(
          expect.objectContaining({
            condition: "Name like '%O''Brien''s script%'",
          })
        );
      });
    });

    describe("cwautomate_scripts_get", () => {
      it("should pass the v1 script row through with parsed parameter_details", async () => {
        mockScriptsGet.mockResolvedValue({
          Id: "1",
          Name: "Script 1",
          Comments: "Test script",
          Folder: { Id: "5", Name: "Maintenance" },
          Parameters: ["%reboot%", "ServiceName=Spooler", "retries:number=3"],
        });

        const result = await scriptsHandler.handleCall(
          "cwautomate_scripts_get",
          {
            script_id: 1,
          }
        );

        expect(result.isError).toBeUndefined();
        expect(mockScriptsGet).toHaveBeenCalledWith(1);

        const data = JSON.parse(result.content[0].text);
        expect(data.Id).toBe("1");
        expect(data.Name).toBe("Script 1");
        expect(data.Parameters).toEqual([
          "%reboot%",
          "ServiceName=Spooler",
          "retries:number=3",
        ]);
        expect(data.parameter_details).toEqual([
          {
            name: "reboot",
            raw: "%reboot%",
            required: true,
            type: "string",
          },
          {
            name: "ServiceName",
            raw: "ServiceName=Spooler",
            defaultValue: "Spooler",
            required: false,
            type: "string",
          },
          {
            name: "retries",
            raw: "retries:number=3",
            defaultValue: "3",
            required: false,
            type: "number",
          },
        ]);
        expect(data.Folder).toEqual({ Id: "5", Name: "Maintenance" });
      });
    });

    describe("cwautomate_scripts_execute", () => {
      it("should report the real per-computer outcome, not a blanket success", async () => {
        const historyCalls = new Map<number, number>();
        mockHistoryForComputer.mockImplementation(async (computerId: number) => {
          const n = (historyCalls.get(computerId) ?? 0) + 1;
          historyCalls.set(computerId, n);
          if (n === 1) return [];
          if (computerId === 1) {
            return [{ Id: 11, ScriptId: 1, Status: "Completed", State: "Success" }];
          }
          if (computerId === 2) {
            return [{
              Id: 12,
              ScriptId: 1,
              Status: "Completed",
              State: "Failure",
              DiagnosticMessage: "Script exited with code 1",
            }];
          }
          return [];
        });

        // The unfinished target waits one poll interval before the 1s
        // deadline passes; fake timers keep the test instant.
        vi.useFakeTimers();
        let result;
        try {
          const pending = scriptsHandler.handleCall(
            "cwautomate_scripts_execute",
            { script_id: 1, computer_ids: [1, 2, 3], timeout_seconds: 1 }
          );
          await vi.advanceTimersByTimeAsync(3_000);
          result = await pending;
        } finally {
          vi.useRealTimers();
        }

        expect(result.isError).toBeUndefined();

        const data = JSON.parse(result.content[0].text);
        expect(data.summary).toContain("1 succeeded");
        expect(data.summary).toContain("1 failed");
        expect(data.summary).toContain("1 still running");
        expect(data.runs[1].diagnostic_message).toBe(
          "Script exited with code 1"
        );
      });

      it("should surface a launch the server refused", async () => {
        mockExecuteBatch.mockReset().mockResolvedValue({
          ContainsUnsuccessfulResults: true,
          ScriptResults: [
            {
              EntityId: 9,
              ResultDetails: { ResultStatus: 1, Message: "Insufficient permissions" },
            },
          ],
        });

        const result = await scriptsHandler.handleCall(
          "cwautomate_scripts_execute",
          { script_id: 1, computer_ids: [9] }
        );

        const data = JSON.parse(result.content[0].text);
        expect(data.runs[0].launched).toBe(false);
        expect(data.runs[0].launch_message).toBe("Insufficient permissions");
        expect(data.summary).toContain("1 failed");
      });

      it("should map parameters to Key/Value pairs and priority to a number", async () => {
        await scriptsHandler.handleCall("cwautomate_scripts_execute", {
          script_id: 1,
          computer_ids: [1, 2],
          parameters: { arg1: "value1" },
          priority: "high",
          skip_offline: true,
        });

        expect(mockScriptsGet).toHaveBeenCalledWith(1);
        expect(mockExecuteBatch).toHaveBeenCalledWith({
            EntityType: "Computer",
            EntityIds: [1, 2],
            ScriptId: 1,
            Parameters: [{ Key: "arg1", Value: "value1" }],
            Priority: 1,
            OfflineActionFlags: {
              SkipsOfflineAgents: true,
              WakesOfflineAgents: false,
              OnlyRunsOnOfflineAgents: false,
            },
            UseAgentTime: false,
            StartDate: expect.stringMatching(/^\d{4}-/),
            Schedule: { ScriptScheduleFrequency: { ScriptScheduleFrequencyId: 1 } },
        });
      });

      it("sends a full default ScriptExecute body when priority and flags are omitted", async () => {
        await scriptsHandler.handleCall("cwautomate_scripts_execute", {
          script_id: 101,
          computer_ids: [99],
        });
        expect(mockScriptsGet).toHaveBeenCalledWith(101);
        expect(mockExecuteBatch).toHaveBeenCalledWith({
            EntityType: "Computer",
            EntityIds: [99],
            ScriptId: 101,
            Parameters: [],
            Priority: 2,
            OfflineActionFlags: {
              SkipsOfflineAgents: false,
              WakesOfflineAgents: false,
              OnlyRunsOnOfflineAgents: false,
            },
            UseAgentTime: false,
            StartDate: expect.stringMatching(/^\d{4}-/),
            Schedule: { ScriptScheduleFrequency: { ScriptScheduleFrequencyId: 1 } },
        });
      });

      it("fills declared parameter defaults and always sends the full declared set", async () => {
        mockScriptsGet.mockResolvedValue({
          Id: "1",
          Name: "Restart Service",
          Parameters: ["ServiceName=Spooler", "Force=false"],
        });

        await scriptsHandler.handleCall("cwautomate_scripts_execute", {
          script_id: 1,
          computer_ids: [1],
          parameters: { ServiceName: "WinRM" },
          wait: false,
        });

        expect(mockExecuteBatch).toHaveBeenCalledWith(
          expect.objectContaining({
            ScriptId: 1,
            Parameters: [
              { Key: "ServiceName", Value: "WinRM" },
              { Key: "Force", Value: "false" },
            ],
          })
        );
      });

      it("reports a failed parameter lookup as not launched, not launch-ambiguous", async () => {
        mockScriptsGet.mockRejectedValue(
          Object.assign(new TypeError("terminated"), { cause: undefined })
        );

        const result = await scriptsHandler.handleCall(
          "cwautomate_scripts_execute",
          { script_id: 1, computer_ids: [1] }
        );

        expect(result.isError).toBe(true);
        expect(mockExecuteBatch).not.toHaveBeenCalled();
        const data = JSON.parse(result.content[0].text);
        expect(data).toMatchObject({
          script_id: 1,
          launched: false,
        });
        expect(data.message).toContain("declared parameters");
        expect(data.message).toContain("was not launched");
        expect(data.message).not.toContain("may or may not");
        expect(data.interrupted).toBeUndefined();
        expect(stderr).toHaveBeenCalled();
      });

      it("returns a clear isError naming missing required parameters without launching", async () => {
        mockScriptsGet.mockResolvedValue({
          Id: "1",
          Name: "Restart Service",
          Parameters: ["ServiceName", "Timeout:number=30", "%path%"],
        });

        const result = await scriptsHandler.handleCall(
          "cwautomate_scripts_execute",
          { script_id: 1, computer_ids: [1], parameters: { Timeout: "60" } }
        );

        expect(result.isError).toBe(true);
        expect(mockExecuteBatch).not.toHaveBeenCalled();
        const data = JSON.parse(result.content[0].text);
        expect(data).toMatchObject({
          script_id: 1,
          launched: false,
        });
        expect(data.missing_parameters).toEqual([
          expect.objectContaining({
            name: "ServiceName",
            type: "string",
            required: true,
          }),
          expect.objectContaining({
            name: "path",
            type: "string",
            required: true,
            raw: "%path%",
          }),
        ]);
        expect(data.declared_parameters).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "Timeout",
              type: "number",
              required: false,
              defaultValue: "30",
            }),
          ])
        );
        expect(data.message).toContain("ServiceName");
        expect(data.message).toContain("path");
        expect(data.message).toContain("cwautomate_scripts_get");
        expect(data.message).toContain("was not launched");
      });

      it("returns a structured isError result with an unknown outcome when the launch gets HTTP 500", async () => {
        const error = Object.assign(new Error("Server error: 500 Internal Server Error: Encountered unhandled exception."), {
          name: "ConnectWiseAutomateServerError",
          statusCode: 500,
        });
        mockExecuteBatch.mockReset().mockRejectedValue(error);
        const result = await scriptsHandler.handleCall("cwautomate_scripts_execute", {
          script_id: 101,
          computer_ids: [99],
        });
        expect(result.isError).toBe(true);
        const data = JSON.parse(result.content[0].text);
        expect(data).toMatchObject({
          script_id: 101,
          computer_ids: [99],
          launched: "unknown",
          status_code: 500,
        });
        expect(data.automate_message).toContain("Encountered unhandled exception.");
        expect(data.message).toContain("Do not launch the script again");
        expect(stderr).toHaveBeenCalled();
        expect(mockExecuteBatch).toHaveBeenCalledTimes(1);
      });

      it("keeps the launched/do-not-relaunch result and other targets when a poll fails with a non-HTTP error", async () => {
        const polled = new Set<number>();
        mockHistoryForComputer.mockReset().mockImplementation(async (computerId: number) => {
          if (!polled.has(computerId)) {
            polled.add(computerId);
            return [];
          }
          if (computerId === 98) throw new Error("Expected JSON but received text/html");
          return [{ Id: 5, ScriptId: 101, Status: "Completed", State: "Success" }];
        });
        const result = await scriptsHandler.handleCall("cwautomate_scripts_execute", {
          script_id: 101,
          computer_ids: [98, 99],
        });
        expect(result.isError).toBe(true);
        const data = JSON.parse(result.content[0].text);
        expect(data.runs).toEqual([
          expect.objectContaining({
            computer_id: 98,
            launched: true,
            completed: false,
            poll_failure: expect.objectContaining({ automate_message: "Expected JSON but received text/html" }),
          }),
          expect.objectContaining({ computer_id: 99, launched: true, completed: true, state: "Success" }),
        ]);
        expect(data.message).toContain("Do not launch the script again");
        expect(data.message).toContain("cwautomate_scripts_running");
        expect(mockExecuteBatch).toHaveBeenCalledTimes(1);
      });

      it("tells the caller not to relaunch when the wait ends with the script still running", async () => {
        const result = await scriptsHandler.handleCall("cwautomate_scripts_execute", {
          script_id: 101,
          computer_ids: [99],
          timeout_seconds: 0,
        });
        expect(result.isError).toBeUndefined();
        const data = JSON.parse(result.content[0].text);
        expect(data.message).toContain("Do not launch the script again");
        expect(data.message).toContain("cwautomate_scripts_history");
        expect(data.message).toContain("cwautomate_scripts_running");
      });

      it("does not report launched:false when the launch POST succeeds and history polling fails", async () => {
        const error = Object.assign(new Error("Server error: 500 Internal Server Error: history failed"), {
          name: "ConnectWiseAutomateServerError",
          statusCode: 500,
        });
        const historyCalls = new Map<number, number>();
        mockHistoryForComputer.mockImplementation(async (computerId: number) => {
          const n = (historyCalls.get(computerId) ?? 0) + 1;
          historyCalls.set(computerId, n);
          if (n === 1) return [];
          throw error;
        });
        const result = await scriptsHandler.handleCall("cwautomate_scripts_execute", {
          script_id: 101,
          computer_ids: [99],
        });
        expect(mockExecuteBatch).toHaveBeenCalledTimes(1);
        expect(result.isError).toBe(true);
        const data = JSON.parse(result.content[0].text);
        expect(data.launched).toBeUndefined();
        expect(data.runs).toEqual([
          expect.objectContaining({
            computer_id: 99,
            launched: true,
            completed: false,
            poll_failure: expect.objectContaining({ status_code: 500 }),
          }),
        ]);
        expect(data.message).toContain("Do not launch the script again");
        expect(data.message).toContain("cwautomate_scripts_history");
      });

      it("returns a pre-launch history failure as not launched, not as an Automate rejection", async () => {
        const error = Object.assign(new Error("Server error: 500 Internal Server Error: history failed"), {
          name: "ConnectWiseAutomateServerError",
          statusCode: 500,
        });
        mockHistoryForComputer.mockReset().mockRejectedValue(error);
        const result = await scriptsHandler.handleCall("cwautomate_scripts_execute", {
          script_id: 101,
          computer_ids: [99],
        });
        expect(mockExecuteBatch).not.toHaveBeenCalled();
        expect(result.isError).toBe(true);
        const data = JSON.parse(result.content[0].text);
        expect(data).toMatchObject({ launched: false, status_code: 500 });
        expect(data.message).toContain("before launch");
        expect(data.message).not.toContain("Rejected by Automate");
      });

      it("keeps a launch refusal when another target's history poll fails", async () => {
        const error = Object.assign(new Error("history failed"), { statusCode: 500 });
        const polled = new Set<number>();
        mockHistoryForComputer.mockReset().mockImplementation(async (computerId: number) => {
          if (!polled.has(computerId)) {
            polled.add(computerId);
            return [];
          }
          throw error;
        });
        mockExecuteBatch.mockReset().mockResolvedValue({
          ContainsUnsuccessfulResults: true,
          ScriptResults: [{ EntityId: 98, ResultDetails: { ResultStatus: 1, Message: "Insufficient permissions" } }],
        });
        const result = await scriptsHandler.handleCall("cwautomate_scripts_execute", {
          script_id: 101,
          computer_ids: [98, 99],
        });
        const data = JSON.parse(result.content[0].text);
        expect(data.runs).toEqual([
          expect.objectContaining({ computer_id: 98, launched: false, launch_message: "Insufficient permissions" }),
          expect.objectContaining({ computer_id: 99, launched: true, completed: false, poll_failure: expect.objectContaining({ status_code: 500 }) }),
        ]);
      });

      it("makes no history request after the launch when timeout_seconds is 0", async () => {
        const result = await scriptsHandler.handleCall("cwautomate_scripts_execute", {
          script_id: 101,
          computer_ids: [99],
          timeout_seconds: 0,
        });
        expect(mockExecuteBatch).toHaveBeenCalledTimes(1);
        expect(mockHistoryForComputer).toHaveBeenCalledTimes(1);
        expect(result.isError).toBeUndefined();
        expect(JSON.parse(result.content[0].text).runs[0]).toMatchObject({ launched: true, completed: false });
      });

      it("should launch without polling when wait is false", async () => {
        mockExecuteBatch.mockResolvedValue({
          ScriptResults: [{ EntityId: 1 }],
          ContainsUnsuccessfulResults: false,
        });

        const result = await scriptsHandler.handleCall(
          "cwautomate_scripts_execute",
          { script_id: 1, computer_ids: [1], wait: false }
        );

        const data = JSON.parse(result.content[0].text);
        expect(data.waited).toBe(false);
        expect(mockHistoryForComputer).not.toHaveBeenCalled();
        expect(mockExecuteBatch).toHaveBeenCalled();
      });

      it("should report a clear, honest result instead of a raw connection error when waiting is interrupted", async () => {
        mockExecuteBatch.mockReset().mockRejectedValue(new TypeError("terminated"));

        const result = await scriptsHandler.handleCall(
          "cwautomate_scripts_execute",
          { script_id: 1, computer_ids: [1, 2] }
        );

        expect(result.isError).toBeUndefined();
        const data = JSON.parse(result.content[0].text);
        expect(data.summary).toContain("interrupted");
        expect(data.summary).toContain("cwautomate_scripts_history");
        expect(data.computer_ids).toEqual([1, 2]);

        expect(stderr).toHaveBeenCalledTimes(1);
        expect(stderr.mock.calls[0][0]).toMatch(
          /^\[MCP\] tool cwautomate_scripts_execute failed: TypeError: terminated \(connection to ConnectWise Automate terminated/
        );
      });

      it("does not treat another error as a transient network failure, and does not claim it was not launched", async () => {
        mockExecuteBatch.mockReset().mockRejectedValue(new Error("Validation error"));

        const result = await scriptsHandler.handleCall("cwautomate_scripts_execute", {
          script_id: 1,
          computer_ids: [1],
        });
        expect(result.isError).toBe(true);
        const data = JSON.parse(result.content[0].text);
        expect(data.launched).toBe("unknown");
        expect(data.message).not.toContain("was not launched");
        expect(data.interrupted).toBeUndefined();
        expect(mockExecuteBatch).toHaveBeenCalledTimes(1);
      });

      it("does not retry POST /Batch/ScriptExecute when the launch is ambiguous", async () => {
        mockExecuteBatch.mockRejectedValue(
          new ConnectWiseAutomateAmbiguousRequestError(
            "Connection interrupted during POST /cwa/api/v1/Batch/ScriptExecute. The command may or may not have been queued (script id 1, entity ids 1). The request was not retried because a retry can run it twice.",
            { cause: new TypeError("terminated"), id: 77 }
          )
        );

        const result = await scriptsHandler.handleCall(
          "cwautomate_scripts_execute",
          { script_id: 1, computer_ids: [1], wait: false }
        );

        expect(result.isError).toBeUndefined();
        expect(mockExecuteBatch).toHaveBeenCalledTimes(1);
        const data = JSON.parse(result.content[0].text);
        expect(data.waited).toBe(false);
        expect(data.completed).toBe(false);
        expect(data.ambiguous).toBe(true);
        expect(data.interrupted).toBe(true);
        expect(data.execution_id).toBe(77);
        expect(data.computer_ids).toEqual([1]);
        expect(data.message).toContain("may or may not have been queued");
        expect(data.message).toContain("not retried");
        expect(data.message).toContain("cwautomate_scripts_history");
        expect(stderr).toHaveBeenCalledTimes(1);
      });

      it("does not retry a raw socket error on a fire-and-forget launch", async () => {
        mockExecuteBatch.mockRejectedValue(new TypeError("terminated"));

        const result = await scriptsHandler.handleCall(
          "cwautomate_scripts_execute",
          { script_id: 1, computer_ids: [1], wait: false }
        );

        expect(result.isError).toBeUndefined();
        expect(mockExecuteBatch).toHaveBeenCalledTimes(1);
        const data = JSON.parse(result.content[0].text);
        expect(data.ambiguous).toBe(true);
        expect(data.message).toContain("interrupted");
        expect(data.message).toContain("not retried");
        expect(data.message).toContain("twice");
      });

      it("reports a non-network error on a fire-and-forget launch as an unknown outcome, not a throw", async () => {
        mockExecuteBatch.mockRejectedValue(new Error("Validation error"));

        const result = await scriptsHandler.handleCall("cwautomate_scripts_execute", {
          script_id: 1,
          computer_ids: [1],
          wait: false,
        });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text).launched).toBe("unknown");
        expect(mockExecuteBatch).toHaveBeenCalledTimes(1);
      });
    });

    describe("cwautomate_scripts_history", () => {
      it("should return the bare array the API sends", async () => {
        mockHistoryForComputer.mockResolvedValue([
          { Id: 1, ScriptId: 5, State: "Success" },
        ]);

        const result = await scriptsHandler.handleCall(
          "cwautomate_scripts_history",
          { computer_id: 7 }
        );

        const data = JSON.parse(result.content[0].text);
        expect(data.total).toBe(1);
        expect(data.history[0].State).toBe("Success");
        expect(mockHistoryForComputer).toHaveBeenCalledWith(7, {
          pageSize: 50,
        });
      });
    });

    describe("unknown tool", () => {
      it("should return error for unknown tool", async () => {
        const result = await scriptsHandler.handleCall(
          "cwautomate_scripts_unknown",
          {}
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Unknown script tool");
      });
    });
  });
});
