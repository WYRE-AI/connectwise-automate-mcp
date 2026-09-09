/**
 * Tests for the CallTool catch-all in mcp-server.ts: what a client sees, and
 * what lands in the container logs, when a domain handler throws.
 *
 * Customers were seeing a bare `Error: terminated` from tools whose handlers
 * have no local handling for a dropped connection (cwautomate_scripts_get
 * was the reported case), while the container logs stayed empty. This drives
 * the real `createMcpServer()` over an in-memory transport, exactly as an MCP
 * client would, with the Automate client mocked to fail.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const { mockScriptsGet, mockClient } = vi.hoisted(() => {
  const mockScriptsGet = vi.fn();
  return { mockScriptsGet, mockClient: { scripts: { get: mockScriptsGet } } };
});

vi.mock("../utils/client.js", () => ({
  getClient: () => Promise.resolve(mockClient),
  clearClient: vi.fn(),
}));

import { createMcpServer } from "../mcp-server.js";

type ToolResult = { isError?: boolean; content: { text: string }[] };

async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  await server.connect(serverTransport);

  const client = new Client(
    { name: "tool-failures-test", version: "0" },
    { capabilities: {} }
  );
  await client.connect(clientTransport);
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

describe("CallTool catch-all", () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    stderr.mockClear();
    mockScriptsGet.mockReset();
  });

  afterAll(() => {
    stderr.mockRestore();
  });

  it("maps a dropped connection to a structured, non-error result and logs it once", async () => {
    mockScriptsGet.mockRejectedValue(new TypeError("terminated"));

    const result = await callTool("cwautomate_scripts_get", { script_id: 1 });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).not.toContain("Error: terminated");

    const data = JSON.parse(result.content[0].text);
    expect(data).toEqual({
      tool: "cwautomate_scripts_get",
      completed: false,
      interrupted: true,
      message: expect.stringContaining("interrupted"),
    });
    expect(data.message).toContain("verify in Automate");

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(
      "[MCP] tool cwautomate_scripts_get failed: TypeError: terminated"
    );
  });

  it("keeps the isError result for any other failure, and logs it too", async () => {
    mockScriptsGet.mockRejectedValue(new Error("HTTP 403 Forbidden"));

    const result = await callTool("cwautomate_scripts_get", { script_id: 1 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error: HTTP 403 Forbidden");

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(
      "[MCP] tool cwautomate_scripts_get failed: Error: HTTP 403 Forbidden"
    );
  });

  it("never logs tool arguments", async () => {
    mockScriptsGet.mockRejectedValue(new Error("boom"));

    await callTool("cwautomate_scripts_get", { script_id: 424242 });

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0][0])).not.toContain("424242");
  });
});
