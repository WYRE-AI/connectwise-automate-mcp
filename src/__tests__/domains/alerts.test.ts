/**
 * Tests for alerts domain handler
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Create mock functions using vi.hoisted
const { mockAlertsList, mockAlertsListForComputer, mockAlertsGet, mockClient } =
  vi.hoisted(() => {
    const mockAlertsList = vi.fn();
    const mockAlertsListForComputer = vi.fn();
    const mockAlertsGet = vi.fn();

    const mockClient = {
      alerts: {
        list: mockAlertsList,
        listForComputer: mockAlertsListForComputer,
        get: mockAlertsGet,
      },
    };

    return {
      mockAlertsList,
      mockAlertsListForComputer,
      mockAlertsGet,
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
import { alertsHandler } from "../../domains/alerts.js";

// Alert rows as the Automate API serves them: keyed by AlertId, with the
// client/computer/severity as nested { Id, Name } references.
const alertRows = [
  {
    AlertId: 1,
    Message: "Disk space low",
    Severity: { Id: 3, Name: "Warning" },
    Computer: { Id: 5, Name: "WS-01" },
    Client: { Id: 10, Name: "Acme" },
  },
  {
    AlertId: 2,
    Message: "Service stopped",
    Severity: { Id: 1, Name: "Critical" },
    Computer: { Id: 6, Name: "WS-02" },
    Client: { Id: 10, Name: "Acme" },
  },
];

describe("Alerts Domain Handler", () => {
  beforeEach(() => {
    // Clear call history
    mockAlertsList.mockClear();
    mockAlertsListForComputer.mockClear();
    mockAlertsGet.mockClear();

    // Reset mock implementations to the real API response shape:
    // Automate list endpoints return a bare JSON array (issue #35).
    mockAlertsList.mockResolvedValue(alertRows);
    mockAlertsListForComputer.mockResolvedValue([alertRows[0]]);
    mockAlertsGet.mockResolvedValue(alertRows[0]);
  });

  describe("getTools", () => {
    it("should expose only the read-only alert tools the API supports", () => {
      const tools = alertsHandler.getTools();

      expect(tools.length).toBe(2);

      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain("cwautomate_alerts_list");
      expect(toolNames).toContain("cwautomate_alerts_get");
      // Automate has no acknowledge/close route; the tool must not exist.
      expect(toolNames).not.toContain("cwautomate_alerts_acknowledge");
    });

    it("cwautomate_alerts_list should not offer a status filter", () => {
      const tools = alertsHandler.getTools();
      const listTool = tools.find((t) => t.name === "cwautomate_alerts_list");

      expect(listTool).toBeDefined();
      // Alerts carry no status field in the Automate API.
      expect(listTool?.inputSchema.properties).not.toHaveProperty("status");
    });

    it("cwautomate_alerts_get should require alert_id", () => {
      const tools = alertsHandler.getTools();
      const getTool = tools.find((t) => t.name === "cwautomate_alerts_get");

      expect(getTool).toBeDefined();
      expect(getTool?.inputSchema.required).toContain("alert_id");
    });
  });

  describe("handleCall", () => {
    describe("cwautomate_alerts_list", () => {
      it("should list alerts with default parameters", async () => {
        const result = await alertsHandler.handleCall(
          "cwautomate_alerts_list",
          {}
        );

        expect(result.isError).toBeUndefined();
        expect(result.content[0].type).toBe("text");

        const data = JSON.parse(result.content[0].text);
        expect(data.total).toBe(2);
        expect(data.alerts).toHaveLength(2);
        expect(mockAlertsList).toHaveBeenCalledWith({
          condition: undefined,
          pageSize: 50,
          page: undefined,
        });
      });

      it("should translate skip/limit to page/pageSize", async () => {
        await alertsHandler.handleCall("cwautomate_alerts_list", {
          limit: 10,
          skip: 20,
        });

        expect(mockAlertsList).toHaveBeenCalledWith({
          condition: undefined,
          pageSize: 10,
          page: 3,
        });
      });

      it("should use the per-computer alerts route for computer_id", async () => {
        const result = await alertsHandler.handleCall(
          "cwautomate_alerts_list",
          { computer_id: 5, limit: 25 }
        );

        expect(mockAlertsListForComputer).toHaveBeenCalledWith(5, {
          condition: undefined,
          pageSize: 25,
          page: undefined,
        });
        expect(mockAlertsList).not.toHaveBeenCalled();

        const data = JSON.parse(result.content[0].text);
        expect(data.total).toBe(1);
        expect(data.alerts[0].AlertId).toBe(1);
      });

      it("should map client_id to a Client.Id condition", async () => {
        await alertsHandler.handleCall("cwautomate_alerts_list", {
          client_id: 10,
        });

        expect(mockAlertsList).toHaveBeenCalledWith({
          condition: "Client.Id = 10",
          pageSize: 50,
          page: undefined,
        });
      });

      it("should map severity to a Severity.Id condition", async () => {
        await alertsHandler.handleCall("cwautomate_alerts_list", {
          severity: 3,
        });

        expect(mockAlertsList).toHaveBeenCalledWith({
          condition: "Severity.Id = 3",
          pageSize: 50,
          page: undefined,
        });
      });

      it("should combine client_id and severity with and", async () => {
        await alertsHandler.handleCall("cwautomate_alerts_list", {
          client_id: 10,
          severity: 3,
        });

        expect(mockAlertsList).toHaveBeenCalledWith({
          condition: "(Client.Id = 10) and (Severity.Id = 3)",
          pageSize: 50,
          page: undefined,
        });
      });

      it("should apply the severity condition on the per-computer route too", async () => {
        await alertsHandler.handleCall("cwautomate_alerts_list", {
          computer_id: 5,
          severity: 1,
        });

        expect(mockAlertsListForComputer).toHaveBeenCalledWith(5, {
          condition: "Severity.Id = 1",
          pageSize: 50,
          page: undefined,
        });
      });
    });

    describe("cwautomate_alerts_get", () => {
      it("should get a single alert", async () => {
        const result = await alertsHandler.handleCall("cwautomate_alerts_get", {
          alert_id: 1,
        });

        expect(result.isError).toBeUndefined();
        expect(mockAlertsGet).toHaveBeenCalledWith(1);

        const data = JSON.parse(result.content[0].text);
        expect(data.AlertId).toBe(1);
        expect(data.Message).toBe("Disk space low");
        expect(data.Severity).toEqual({ Id: 3, Name: "Warning" });
      });
    });

    describe("removed tools", () => {
      it("should reject cwautomate_alerts_acknowledge as unknown", async () => {
        const result = await alertsHandler.handleCall(
          "cwautomate_alerts_acknowledge",
          { alert_id: 1 }
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Unknown alert tool");
      });
    });

    describe("unknown tool", () => {
      it("should return error for unknown tool", async () => {
        const result = await alertsHandler.handleCall(
          "cwautomate_alerts_unknown",
          {}
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Unknown alert tool");
      });
    });
  });
});
