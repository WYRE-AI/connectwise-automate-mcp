/**
 * S2S guard ordering vs. lazy ConnectWise Automate token-acquisition side effect
 *
 * This vendor's own credential EXTRACTION (`resolveGatewayCredentials` in
 * mcp-server.ts) is a pure, synchronous header-read with no side effect —
 * but the vendored SDK (`@wyre-technology/node-connectwise-automate`) that
 * those credentials feed into performs a REAL outbound token-acquisition
 * call: `AuthManager.doAcquireToken()` does
 * `fetch(`${serverUrl}/cwa/api/v1/apitoken`, {method:"POST", body:{ClientId,
 * UserName, Password}})`, invoked lazily via `authManager.getToken()` from
 * `HttpClient.executeRequest()` — which only runs when a tool handler
 * actually calls the ConnectWise Automate API. This lives entirely inside
 * node_modules, invisible to an in-repo-only classification sweep. A
 * generic 4-case status-code check can't distinguish "guard correctly
 * blocked the request before any token call" from "guard was accidentally
 * moved after it, but still ultimately rejected" — both look like a 401
 * externally. Only an instrumented call-counter on the token endpoint tells
 * them apart.
 *
 * Approach (a): drives a REAL `tools/call` (`cwautomate_clients_list`)
 * round-trip through the actual HTTP server (src/index.ts, unmocked),
 * stubbing only the network boundary — the vendor host is intercepted,
 * every other fetch (notably this test's own loopback call into the
 * server under test) passes through to the real fetch.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

const TEST_HOST = '127.0.0.1';
const TEST_PORT = 47531;
const TEST_S2S_SECRET = 'test-s2s-guard-ordering-secret-do-not-use-in-prod';
const WRONG_S2S_SECRET = 'wrong-secret-must-not-verify';
const CWA_TEST_SERVER = 'https://cwa-test.invalid.example';

function mintS2sHeader(secret: string, unixSeconds: number): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac('sha256', secret).update(message).digest('hex');
  return `${message},v1=${hex}`;
}

const GATEWAY_HEADERS = {
  'x-cwa-server': CWA_TEST_SERVER,
  'x-cwa-client-id': 'test-client-id',
  'x-cwa-username': 'test-user',
  'x-cwa-password': 'test-password',
};

let realFetch: typeof fetch;
let tokenCalls = 0;
let dataCalls = 0;

function installFetchStub(): void {
  tokenCalls = 0;
  dataCalls = 0;
  const stub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.startsWith(`http://${TEST_HOST}:${TEST_PORT}`)) {
      return realFetch(input as never, init);
    }
    if (url.startsWith(`${CWA_TEST_SERVER}/cwa/api/v1/apitoken`)) {
      tokenCalls++;
      return new Response(
        JSON.stringify({ AccessToken: 'fake-access-token-for-test', ExpirationDate: new Date(Date.now() + 3600_000).toISOString() }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.startsWith(CWA_TEST_SERVER)) {
      dataCalls++;
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return realFetch(input as never, init);
  });
  global.fetch = stub as unknown as typeof fetch;
}

async function postToMcp(headers: Record<string, string>, body: unknown): Promise<Response> {
  return realFetch(`http://${TEST_HOST}:${TEST_PORT}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function waitForServerReady(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const res = await realFetch(`http://${TEST_HOST}:${TEST_PORT}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('connectwise-automate-mcp test HTTP server did not become ready in time');
}

beforeAll(async () => {
  realFetch = globalThis.fetch.bind(globalThis);

  process.env.MCP_TRANSPORT = 'http';
  process.env.AUTH_MODE = 'gateway';
  process.env.MCP_HTTP_PORT = String(TEST_PORT);
  process.env.MCP_HTTP_HOST = TEST_HOST;
  process.env.CONDUIT_S2S_SECRET = TEST_S2S_SECRET;

  await import('../index.js');
  await waitForServerReady();
});

afterAll(() => {
  global.fetch = realFetch;
});

beforeEach(() => {
  installFetchStub();
});

const LIST_CLIENTS_BODY = {
  jsonrpc: '2.0',
  method: 'tools/call',
  params: { name: 'cwautomate_clients_list', arguments: {} },
  id: 2,
};

describe('S2S guard ordering vs. lazy ConnectWise Automate token-acquisition side effect', () => {
  it('does NOT reach the CW Automate token endpoint when the S2S header is missing', async () => {
    const res = await postToMcp({ ...GATEWAY_HEADERS }, LIST_CLIENTS_BODY);

    expect(res.status).toBe(401);
    expect(tokenCalls).toBe(0);
    expect(dataCalls).toBe(0);
  });

  it('does NOT reach the CW Automate token endpoint when the S2S header is present but invalid', async () => {
    const res = await postToMcp(
      {
        ...GATEWAY_HEADERS,
        'x-gateway-s2s': mintS2sHeader(WRONG_S2S_SECRET, Math.floor(Date.now() / 1000)),
      },
      LIST_CLIENTS_BODY,
    );

    expect(res.status).toBe(401);
    expect(tokenCalls).toBe(0);
    expect(dataCalls).toBe(0);
  });

  // Negative control: proves the fetch-stub apparatus above genuinely detects
  // the token acquisition firing, so the zero-calls assertions above aren't
  // vacuously true.
  it('DOES reach the token endpoint at least once when the S2S header is valid and a real tool executes', async () => {
    const res = await postToMcp(
      {
        ...GATEWAY_HEADERS,
        'x-gateway-s2s': mintS2sHeader(TEST_S2S_SECRET, Math.floor(Date.now() / 1000)),
      },
      LIST_CLIENTS_BODY,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { isError?: boolean } };
    expect(body.result?.isError).not.toBe(true);

    expect(tokenCalls).toBe(1);
    expect(dataCalls).toBe(1);
  });
});
