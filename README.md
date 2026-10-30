# ConnectWise Automate MCP Server

A Model Context Protocol (MCP) server for ConnectWise Automate with decision tree architecture for Claude.

## One-Click Deployment

> [!IMPORTANT]
> **Before you click:** this server depends on `@wyre-ai/node-connectwise-automate`,
> which is hosted on the **GitHub Packages** npm registry. GitHub Packages has no
> anonymous access — even though the package is public, every `npm install` needs a
> token. The cloud builder runs `npm install` for you, so you must give it one, or
> the build fails with `npm error 401 Unauthorized ... npm.pkg.github.com`.
>
> 1. Create a GitHub **Personal Access Token** with the `read:packages` scope
>    ([classic token](https://github.com/settings/tokens/new?scopes=read:packages&description=connectwise-automate-mcp%20deploy)).
>    Any GitHub account works — you do **not** need to be a member of the
>    `WYRE-AI` org to read its public packages.
> 2. Add it as a build variable when prompted by the deploy flow:
>    - **Cloudflare Workers** → set a build variable named **`NODE_AUTH_TOKEN`** to your PAT
>      (Workers → Settings → Build → Variables and Secrets).
>    - **DigitalOcean App Platform** → set an encrypted env var named **`GITHUB_TOKEN`**
>      with scope **Build Time** to your PAT (the `.do/deploy.template.yaml` already declares it).

[![Deploy to DO](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/WYRE-AI/connectwise-automate-mcp/tree/main)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/WYRE-AI/connectwise-automate-mcp)

> [!NOTE]
> The DigitalOcean target builds the full Docker image and runs the complete MCP
> server over HTTP — this is the recommended path for operators. Set
> `CONDUIT_S2S_SECRET` (and the `CW_AUTOMATE_*` secrets) before the first boot;
> HTTP mode exits if the S2S secret is missing. The template sets `AUTH_MODE=env`
> for that single-tenant deploy. This repo has no supported Cloudflare Workers
> target yet; prefer DigitalOcean or the prebuilt container image
> (`ghcr.io/wyre-ai/connectwise-automate-mcp`).

## Features

- **Decision Tree Architecture**: Navigate between domains (computers, clients, alerts, scripts) to access relevant tools
- **Lazy Loading**: Client initialization and domain handlers are loaded on demand
- **Comprehensive API Coverage**: Manage computers, clients, alerts, and scripts
- **Interactive Device Card (MCP Apps)**: `cwautomate_computers_get` renders as a read-only interactive card in MCP Apps hosts (Claude Desktop/web); neutral by default, brandable via `window.__BRAND__` injection or `MCP_BRAND_*` env vars; plain-JSON behavior is unchanged in other hosts

## Installation

This package is published to the **GitHub Packages** npm registry, which requires a
token even for public packages. Authenticate once, then install:

```bash
# Authenticate npm to GitHub Packages (token needs the read:packages scope)
export NODE_AUTH_TOKEN=$(gh auth token)   # or a PAT with read:packages

npm install @wyre-ai/connectwise-automate-mcp
```

The repo's `.npmrc` already points the `@wyre-ai` scope at GitHub Packages and
reads the token from `NODE_AUTH_TOKEN`, so no further config is needed.

## Configuration

Copy [`.env.example`](.env.example) and set the variables below. The stdio transport reads `CW_AUTOMATE_*` and does not use `CONDUIT_S2S_SECRET`.

| Variable | Required | Description |
|----------|----------|-------------|
| `CW_AUTOMATE_SERVER_URL` | For stdio and `AUTH_MODE=env` | ConnectWise Automate server URL (e.g. `https://your-server.hostedrmm.com`) |
| `CW_AUTOMATE_CLIENT_ID` | For stdio and `AUTH_MODE=env` | ConnectWise Automate Client ID |
| `CW_AUTOMATE_USERNAME` | For stdio and `AUTH_MODE=env` | Integrator username or user login |
| `CW_AUTOMATE_PASSWORD` | For stdio and `AUTH_MODE=env` | Integrator password or user password |
| `CW_AUTOMATE_2FA_CODE` | No | Two-factor authentication code (forces `user` authentication) |
| `CW_AUTOMATE_AUTH_METHOD` | No | `integrator` (default) or `user` |
| `MCP_TRANSPORT` | No | `stdio` (default) or `http` |
| `AUTH_MODE` | No | `gateway` (Docker image and Compose default) or `env`. Gateway mode requires `X-CWA-Server`, `X-CWA-Client-ID`, `X-CWA-Username`, and `X-CWA-Password` on each `/mcp` request and never falls back to `CW_AUTOMATE_*`. `env` uses those variables only after S2S auth succeeds. |
| `CONDUIT_S2S_SECRET` | Yes for HTTP | Service-to-service secret. Generate with `openssl rand -hex 32`. The HTTP server logs an error and exits non-zero when this is empty or a known placeholder (`replace-with-a-real-secret`, `changeme`, and the other example values). The value is never logged. Compose will not start without it. Never commit a real value. |
| `MCP_ALLOW_INSECURE_DEV` | No | Set to exactly `1` only for local development to start HTTP without `CONDUIT_S2S_SECRET`. The process logs a warning and does not enforce `X-Gateway-S2S`. The listener is forced to `127.0.0.1`; a wider `MCP_HTTP_HOST` (including `0.0.0.0`) is ignored and the override is logged. A placeholder secret still refuses to start. |
| `MCP_HTTP_HOST` | No | Bind address when `MCP_TRANSPORT=http` and `CONDUIT_S2S_SECRET` is set. Defaults to `127.0.0.1`. The container image sets `0.0.0.0`. |
| `MCP_HTTP_PORT` | No | HTTP port. Defaults to `8080`. |

`/health` stays unauthenticated and does not read credentials.

### HTTP authentication

With `MCP_TRANSPORT=http` and a real `CONDUIT_S2S_SECRET`, every `/mcp` request must include `X-Gateway-S2S`. The header value is `t=<unix seconds>,v1=<hex>`, where the hex is HMAC-SHA256 of the literal string `t=<unix seconds>` keyed with `CONDUIT_S2S_SECRET` (64 lowercase hex characters). The timestamp must be within 300 seconds of the server clock. A missing or invalid header is HTTP 401, before vendor credentials are read.

```bash
TS=$(date +%s)
SIG=$(printf 't=%s' "$TS" | openssl dgst -sha256 -hmac "$CONDUIT_S2S_SECRET" -hex | awk '{print $NF}')
curl -sS http://127.0.0.1:8080/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-Gateway-S2S: t=${TS},v1=${SIG}" \
  -H "X-CWA-Server: https://your-server.hostedrmm.com" \
  -H "X-CWA-Client-ID: your-client-id" \
  -H "X-CWA-Username: your-username" \
  -H "X-CWA-Password: your-password" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

In `AUTH_MODE=gateway`, those `X-CWA-*` headers are the only credential source (`X-CWA-2FA` and `X-CWA-Auth-Method` are optional). A request missing any required header is HTTP 401 and does not use `CW_AUTOMATE_*` from the environment. With `AUTH_MODE=env`, the signed request uses the `CW_AUTOMATE_*` variables instead.

### Docker

The image listens on `0.0.0.0` inside the container (`MCP_HTTP_HOST`) and defaults to `AUTH_MODE=gateway`. Publish the port on loopback and pass the S2S secret. In gateway mode, Automate credentials arrive on each request as headers; they are not read from the environment.

```bash
docker build -t connectwise-automate-mcp .
docker run \
  -e CONDUIT_S2S_SECRET=your-s2s-secret \
  -p 127.0.0.1:8080:8080 \
  connectwise-automate-mcp
```

Compose refuses to start when `CONDUIT_S2S_SECRET` is unset, sets `AUTH_MODE=gateway`, does not inject `CW_AUTOMATE_*`, and publishes `127.0.0.1:8080:8080`:

```bash
CONDUIT_S2S_SECRET=your-s2s-secret docker compose up
```

Single-tenant HTTP (`AUTH_MODE=env`) still requires the S2S secret, then uses `CW_AUTOMATE_*`:

```bash
docker run \
  -e CONDUIT_S2S_SECRET=your-s2s-secret \
  -e AUTH_MODE=env \
  -e CW_AUTOMATE_SERVER_URL=https://your-server.hostedrmm.com \
  -e CW_AUTOMATE_CLIENT_ID=your-client-id \
  -e CW_AUTOMATE_USERNAME=your-username \
  -e CW_AUTOMATE_PASSWORD=your-password \
  -p 127.0.0.1:8080:8080 \
  connectwise-automate-mcp
```

Local HTTP without a secret is development-only. It binds `127.0.0.1` only and logs a warning. A non-loopback `MCP_HTTP_HOST` is overridden to `127.0.0.1`:

```bash
MCP_TRANSPORT=http MCP_ALLOW_INSECURE_DEV=1 node dist/index.js
```

The DigitalOcean App Platform template is single-tenant: it sets `AUTH_MODE=env` so the `CW_AUTOMATE_*` secrets stay the credential source, and it declares `CONDUIT_S2S_SECRET`. Set that secret in the App Platform UI or the container exits on boot.

### Authentication methods

The server supports both ConnectWise Automate authentication methods:

- **`integrator`** (default) – machine-to-machine integrator account. Recommended for automation. Does not use 2FA.
- **`user`** – interactive user login, which can supply a two-factor code.

You normally don't need to set `CW_AUTOMATE_AUTH_METHOD`: integrator auth is used by
default, and `user` auth is selected automatically when `CW_AUTOMATE_2FA_CODE` is
provided.

## Usage

### As an MCP Server

Add to your Claude configuration:

```json
{
  "mcpServers": {
    "connectwise-automate": {
      "command": "npx",
      "args": ["@wyre-ai/connectwise-automate-mcp"],
      "env": {
        "CW_AUTOMATE_SERVER_URL": "https://your-server.hostedrmm.com",
        "CW_AUTOMATE_CLIENT_ID": "your-client-id",
        "CW_AUTOMATE_USERNAME": "your-username",
        "CW_AUTOMATE_PASSWORD": "your-password"
      }
    }
  }
}
```

### Navigation

The server uses a decision tree pattern. Start by navigating to a domain:

1. Use `cwautomate_navigate` to select a domain (computers, clients, alerts, scripts)
2. Domain-specific tools become available
3. Use `cwautomate_back` to return to the main menu

### Available Domains

#### Computers
- List computers with filtering options
- Get computer details
- Search computers by name
- `cwautomate_computers_reboot` and `cwautomate_computers_run_command` queue commands and return immediately by default with `queued: true` and an `execution_id`. Optional `wait_seconds` waits up to 20 seconds (default 0); `run_command` also accepts legacy `timeout_seconds`, with `wait_seconds` taking precedence.
- `cwautomate_commands_list` lists catalog command IDs.
- `cwautomate_computers_command_status` reads an execution using `computer_id` and `execution_id`; poll this tool for completion.
- Duplicate-command HTTP 400 responses return a non-error `{ queued: false, already_queued: true }` result. Never re-issue after a timeout or duplicate result: read the original execution or check command history in Automate.
- Run scripts on computers; `cwautomate_computers_run_script` accepts `timeout_seconds` (default 20, capped at 20).

#### Clients
- List all clients
- Get client details
- Create new clients
- Update existing clients

#### Alerts
- List alerts with filtering (read-only in the Automate API)
- Get alert details

#### Scripts
- List available scripts
- Get script details
- Execute scripts on computers. `cwautomate_scripts_execute` waits 20 seconds by default, with `timeout_seconds` capped at 20. A partial result means the script is still running; read `cwautomate_scripts_history` and do NOT launch again.

## Troubleshooting

Automate 500 'Encountered unhandled exception' on scripts_execute: the server now logs the request shape (keys only, no parameter values) and Automate's response body. Credential-like values in the response body are redacted and the body is capped at 2000 characters.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Type check
npm run typecheck

# Lint
npm run lint
```

## License

Apache-2.0
