/**
 * Tests for computers domain handler
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Create mock functions using vi.hoisted
const {
  mockComputersList,
  mockComputersGet,
  mockComputersRestart,
  mockScriptsRunAndWait,
  mockCommands,
  mockExecuteCommandAndWait,
  mockClient,
} = vi.hoisted(() => {
  const mockComputersList = vi.fn();
  const mockComputersGet = vi.fn();
  const mockComputersRestart = vi.fn();
  const mockScriptsRunAndWait = vi.fn();
  const mockCommands = vi.fn();
  const mockExecuteCommandAndWait = vi.fn();

  const mockClient = {
    computers: {
      list: mockComputersList,
      get: mockComputersGet,
      restart: mockComputersRestart,
      commands: mockCommands,
      executeCommandAndWait: mockExecuteCommandAndWait,
    },
    scripts: {
      runAndWait: mockScriptsRunAndWait,
    },
  };

  return {
    mockComputersList,
    mockComputersGet,
    mockComputersRestart,
    mockScriptsRunAndWait,
    mockCommands,
    mockExecuteCommandAndWait,
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
import { computersHandler } from "../../domains/computers.js";

describe("Computers Domain Handler", () => {
  beforeEach(() => {
    // Clear call history
    mockComputersList.mockClear();
    mockComputersGet.mockClear();
    mockComputersRestart.mockClear();
    mockScriptsRunAndWait.mockClear();
    mockCommands.mockClear();
    mockExecuteCommandAndWait.mockClear();

    // Reset mock implementations to the real API response shape:
    // Automate list endpoints return a bare JSON array (issue #35).
    mockComputersList.mockResolvedValue([
      { Id: 1, ComputerName: "Computer 1" },
      { Id: 2, ComputerName: "Computer 2" },
    ]);
    mockComputersGet.mockResolvedValue({
      Id: 1,
      ComputerName: "Computer 1",
      ClientId: 5,
    });
    mockComputersRestart.mockResolvedValue(undefined);
    mockScriptsRunAndWait.mockResolvedValue([
      {
        computerId: 1,
        launched: true,
        completed: true,
        state: "Success",
        waitedMs: 5000,
      },
    ]);
    mockCommands.mockResolvedValue([
      { Id: "2", Name: "Command Prompt", Level: 1 },
    ]);
    mockExecuteCommandAndWait.mockResolvedValue({
      completed: true,
      execution: { Id: 4711, Status: "Success" },
      history: { Id: 4711, DateFinished: "2024-01-15T10:35:04Z" },
      status: "Success",
      output: "Windows IP Configuration",
      waitedMs: 4000,
    });
  });

  describe("getTools", () => {
    it("should return all computer tools", () => {
      const tools = computersHandler.getTools();

      expect(tools.length).toBe(7);

      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain("cwautomate_computers_list");
      expect(toolNames).toContain("cwautomate_computers_get");
      expect(toolNames).toContain("cwautomate_computers_search");
      expect(toolNames).toContain("cwautomate_computers_reboot");
      expect(toolNames).toContain("cwautomate_computers_run_script");
      expect(toolNames).toContain("cwautomate_computers_run_command");
      expect(toolNames).toContain("cwautomate_commands_list");
    });

    it("cwautomate_computers_get should require computer_id", () => {
      const tools = computersHandler.getTools();
      const getTool = tools.find((t) => t.name === "cwautomate_computers_get");

      expect(getTool).toBeDefined();
      expect(getTool?.inputSchema.required).toContain("computer_id");
    });

    it("cwautomate_computers_search should require query", () => {
      const tools = computersHandler.getTools();
      const searchTool = tools.find(
        (t) => t.name === "cwautomate_computers_search"
      );

      expect(searchTool).toBeDefined();
      expect(searchTool?.inputSchema.required).toContain("query");
    });

    it("cwautomate_computers_reboot should require computer_id", () => {
      const tools = computersHandler.getTools();
      const rebootTool = tools.find(
        (t) => t.name === "cwautomate_computers_reboot"
      );

      expect(rebootTool).toBeDefined();
      expect(rebootTool?.inputSchema.required).toContain("computer_id");
    });

    it("cwautomate_computers_run_script should require computer_id and script_id", () => {
      const tools = computersHandler.getTools();
      const runScriptTool = tools.find(
        (t) => t.name === "cwautomate_computers_run_script"
      );

      expect(runScriptTool).toBeDefined();
      expect(runScriptTool?.inputSchema.required).toContain("computer_id");
      expect(runScriptTool?.inputSchema.required).toContain("script_id");
    });
  });

  describe("handleCall", () => {
    describe("cwautomate_computers_list", () => {
      it("should list computers with default parameters", async () => {
        const result = await computersHandler.handleCall(
          "cwautomate_computers_list",
          {}
        );

        expect(result.isError).toBeUndefined();
        expect(result.content[0].type).toBe("text");

        const data = JSON.parse(result.content[0].text);
        expect(data.total).toBe(2);
        expect(data.computers).toHaveLength(2);
      });

      it("should map filters and online status to the library params", async () => {
        await computersHandler.handleCall("cwautomate_computers_list", {
          client_id: 5,
          status: "online",
          limit: 10,
        });

        expect(mockComputersList).toHaveBeenCalledWith({
          clientId: 5,
          locationId: undefined,
          pageSize: 10,
          page: undefined,
          isOnline: true,
        });
      });
    });

    describe("cwautomate_computers_get", () => {
      it("should get a single computer", async () => {
        const result = await computersHandler.handleCall(
          "cwautomate_computers_get",
          {
            computer_id: 1,
          }
        );

        expect(result.isError).toBeUndefined();

        const data = JSON.parse(result.content[0].text);
        expect(data.Id).toBe(1);
        expect(data.ComputerName).toBe("Computer 1");
      });
    });

    describe("cwautomate_computers_search", () => {
      it("should search computers via a name condition", async () => {
        const result = await computersHandler.handleCall(
          "cwautomate_computers_search",
          {
            query: "Computer",
          }
        );

        expect(result.isError).toBeUndefined();

        const data = JSON.parse(result.content[0].text);
        expect(data.total).toBe(2);
        expect(data.computers).toHaveLength(2);

        expect(mockComputersList).toHaveBeenCalledWith({
          condition: "ComputerName like '%Computer%'",
          clientId: undefined,
          pageSize: 50,
        });
      });

      it("should pass search parameters to the list condition", async () => {
        await computersHandler.handleCall("cwautomate_computers_search", {
          query: "workstation",
          client_id: 5,
          limit: 25,
        });

        expect(mockComputersList).toHaveBeenCalledWith({
          condition: "ComputerName like '%workstation%'",
          clientId: 5,
          pageSize: 25,
        });
      });
    });

    describe("cwautomate_computers_reboot", () => {
      it("should reboot a computer via restart", async () => {
        const result = await computersHandler.handleCall(
          "cwautomate_computers_reboot",
          {
            computer_id: 1,
          }
        );

        expect(result.isError).toBeUndefined();

        const data = JSON.parse(result.content[0].text);
        expect(data.success).toBe(true);
        expect(data.message).toContain("Reboot command sent");
        expect(mockComputersRestart).toHaveBeenCalledWith(1, undefined);
      });

      it("should pass the force parameter to restart", async () => {
        await computersHandler.handleCall("cwautomate_computers_reboot", {
          computer_id: 1,
          force: true,
        });

        expect(mockComputersRestart).toHaveBeenCalledWith(1, true);
      });

      it("should retry exactly once on a transient network failure and still report success", async () => {
        mockComputersRestart
          .mockRejectedValueOnce(new TypeError("terminated"))
          .mockResolvedValueOnce(undefined);

        const result = await computersHandler.handleCall(
          "cwautomate_computers_reboot",
          { computer_id: 1 }
        );

        expect(result.isError).toBeUndefined();
        const data = JSON.parse(result.content[0].text);
        expect(data.success).toBe(true);
        expect(mockComputersRestart).toHaveBeenCalledTimes(2);
      });

      it("should surface a second consecutive transient network failure rather than retry forever", async () => {
        mockComputersRestart.mockRejectedValue(new TypeError("terminated"));

        // handleCall() doesn't itself catch-and-format errors into an
        // isError result — that's mcp-server.ts's job (the outer catch-all
        // that produces the "Error: terminated" text customers saw). At
        // this layer, a failure that survives the retry should simply
        // propagate so that wrapper can format it.
        await expect(
          computersHandler.handleCall("cwautomate_computers_reboot", {
            computer_id: 1,
          })
        ).rejects.toThrow("terminated");
        expect(mockComputersRestart).toHaveBeenCalledTimes(2);
      });

      it("should not retry (or mask) a non-network error", async () => {
        mockComputersRestart.mockRejectedValue(new Error("Access forbidden"));

        await expect(
          computersHandler.handleCall("cwautomate_computers_reboot", {
            computer_id: 1,
          })
        ).rejects.toThrow("Access forbidden");
        expect(mockComputersRestart).toHaveBeenCalledTimes(1);
      });
    });

    describe("cwautomate_computers_run_script", () => {
      it("should report the run's real outcome", async () => {
        const result = await computersHandler.handleCall(
          "cwautomate_computers_run_script",
          {
            computer_id: 1,
            script_id: 100,
          }
        );

        expect(result.isError).toBeUndefined();

        const data = JSON.parse(result.content[0].text);
        expect(data.completed).toBe(true);
        expect(data.state).toBe("Success");
        expect(mockScriptsRunAndWait).toHaveBeenCalledWith(
          [1],
          { ScriptId: 100, Parameters: undefined },
          { timeoutMs: 90000 }
        );
      });

      it("should report a failed run rather than a blanket success", async () => {
        mockScriptsRunAndWait.mockResolvedValue([
          {
            computerId: 1,
            launched: true,
            completed: true,
            state: "Failure",
            diagnosticMessage: "Script exited with code 1",
            waitedMs: 7000,
          },
        ]);

        const result = await computersHandler.handleCall(
          "cwautomate_computers_run_script",
          { computer_id: 1, script_id: 100 }
        );

        const data = JSON.parse(result.content[0].text);
        expect(data.state).toBe("Failure");
        expect(data.diagnostic_message).toBe("Script exited with code 1");
      });

      it("should convert parameters to Key/Value pairs", async () => {
        await computersHandler.handleCall("cwautomate_computers_run_script", {
          computer_id: 1,
          script_id: 100,
          parameters: { arg1: "value1" },
        });

        expect(mockScriptsRunAndWait).toHaveBeenCalledWith(
          [1],
          {
            ScriptId: 100,
            Parameters: [{ Key: "arg1", Value: "value1" }],
          },
          { timeoutMs: 90000 }
        );
      });

      it("should report a clear, honest result instead of a raw connection error when waiting is interrupted", async () => {
        mockScriptsRunAndWait.mockRejectedValue(new TypeError("terminated"));

        const result = await computersHandler.handleCall(
          "cwautomate_computers_run_script",
          { computer_id: 1, script_id: 100 }
        );

        expect(result.isError).toBeUndefined();
        const data = JSON.parse(result.content[0].text);
        expect(data.completed).toBe(false);
        expect(data.message).toContain("interrupted");
        expect(data.message).toContain("cwautomate_scripts_history");
      });

      it("should not swallow other errors as if they were a transient network failure", async () => {
        mockScriptsRunAndWait.mockRejectedValue(new Error("Validation error"));

        await expect(
          computersHandler.handleCall("cwautomate_computers_run_script", {
            computer_id: 1,
            script_id: 100,
          })
        ).rejects.toThrow("Validation error");
      });
    });

    describe("cwautomate_computers_run_command", () => {
      it("should send the command as a catalog reference and return its output", async () => {
        const result = await computersHandler.handleCall(
          "cwautomate_computers_run_command",
          {
            computer_id: 1,
            command_id: "2",
            parameters: ["ipconfig /all"],
          }
        );

        const data = JSON.parse(result.content[0].text);
        expect(data.completed).toBe(true);
        expect(data.output).toBe("Windows IP Configuration");
        expect(mockExecuteCommandAndWait).toHaveBeenCalledWith(
          1,
          { Command: { Id: "2" }, Parameters: ["ipconfig /all"] },
          { timeoutMs: 90000 }
        );
      });
    });

    describe("cwautomate_commands_list", () => {
      it("should list the command catalog", async () => {
        const result = await computersHandler.handleCall(
          "cwautomate_commands_list",
          {}
        );

        const data = JSON.parse(result.content[0].text);
        expect(data.total).toBe(1);
        expect(data.commands[0].Name).toBe("Command Prompt");
      });
    });

    describe("unknown tool", () => {
      it("should return error for unknown tool", async () => {
        const result = await computersHandler.handleCall(
          "cwautomate_computers_unknown",
          {}
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Unknown computer tool");
      });
    });
  });
});
