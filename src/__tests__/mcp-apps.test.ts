/**
 * MCP Apps (SEP-1865) contract tests — mirrors the checks an MCP Apps host
 * performs to render the device card:
 *   1. the renderable tool advertises the UI resource via _meta (both forms)
 *   2. the ui:// resource lists and reads back as profile=mcp-app HTML
 *   3. buildDeviceCard normalizes a ConnectWise Automate computer into the
 *      card payload the iframe renders from — best-effort, never failing the
 *      tool result
 *   4. the default bundle is brand-neutral; MCP_BRAND_* env vars inject a
 *      window.__BRAND__ override at serve time
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { listResources, readResource } from "../resources.js";
import {
  buildDeviceCard,
  applyBrandInjection,
  DEVICE_CARD_RESOURCE_URI,
  MCP_APP_RESOURCE_MIME,
} from "../card.builder.js";
import { DEVICE_CARD_HTML } from "../generated/device-card-html.js";

// Mock the CW Automate client so the handler-integration tests below can
// drive cwautomate_computers_get without credentials.
const { mockComputersGet, mockClientsGet, mockLocationsGet, mockClient } =
  vi.hoisted(() => {
    const mockComputersGet = vi.fn();
    const mockClientsGet = vi.fn();
    const mockLocationsGet = vi.fn();
    const mockClient = {
      computers: { get: mockComputersGet },
      clients: { get: mockClientsGet },
      locations: { get: mockLocationsGet },
    };
    return { mockComputersGet, mockClientsGet, mockLocationsGet, mockClient };
  });

vi.mock("../utils/client.js", () => ({
  getClient: () => Promise.resolve(mockClient),
  clearClient: vi.fn(),
}));

import { computersHandler } from "../domains/computers.js";
import { getAvailableDomains, getDomainHandler } from "../domains/index.js";
import { createMcpServer } from "../mcp-server.js";

const RENDERABLE_TOOLS = ["cwautomate_computers_get"];

/**
 * A realistic cwautomate_computers_get payload, shaped like the swagger's
 * LabTech.Models.Computer: client/location are embedded refs (no flat
 * ClientId/LocationId), and online state is the `Status` string.
 */
const computer = {
  Id: 3117,
  ComputerName: "ACME-DC01",
  Client: { Id: 12, Name: "Acme Corp" },
  Location: { Id: 3, Name: "Main Office" },
  Type: "Server",
  OperatingSystemName: "Windows Server 2022",
  OperatingSystemVersion: "21H2",
  LastUserName: "ACME\\administrator",
  Status: "Online",
  RemoteAgentLastContact: "2026-07-17T09:00:00Z",
  LocalIPAddress: "10.0.0.5",
  SerialNumber: "VMware-42",
  RemoteAgentVersion: "240.352",
};

async function getAllTools(): Promise<Tool[]> {
  const tools: Tool[] = [];
  for (const domain of getAvailableDomains()) {
    const handler = await getDomainHandler(domain);
    tools.push(...handler.getTools());
  }
  return tools;
}

async function connectClient(): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "mcp-apps-test", version: "0" },
    { capabilities: {} }
  );
  await client.connect(clientTransport);
  return client;
}

describe("MCP Apps device card", () => {
  beforeEach(() => {
    mockComputersGet.mockReset();
    mockClientsGet.mockReset();
    mockLocationsGet.mockReset();
    mockComputersGet.mockResolvedValue({ ...computer });
    mockClientsGet.mockResolvedValue({ Id: 12, Name: "Acme Corp" });
    mockLocationsGet.mockResolvedValue({ Id: 3, Name: "Main Office", ClientId: 12 });
  });

  describe("tool _meta advertisement", () => {
    it.each(RENDERABLE_TOOLS)("%s links the card via _meta", async (name) => {
      const tool = (await getAllTools()).find((t) => t.name === name);
      expect(tool).toBeDefined();
      // Canonical flat key (ext-apps RESOURCE_URI_META_KEY) …
      expect(tool?._meta?.["ui/resourceUri"]).toBe(DEVICE_CARD_RESOURCE_URI);
      // … and the nested form registerAppTool also emits.
      expect((tool?._meta?.ui as { resourceUri?: string })?.resourceUri).toBe(
        DEVICE_CARD_RESOURCE_URI
      );
    });

    it("no other tools carry UI metadata", async () => {
      const others = (await getAllTools()).filter(
        (t) => t._meta && !RENDERABLE_TOOLS.includes(t.name)
      );
      expect(others).toEqual([]);
    });

    it("_meta survives tools/list over the wire", async () => {
      const client = await connectClient();
      const { tools } = await client.listTools();
      const withMeta = tools.filter((t) => t._meta);
      expect(withMeta.map((t) => t.name)).toEqual(RENDERABLE_TOOLS);
      expect(withMeta[0]?._meta?.["ui/resourceUri"]).toBe(
        DEVICE_CARD_RESOURCE_URI
      );
    });
  });

  describe("ui:// resource", () => {
    it("is listed with the MCP Apps MIME type", () => {
      const card = listResources().find(
        (r) => r.uri === DEVICE_CARD_RESOURCE_URI
      );
      expect(card?.mimeType).toBe(MCP_APP_RESOURCE_MIME);
    });

    it("reads back as profile=mcp-app HTML containing the card app", () => {
      const content = readResource(DEVICE_CARD_RESOURCE_URI);
      expect(content.mimeType).toBe(MCP_APP_RESOURCE_MIME);
      // No MCP_BRAND_* env set → the embedded HTML is served byte-identical.
      expect(content.text).toBe(DEVICE_CARD_HTML);
      expect(content.text).toContain("card__bar");
      // The BRAND_INJECT marker must appear exactly once so serve-time
      // injection has one unambiguous replacement target.
      expect(content.text.split("BRAND_INJECT").length - 1).toBe(1);
      // The vite build must have inlined the bridge script — a bare <script src>
      // would be unloadable from a resources/read HTML string.
      expect(content.text).not.toContain('src="./device-card.ts"');
    });

    it("is served over the wire via resources/list and resources/read", async () => {
      const client = await connectClient();
      const { resources } = await client.listResources();
      expect(resources.map((r) => r.uri)).toContain(DEVICE_CARD_RESOURCE_URI);

      const { contents } = await client.readResource({
        uri: DEVICE_CARD_RESOURCE_URI,
      });
      const first = contents[0] as { mimeType?: string; text?: string };
      expect(first?.mimeType).toBe(MCP_APP_RESOURCE_MIME);
      expect(first?.text).toContain("card__bar");
    });

    it("serves neutral defaults with no vendor identity", () => {
      const { text } = readResource(DEVICE_CARD_RESOURCE_URI);
      expect(text).not.toMatch(/WYRE/i);
      expect(text).not.toContain("00c9db"); // WYRE cyan
      expect(text).not.toContain("ede947"); // WYRE yellow
      expect(text).not.toContain("fonts.googleapis.com"); // no external fetches
    });

    it("injects MCP_BRAND_* env vars into the served HTML", () => {
      vi.stubEnv("MCP_BRAND_NAME", "Acme MSP");
      vi.stubEnv("MCP_BRAND_PRIMARY_COLOR", "#ff0000");
      try {
        const { text } = readResource(DEVICE_CARD_RESOURCE_URI);
        expect(text).toContain(
          '<script>window.__BRAND__={"name":"Acme MSP","primaryColor":"#ff0000"}</script>'
        );
        expect(text).not.toContain("BRAND_INJECT");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("rejects unknown resource URIs", () => {
      expect(() => readResource("ui://cwautomate/nope.html")).toThrow(
        /Unknown resource/
      );
    });
  });

  describe("applyBrandInjection", () => {
    const html = DEVICE_CARD_HTML;

    it("replaces the marker with an inline window.__BRAND__ script", () => {
      const out = applyBrandInjection(html, {
        name: "Acme",
        primaryColor: "#123456",
      });
      expect(out).toContain(
        'window.__BRAND__={"name":"Acme","primaryColor":"#123456"}'
      );
      expect(out).not.toContain("BRAND_INJECT");
    });

    it("escapes < so brand values cannot break out of the script tag", () => {
      const out = applyBrandInjection(html, { name: "</script><script>alert(1)" });
      expect(out).not.toContain("</script><script>alert(1)");
      expect(out).toContain("\\u003c/script>\\u003cscript>alert(1)");
    });

    it("returns the HTML unchanged for an empty brand", () => {
      expect(applyBrandInjection(html, {})).toBe(html);
      expect(applyBrandInjection(html, { name: "" })).toBe(html);
    });
  });

  describe("buildDeviceCard", () => {
    it("normalizes the computer into the card payload", async () => {
      const card = await buildDeviceCard({ ...computer }, mockClient as never);
      expect(card).toEqual({
        id: 3117,
        name: "ACME-DC01",
        status: "Online",
        type: "Server",
        client: "Acme Corp",
        location: "Main Office",
        os: "Windows Server 2022 21H2",
        lastUser: "ACME\\administrator",
        lastContact: "2026-07-17T09:00:00Z",
        localIp: "10.0.0.5",
        serialNumber: "VMware-42",
        agentVersion: "240.352",
      });
      // Embedded Client/Location names are used without extra lookups.
      expect(mockClientsGet).not.toHaveBeenCalled();
      expect(mockLocationsGet).not.toHaveBeenCalled();
    });

    it("resolves missing labels through the existing clients/locations lookups", async () => {
      // Refs that carry an Id but no Name — the flat ClientId/LocationId
      // fields do not exist on the spec's Computer, so Id-only refs are the
      // only lookup path.
      const bare = {
        Id: 1,
        ComputerName: "WS-07",
        Client: { Id: 12 },
        Location: { Id: 3 },
      };
      const card = await buildDeviceCard(bare, mockClient as never);
      expect(card?.client).toBe("Acme Corp");
      expect(card?.location).toBe("Main Office");
      expect(mockClientsGet).toHaveBeenCalledWith(12);
      expect(mockLocationsGet).toHaveBeenCalledWith(3);
    });

    it("falls back to #id labels when the lookups fail (best-effort)", async () => {
      mockClientsGet.mockRejectedValue(new Error("CWA 500"));
      mockLocationsGet.mockRejectedValue(new Error("CWA 500"));
      const bare = {
        Id: 1,
        ComputerName: "WS-07",
        Client: { Id: 12 },
        Location: { Id: 3 },
      };
      const card = await buildDeviceCard(bare, mockClient as never);
      expect(card).toMatchObject({
        id: 1,
        name: "WS-07",
        client: "#12",
        location: "#3",
      });
    });

    it("ignores the legacy flat ClientId/LocationId fields", async () => {
      const legacy = { Id: 1, ComputerName: "WS-07", ClientId: 12, LocationId: 3 };
      const card = await buildDeviceCard(legacy, mockClient as never);
      expect(card?.client).toBeUndefined();
      expect(card?.location).toBeUndefined();
      expect(mockClientsGet).not.toHaveBeenCalled();
      expect(mockLocationsGet).not.toHaveBeenCalled();
    });

    it("passes the Status string through (Offline)", async () => {
      const card = await buildDeviceCard(
        { ...computer, Status: "Offline" },
        mockClient as never
      );
      expect(card?.status).toBe("Offline");
    });

    it("omits status when the API sends none", async () => {
      const { Status: _omitted, ...noStatus } = computer;
      const card = await buildDeviceCard(noStatus, mockClient as never);
      expect(card).not.toHaveProperty("status");
    });

    it("uses the OS name alone when no version is reported", async () => {
      const { OperatingSystemVersion: _omitted, ...noVersion } = computer;
      const card = await buildDeviceCard(noVersion, mockClient as never);
      expect(card?.os).toBe("Windows Server 2022");
    });

    it("returns null for payloads that are not a computer", async () => {
      expect(await buildDeviceCard({ Id: 1 }, mockClient as never)).toBeNull();
      expect(
        await buildDeviceCard({ ComputerName: "no id" }, mockClient as never)
      ).toBeNull();
    });
  });

  describe("cwautomate_computers_get integration", () => {
    it("attaches _card to the tool result without touching the payload", async () => {
      const result = await computersHandler.handleCall(
        "cwautomate_computers_get",
        { computer_id: 3117 }
      );
      expect(result.isError).toBeUndefined();

      const data = JSON.parse(result.content[0].text);
      // Model-visible payload unchanged …
      expect(data.Id).toBe(3117);
      expect(data.ComputerName).toBe("ACME-DC01");
      // … plus the additive normalized card.
      expect(data._card).toMatchObject({
        id: 3117,
        name: "ACME-DC01",
        status: "Online",
        client: "Acme Corp",
      });
    });

    it("drops the card (not the tool result) when card building degrades", async () => {
      // A payload the card builder rejects still returns the raw JSON.
      mockComputersGet.mockResolvedValue({ unexpected: "shape" });
      const result = await computersHandler.handleCall(
        "cwautomate_computers_get",
        { computer_id: 1 }
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.unexpected).toBe("shape");
      expect(data._card).toBeUndefined();
    });
  });
});
