/**
 * Tests for clients domain handler
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Create mock functions using vi.hoisted
const {
  mockClientsList,
  mockClientsGet,
  mockClientsCreate,
  mockClientsUpdate,
  mockLocationsList,
  mockClient,
} = vi.hoisted(() => {
  const mockClientsList = vi.fn();
  const mockClientsGet = vi.fn();
  const mockClientsCreate = vi.fn();
  const mockClientsUpdate = vi.fn();
  const mockLocationsList = vi.fn();

  const mockClient = {
    clients: {
      list: mockClientsList,
      get: mockClientsGet,
      create: mockClientsCreate,
      update: mockClientsUpdate,
    },
    locations: {
      list: mockLocationsList,
    },
  };

  return {
    mockClientsList,
    mockClientsGet,
    mockClientsCreate,
    mockClientsUpdate,
    mockLocationsList,
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
import { clientsHandler } from "../../domains/clients.js";

describe("Clients Domain Handler", () => {
  beforeEach(() => {
    // Clear call history
    mockClientsList.mockClear();
    mockClientsGet.mockClear();
    mockClientsCreate.mockClear();
    mockClientsUpdate.mockClear();
    mockLocationsList.mockClear();

    // Reset mock implementations to the real API response shape:
    // Automate list endpoints return a bare JSON array (issue #35).
    mockClientsList.mockResolvedValue([
      { Id: 1, Name: "Client 1" },
      { Id: 2, Name: "Client 2" },
    ]);
    mockClientsGet.mockResolvedValue({
      Id: 1,
      Name: "Client 1",
      City: "Test City",
    });
    mockClientsCreate.mockResolvedValue({
      Id: 100,
      Name: "New Client",
    });
    mockClientsUpdate.mockResolvedValue({
      Id: 1,
      Name: "Updated Client",
    });
    mockLocationsList.mockResolvedValue([
      { Id: 1, Name: "Main Office" },
      { Id: 2, Name: "Branch Office" },
    ]);
  });

  describe("getTools", () => {
    it("should return all client tools", () => {
      const tools = clientsHandler.getTools();

      expect(tools.length).toBe(4);

      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain("cwautomate_clients_list");
      expect(toolNames).toContain("cwautomate_clients_get");
      expect(toolNames).toContain("cwautomate_clients_create");
      expect(toolNames).toContain("cwautomate_clients_update");
    });

    it("cwautomate_clients_get should require client_id", () => {
      const tools = clientsHandler.getTools();
      const getTool = tools.find((t) => t.name === "cwautomate_clients_get");

      expect(getTool).toBeDefined();
      expect(getTool?.inputSchema.required).toContain("client_id");
    });

    it("cwautomate_clients_create should require name", () => {
      const tools = clientsHandler.getTools();
      const createTool = tools.find(
        (t) => t.name === "cwautomate_clients_create"
      );

      expect(createTool).toBeDefined();
      expect(createTool?.inputSchema.required).toContain("name");
    });

    it("cwautomate_clients_update should require client_id", () => {
      const tools = clientsHandler.getTools();
      const updateTool = tools.find(
        (t) => t.name === "cwautomate_clients_update"
      );

      expect(updateTool).toBeDefined();
      expect(updateTool?.inputSchema.required).toContain("client_id");
    });
  });

  describe("handleCall", () => {
    describe("cwautomate_clients_list", () => {
      it("should list clients with default parameters", async () => {
        const result = await clientsHandler.handleCall(
          "cwautomate_clients_list",
          {}
        );

        expect(result.isError).toBeUndefined();
        expect(result.content[0].type).toBe("text");

        const data = JSON.parse(result.content[0].text);
        expect(data.total).toBe(2);
        expect(data.clients).toHaveLength(2);
      });

      it("should translate skip/limit to page/pageSize", async () => {
        await clientsHandler.handleCall("cwautomate_clients_list", {
          limit: 10,
          skip: 20,
        });

        expect(mockClientsList).toHaveBeenCalledWith({
          pageSize: 10,
          page: 3,
        });
      });
    });

    describe("cwautomate_clients_get", () => {
      it("should get a single client", async () => {
        const result = await clientsHandler.handleCall(
          "cwautomate_clients_get",
          {
            client_id: 1,
          }
        );

        expect(result.isError).toBeUndefined();

        const data = JSON.parse(result.content[0].text);
        expect(data.Id).toBe(1);
        expect(data.Name).toBe("Client 1");
      });

      it("should include locations when requested", async () => {
        const result = await clientsHandler.handleCall(
          "cwautomate_clients_get",
          {
            client_id: 1,
            include_locations: true,
          }
        );

        const data = JSON.parse(result.content[0].text);
        expect(data.locations).toBeDefined();
        expect(data.locations).toHaveLength(2);
        expect(mockLocationsList).toHaveBeenCalledWith({ clientId: 1 });
      });
    });

    describe("cwautomate_clients_create", () => {
      it("should create a client with required fields", async () => {
        const result = await clientsHandler.handleCall(
          "cwautomate_clients_create",
          {
            name: "New Client",
          }
        );

        expect(result.isError).toBeUndefined();

        const data = JSON.parse(result.content[0].text);
        expect(data.Id).toBe(100);
        expect(data.Name).toBe("New Client");
      });

      it("should map fields to the library's PascalCase shape", async () => {
        await clientsHandler.handleCall("cwautomate_clients_create", {
          name: "New Client",
          city: "Test City",
          state: "Test State",
          zip: "12345",
          country: "USA",
          phone: "555-1234",
        });

        expect(mockClientsCreate).toHaveBeenCalledWith({
          Name: "New Client",
          City: "Test City",
          State: "Test State",
          ZipCode: "12345",
          Country: "USA",
          PhoneNumber: "555-1234",
        });
      });
    });

    describe("cwautomate_clients_update", () => {
      it("should update a client", async () => {
        const result = await clientsHandler.handleCall(
          "cwautomate_clients_update",
          {
            client_id: 1,
            name: "Updated Client",
          }
        );

        expect(result.isError).toBeUndefined();

        const data = JSON.parse(result.content[0].text);
        expect(data.Name).toBe("Updated Client");
      });

      it("should map update fields to the library's PascalCase shape", async () => {
        await clientsHandler.handleCall("cwautomate_clients_update", {
          client_id: 1,
          name: "Updated",
          city: "New City",
        });

        expect(mockClientsUpdate).toHaveBeenCalledWith(1, {
          Name: "Updated",
          City: "New City",
          State: undefined,
          ZipCode: undefined,
          Country: undefined,
          PhoneNumber: undefined,
        });
      });
    });

    describe("unknown tool", () => {
      it("should return error for unknown tool", async () => {
        const result = await clientsHandler.handleCall(
          "cwautomate_clients_unknown",
          {}
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Unknown client tool");
      });
    });
  });
});
