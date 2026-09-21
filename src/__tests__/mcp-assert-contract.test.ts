/**
 * Regression guard for the `mcp-assert` CI baseline contract.
 *
 * The `mcp-assert` check (.github/workflows/mcp-assert.yml) spawns the built
 * server over stdio with NO credentials and runs two assertions that must both
 * pass at 100%:
 *
 *   1. `<canary-tool>` returns `isError: true` when credentials are missing.
 *      The canary configured in the workflow is `cwautomate_scripts_list`.
 *   2. An unknown tool returns `isError: true` (the JSON-RPC -32601 baseline).
 *
 * These were previously only enforced by the external CI check, which spawns a
 * binary downloaded from an upstream release. When that download flaked the
 * check went red even though the server was correct, and a genuine source
 * regression (e.g. re-introducing an HTTP transport default, or gating the
 * canary tool behind navigation so it is no longer registered) would only be
 * caught in CI rather than by `npm test`.
 *
 * This suite pins the same contract in-process by driving the real
 * `createMcpServer()` factory through an in-memory transport pair, exactly as
 * an MCP client (and therefore mcp-assert) would.
 */

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../mcp-server.js";

/** The canary tool named in .github/workflows/mcp-assert.yml. */
const CANARY_TOOL = "cwautomate_scripts_list";

async function connectClient(): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const server = createMcpServer();
  await server.connect(serverTransport);

  const client = new Client(
    { name: "mcp-assert-contract-test", version: "0" },
    { capabilities: {} }
  );
  await client.connect(clientTransport);
  return client;
}

describe("mcp-assert baseline contract", () => {
  it("registers the canary tool upfront (not gated behind navigation)", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    // The flat architecture exposes every tool immediately. mcp-assert calls
    // the canary directly without first calling cwautomate_navigate, so the
    // canary must always be present in tools/list.
    expect(names).toContain(CANARY_TOOL);
  });

  it("canary tool returns isError when credentials are missing", async () => {
    const client = await connectClient();
    const result = (await client.callTool({
      name: CANARY_TOOL,
      arguments: {},
    })) as { isError?: boolean; content?: { text?: string }[] };

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/credentials/i);
  });

  it("unknown tool returns isError (JSON-RPC -32601 baseline)", async () => {
    const client = await connectClient();
    const result = (await client.callTool({
      name: "this_tool_does_not_exist_xyz",
      arguments: {},
    })) as { isError?: boolean; content?: { text?: string }[] };

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/not registered/i);
  });

  it("dispatches every advertised tool, including cwautomate_commands_list", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    // Registered in the computers domain, but the name does not start with
    // cwautomate_computers_. A prefix router advertises it and then answers
    // tools/call with "Unknown tool".
    expect(names).toContain("cwautomate_commands_list");

    const skipped = new Set(["cwautomate_navigate", "cwautomate_status"]);
    for (const name of names) {
      if (skipped.has(name)) continue;
      const result = (await client.callTool({
        name,
        arguments: {},
      })) as { isError?: boolean; content?: { text?: string }[] };
      const text = result.content?.[0]?.text ?? "";
      expect(text, name).not.toMatch(/Unknown tool/i);
      expect(text, name).toMatch(/credentials/i);
    }
  });
});
