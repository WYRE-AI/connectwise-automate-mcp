/**
 * Device-card payload builder for the MCP Apps (SEP-1865) UI surface.
 *
 * cwautomate_computers_get results get a normalized `_card` object attached
 * (see domains/computers.ts) that the ui:// device card renders from. The card
 * is progressive enhancement: every step here is best-effort, and a null
 * return simply means the host renders no card while the JSON payload is
 * unchanged.
 */

import type { ConnectWiseAutomateClient } from "@wyre-technology/node-connectwise-automate";

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

/** Name from an embedded `{ Id, Name }` reference (Computer.Client / .Location). */
function embeddedName(ref: unknown): string | undefined {
  return ref !== null && typeof ref === "object"
    ? asString((ref as { Name?: unknown }).Name)
    : undefined;
}

/**
 * Build the renderable card from a cwautomate_computers_get payload. Client
 * and location labels prefer the names the Automate API embeds on the
 * computer; missing names are resolved best-effort through the existing
 * clients/locations lookups, falling back to `#id`.
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

  if (typeof computer.IsOnline === "boolean") {
    card.status = computer.IsOnline ? "Online" : "Offline";
  }
  const type = asString(computer.Type);
  if (type) card.type = type;

  // Client label: embedded name -> clients.get lookup (best-effort) -> #id.
  let clientLabel = embeddedName(computer.Client);
  if (!clientLabel && typeof computer.ClientId === "number") {
    try {
      clientLabel = asString((await client.clients.get(computer.ClientId)).Name);
    } catch {
      // Best-effort: fall through to the #id label.
    }
    clientLabel = clientLabel ?? `#${computer.ClientId}`;
  }
  if (clientLabel) card.client = clientLabel;

  // Location label: embedded name -> locations.get lookup (best-effort) -> #id.
  let locationLabel = embeddedName(computer.Location);
  if (!locationLabel && typeof computer.LocationId === "number") {
    try {
      locationLabel = asString((await client.locations.get(computer.LocationId)).Name);
    } catch {
      // Best-effort: fall through to the #id label.
    }
    locationLabel = locationLabel ?? `#${computer.LocationId}`;
  }
  if (locationLabel) card.location = locationLabel;

  const os = asString(computer.OS);
  const osVersion = asString(computer.OSVersion);
  if (os) card.os = osVersion ? `${os} ${osVersion}` : os;

  const lastUser = asString(computer.LastUserName);
  if (lastUser) card.lastUser = lastUser;
  const lastContact = asString(computer.LastContact);
  if (lastContact) card.lastContact = lastContact;
  const localIp = asString(computer.LocalIPAddress);
  if (localIp) card.localIp = localIp;
  const serialNumber = asString(computer.SerialNumber);
  if (serialNumber) card.serialNumber = serialNumber;
  const agentVersion = asString(computer.AgentVersion);
  if (agentVersion) card.agentVersion = agentVersion;

  return card;
}
