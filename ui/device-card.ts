/**
 * Iframe bridge + renderer for the ConnectWise Automate device card
 * (MCP Apps, SEP-1865).
 *
 * Runs inside the host's sandboxed iframe. Uses the official MCP Apps client
 * (`App`) to receive the tool result from the host. The card is read-only —
 * it renders the device and offers no write actions.
 *
 * The server attaches a normalized `_card` payload to cwautomate_computers_get
 * results (see src/card.builder.ts) so this renderer never needs to resolve
 * ids or entity names itself.
 *
 * Rendering uses DOM construction (no innerHTML) — device names, users, and
 * OS strings are untrusted RMM data, so text only ever lands in text nodes.
 *
 * White-label: the card is neutral by default (no vendor identity) and applies
 * an injected `window.__BRAND__` override (set by the MCP server via
 * MCP_BRAND_* env vars, or a gateway per-org) so the same card can render in
 * any operator's brand.
 */
import { App } from "@modelcontextprotocol/ext-apps";

interface Brand {
  name?: string;
  logoUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  bg?: string;
  text?: string;
}
declare global {
  interface Window {
    __BRAND__?: Brand;
  }
}

/** Mirror of DeviceCard in src/card.builder.ts — keep in sync. */
interface DeviceCard {
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

const brand: Brand = window.__BRAND__ ?? {};
const brandName = brand.name ?? "";

// Apply any injected brand overrides onto the CSS custom properties.
function applyBrand(): void {
  const root = document.documentElement.style;
  if (brand.primaryColor) root.setProperty("--brand-primary", brand.primaryColor);
  if (brand.accentColor) root.setProperty("--brand-accent", brand.accentColor);
  if (brand.bg) root.setProperty("--brand-bg", brand.bg);
  if (brand.text) root.setProperty("--brand-text", brand.text);
}

const app = new App({ name: "ConnectWise Automate Device Card", version: "1.0.0" });

/** Create an element with a class and (safe, text-node) children. */
function el(
  tag: string,
  className = "",
  ...children: Array<Node | string | null>
): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) {
    if (child == null) continue;
    node.append(child); // strings become text nodes — never parsed as HTML
  }
  return node;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function field(label: string, value: string | undefined, withDot = false): HTMLElement | null {
  if (!value) return null;
  const valueEl = el("div", withDot ? "field__value status" : "field__value");
  if (withDot) valueEl.append(el("span", "dot"));
  valueEl.append(value);
  return el("div", "field", el("div", "field__label", label), valueEl);
}

function badge(text: string | undefined, cls: string): HTMLElement | null {
  return text ? el("span", `badge ${cls}`, text) : null;
}

function render(device: DeviceCard): void {
  // Brand identity only renders when a brand was injected — the neutral
  // default shows just the device number/vendor context in the header.
  let brandId: HTMLElement | null = null;
  if (brandName || brand.logoUrl) {
    brandId = el("span", "brandid");
    if (brand.logoUrl) {
      const logo = document.createElement("img");
      logo.src = brand.logoUrl;
      logo.alt = brandName;
      logo.style.display = "inline-block";
      brandId.append(logo);
    }
    if (brandName) brandId.append(el("span", "brand", brandName));
  }

  const body = el(
    "div",
    "card__body",
    el(
      "div",
      "brandrow",
      brandId,
      el("span", "deviceno", `#${device.id} · ConnectWise Automate`),
    ),
    el("h1", "", device.name),
    el(
      "div",
      "badges",
      badge(device.status, "badge--status"),
      badge(device.type, "badge--type"),
    ),
    el(
      "div",
      "grid",
      field("Client", device.client),
      field("Location", device.location),
      field("Operating system", device.os),
      field("Last user", device.lastUser),
      field("IP address", device.localIp),
      field("Serial number", device.serialNumber),
      field("Agent version", device.agentVersion),
      field("Last contact", device.lastContact && fmtDate(device.lastContact), true),
    ),
  );

  const root = document.getElementById("root")!;
  root.replaceChildren(el("div", "card", el("div", "card__bar"), body));
}

// connectwise-automate-mcp returns the computer JSON directly and attaches the
// normalized card to cwautomate_computers_get results as _card.
function extractCard(obj: unknown): DeviceCard | null {
  const card = (obj as { _card?: DeviceCard })?._card;
  return card && typeof card.id === "number" && typeof card.name === "string" ? card : null;
}

applyBrand();

// Must be set before connect() so the initial tool-result isn't missed.
app.ontoolresult = (result: { content?: Array<{ type: string; text?: string }> }) => {
  const payload = (result.content ?? []).find((c) => c.type === "text");
  if (!payload?.text) return;
  try {
    const card = extractCard(JSON.parse(payload.text));
    if (card) render(card);
  } catch {
    /* ignore malformed payloads */
  }
};

app.connect();
