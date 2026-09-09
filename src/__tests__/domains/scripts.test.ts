/**
 * Tests for scripts domain handler
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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

describe("Scripts Domain Handler", () => {
  beforeEach(() => {
    // Clear call history
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
    // ... while `GET /api/v2/Scripts/{id}` returns the ScriptDetail contract,
    // keyed by a numeric ScriptId and including the parameter list.
    mockScriptsGet.mockResolvedValue({
      ScriptId: 1,
      Name: "Script 1",
      Description: "Test script",
      Folder: { ScriptFolderId: 5, Name: "Maintenance" },
      Parameters: ["%reboot%", "%delay%"],
    });
    mockRunAndWait.mockResolvedValue([]);
    mockExecuteBatch.mockResolvedValue({
      ScriptResults: [],
      ContainsUnsuccessfulResults: false,
    });
    mockHistoryForComputer.mockResolvedValue([]);
    mockRunningOnComputer.mockResolvedValue([]);
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
      it("should pass the v2 ScriptDetail through, parameters included", async () => {
        const result = await scriptsHandler.handleCall(
          "cwautomate_scripts_get",
          {
            script_id: 1,
          }
        );

        expect(result.isError).toBeUndefined();
        expect(mockScriptsGet).toHaveBeenCalledWith(1);

        const data = JSON.parse(result.content[0].text);
        expect(data.ScriptId).toBe(1);
        expect(data.Name).toBe("Script 1");
        expect(data.Parameters).toEqual(["%reboot%", "%delay%"]);
        expect(data.Folder).toEqual({ ScriptFolderId: 5, Name: "Maintenance" });
      });
    });

    describe("cwautomate_scripts_execute", () => {
      it("should report the real per-computer outcome, not a blanket success", async () => {
        mockRunAndWait.mockResolvedValue([
          {
            computerId: 1,
            launched: true,
            completed: true,
            state: "Success",
            waitedMs: 6000,
          },
          {
            computerId: 2,
            launched: true,
            completed: true,
            state: "Failure",
            diagnosticMessage: "Script exited with code 1",
            waitedMs: 8000,
          },
          {
            computerId: 3,
            launched: true,
            completed: false,
            waitedMs: 90000,
          },
        ]);

        const result = await scriptsHandler.handleCall(
          "cwautomate_scripts_execute",
          { script_id: 1, computer_ids: [1, 2, 3] }
        );

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
        mockRunAndWait.mockResolvedValue([
          {
            computerId: 9,
            launched: false,
            launchMessage: "Insufficient permissions",
            completed: false,
            waitedMs: 0,
          },
        ]);

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
        mockRunAndWait.mockResolvedValue([]);

        await scriptsHandler.handleCall("cwautomate_scripts_execute", {
          script_id: 1,
          computer_ids: [1, 2],
          parameters: { arg1: "value1" },
          priority: "high",
          skip_offline: true,
        });

        expect(mockRunAndWait).toHaveBeenCalledWith(
          [1, 2],
          {
            ScriptId: 1,
            Parameters: [{ Key: "arg1", Value: "value1" }],
            Priority: 1,
            OfflineActionFlags: {
              SkipsOfflineAgents: true,
              WakesOfflineAgents: undefined,
            },
          },
          { timeoutMs: 90000 }
        );
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
        expect(mockRunAndWait).not.toHaveBeenCalled();
        expect(mockExecuteBatch).toHaveBeenCalled();
      });

      it("should report a clear, honest result instead of a raw connection error when waiting is interrupted", async () => {
        mockRunAndWait.mockRejectedValue(new TypeError("terminated"));

        const result = await scriptsHandler.handleCall(
          "cwautomate_scripts_execute",
          { script_id: 1, computer_ids: [1, 2] }
        );

        expect(result.isError).toBeUndefined();
        const data = JSON.parse(result.content[0].text);
        expect(data.summary).toContain("interrupted");
        expect(data.summary).toContain("cwautomate_scripts_history");
        expect(data.computer_ids).toEqual([1, 2]);
      });

      it("should not swallow other errors as if they were a transient network failure", async () => {
        mockRunAndWait.mockRejectedValue(new Error("Validation error"));

        await expect(
          scriptsHandler.handleCall("cwautomate_scripts_execute", {
            script_id: 1,
            computer_ids: [1],
          })
        ).rejects.toThrow("Validation error");
      });

      it("should retry the launch exactly once on a transient network failure when wait is false", async () => {
        mockExecuteBatch
          .mockRejectedValueOnce(new TypeError("terminated"))
          .mockResolvedValueOnce({
            ScriptResults: [{ EntityId: 1 }],
            ContainsUnsuccessfulResults: false,
          });

        const result = await scriptsHandler.handleCall(
          "cwautomate_scripts_execute",
          { script_id: 1, computer_ids: [1], wait: false }
        );

        expect(result.isError).toBeUndefined();
        const data = JSON.parse(result.content[0].text);
        expect(data.waited).toBe(false);
        expect(mockExecuteBatch).toHaveBeenCalledTimes(2);
      });

      it("should surface a second consecutive transient network failure when wait is false", async () => {
        mockExecuteBatch.mockRejectedValue(new TypeError("terminated"));

        await expect(
          scriptsHandler.handleCall("cwautomate_scripts_execute", {
            script_id: 1,
            computer_ids: [1],
            wait: false,
          })
        ).rejects.toThrow("terminated");
        expect(mockExecuteBatch).toHaveBeenCalledTimes(2);
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
