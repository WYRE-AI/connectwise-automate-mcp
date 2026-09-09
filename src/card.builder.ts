/**
 * Device-card payload builder for the MCP Apps (SEP-1865) UI surface.
 *
 * cwautomate_computers_get results get a normalized `_card` object attached
 * (see domains/computers.ts) that the ui:// device card renders from. The card
 * is progressive enhancement: every step here is best-effort, and a null
 * return simply means the host renders no card while the JSON payload is
 * unchanged.
 */

import type { ConnectWiseAutomateClient } from "@wyre-ai/node-connectwise-automate";

export const DEVICE_CARD_RESOURCE_URI = "ui://cwautomate/device-card.html";

/** MCP Apps resource MIME (RESOURCE_MIME_TYPE in @modelcontextprotocol/ext-apps). */
export const MCP_APP_RESOURCE_MIME = "text/html;profile=mcp-app";

/**
 * Tool `_meta` advertising the card. Carries both the canonical flat key
 * (RESOURCE_URI_META_KEY in ext-apps) and the nested form ext-apps'
 * registerAppTool emits, so any MCP Apps host revision finds it.
 */
export const DEVICE_CARD_META = {
  "ui/resourceUri": DEVICE_CARD_RESOURCE_URI,
  ui: { resourceUri: DEVICE_CARD_RESOURCE_URI },
} as const;

/** Mirror of Brand in ui/device-card.ts — keep in sync. */
export interface CardBrand {
  name?: string;
  logoUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  bg?: string;
  text?: string;
}

/** The BRAND_INJECT comment marker baked into the card HTML (see ui/index.html). */
const BRAND_INJECT_RE = /<!--\s*BRAND_INJECT:[\s\S]*?-->/;

/**
 * Serve-time brand injection: replace the BRAND_INJECT marker with an inline
 * `window.__BRAND__` script so self-hosters can theme the card without
 * rebuilding the bundle. An empty brand returns the HTML unchanged (the card
 * renders its neutral defaults). `<` is escaped so brand values can never
 * break out of the script tag.
 */
export function applyBrandInjection(html: string, brand: CardBrand): string {
  if (!brand || Object.values(brand).every((v) => !v)) return html;
  const json = JSON.stringify(brand).replace(/</g, "\\u003c");
  return html.replace(BRAND_INJECT_RE, `<script>window.__BRAND__=${json}</script>`);
}

/**
 * Resolve brand overrides from MCP_BRAND_* environment variables. Guarded for
 * runtimes without `process` (Cloudflare Workers), where this returns an empty
 * brand and the card serves its neutral defaults.
 */
export function resolveBrandFromEnv(): CardBrand {
  if (typeof process === "undefined" || !process.env) return {};
  const env = process.env;
  const brand: CardBrand = {};
  if (env.MCP_BRAND_NAME) brand.name = env.MCP_BRAND_NAME;
  if (env.MCP_BRAND_LOGO_URL) brand.logoUrl = env.MCP_BRAND_LOGO_URL;
  if (env.MCP_BRAND_PRIMARY_COLOR) brand.primaryColor = env.MCP_BRAND_PRIMARY_COLOR;
  if (env.MCP_BRAND_ACCENT_COLOR) brand.accentColor = env.MCP_BRAND_ACCENT_COLOR;
  if (env.MCP_BRAND_BG) brand.bg = env.MCP_BRAND_BG;
  if (env.MCP_BRAND_TEXT) brand.text = env.MCP_BRAND_TEXT;
  return brand;
}

/** Mirror of DeviceCard in ui/device-card.ts — keep in sync. */
export interface DeviceCard {
  id: number;
  name: string;
  status?: string;
  type?: string;
  client?: string;
  location?: string;
  os?: string;
  lastUser?: string;
  lastContact?: string;
  localIp?: string;
  serialNumber?: string;
  agentVersion?: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Label for an embedded `{ Id, Name }` reference (Computer.Client /
 * Computer.Location): the embedded name when present, otherwise a
 * best-effort `lookup(Id)`, falling back to `#id`. The spec's Computer has
 * no flat ClientId/LocationId, so the ref is the only handle we have.
 */
async function resolveLabel(
  ref: unknown,
  lookup: (id: number) => Promise<{ Name?: string }>
): Promise<string | undefined> {
  if (ref === null || typeof ref !== "object") return undefined;
  const { Id, Name } = ref as { Id?: unknown; Name?: unknown };

  const name = asString(Name);
  if (name) return name;
  if (typeof Id !== "number") return undefined;

  try {
    const found = asString((await lookup(Id)).Name);
    if (found) return found;
  } catch {
    // Best-effort: fall through to the #id label.
  }
  return `#${Id}`;
}

/**
 * Build the renderable card from a cwautomate_computers_get payload, which is
 * shaped like the swagger's LabTech.Models.Computer. Client and location
 * labels prefer the names embedded on the computer; missing names are
 * resolved best-effort through the existing clients/locations lookups.
 */
export async function buildDeviceCard(
  computer: Record<string, unknown>,
  client: Pick<ConnectWiseAutomateClient, "clients" | "locations">
): Promise<DeviceCard | null> {
  if (typeof computer?.Id !== "number" || !asString(computer.ComputerName)) {
    return null;
  }

  const card: DeviceCard = {
    id: computer.Id,
    name: String(computer.ComputerName),
  };

  // Online state is a string ("Online"/"Offline"), not a boolean.
  const status = asString(computer.Status);
  if (status) card.status = status;
  const type = asString(computer.Type);
  if (type) card.type = type;

  const clientLabel = await resolveLabel(computer.Client, (id) =>
    client.clients.get(id)
  );
  if (clientLabel) card.client = clientLabel;
  const locationLabel = await resolveLabel(computer.Location, (id) =>
    client.locations.get(id)
  );
  if (locationLabel) card.location = locationLabel;

  const os = asString(computer.OperatingSystemName);
  const osVersion = asString(computer.OperatingSystemVersion);
  if (os) card.os = osVersion ? `${os} ${osVersion}` : os;

  const lastUser = asString(computer.LastUserName);
  if (lastUser) card.lastUser = lastUser;
  const lastContact = asString(computer.RemoteAgentLastContact);
  if (lastContact) card.lastContact = lastContact;
  const localIp = asString(computer.LocalIPAddress);
  if (localIp) card.localIp = localIp;
  const serialNumber = asString(computer.SerialNumber);
  if (serialNumber) card.serialNumber = serialNumber;
  const agentVersion = asString(computer.RemoteAgentVersion);
  if (agentVersion) card.agentVersion = agentVersion;

  return card;
}
