# ConnectWise Automate MCP Server

A Model Context Protocol (MCP) server for ConnectWise Automate with decision tree architecture for Claude.

## One-Click Deployment

> [!IMPORTANT]
> **Before you click:** this server depends on `@wyre-technology/node-connectwise-automate`,
> which is hosted on the **GitHub Packages** npm registry. GitHub Packages has no
> anonymous access — even though the package is public, every `npm install` needs a
> token. The cloud builder runs `npm install` for you, so you must give it one, or
> the build fails with `npm error 401 Unauthorized ... npm.pkg.github.com`.
>
> 1. Create a GitHub **Personal Access Token** with the `read:packages` scope
>    ([classic token](https://github.com/settings/tokens/new?scopes=read:packages&description=connectwise-automate-mcp%20deploy)).
>    Any GitHub account works — you do **not** need to be a member of the
>    `wyre-technology` org to read its public packages.
> 2. Add it as a build variable when prompted by the deploy flow:
>    - **Cloudflare Workers** → set a build variable named **`NODE_AUTH_TOKEN`** to your PAT
>      (Workers → Settings → Build → Variables and Secrets).
>    - **DigitalOcean App Platform** → set an encrypted env var named **`GITHUB_TOKEN`**
>      with scope **Build Time** to your PAT (the `.do/deploy.template.yaml` already declares it).

[![Deploy to DO](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/wyre-technology/connectwise-automate-mcp/tree/main)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wyre-technology/connectwise-automate-mcp)

> [!NOTE]
> The DigitalOcean target builds the full Docker image and runs the complete MCP
> server over HTTP — this is the recommended path for operators. This repo has no
> Cloudflare Workers entrypoint (`src/worker.ts`), so the Workers button is not a
> supported target yet; prefer DigitalOcean or the prebuilt container image
> (`ghcr.io/wyre-technology/connectwise-automate-mcp`).

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

npm install @wyre-technology/connectwise-automate-mcp
```

The repo's `.npmrc` already points the `@wyre-technology` scope at GitHub Packages and
reads the token from `NODE_AUTH_TOKEN`, so no further config is needed.

## Configuration

Set the following environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `CW_AUTOMATE_SERVER_URL` | Yes | Your ConnectWise Automate server URL (e.g. `https://your-server.hostedrmm.com`) |
| `CW_AUTOMATE_CLIENT_ID` | Yes | ConnectWise Automate Client ID |
| `CW_AUTOMATE_USERNAME` | Yes | Integrator username or user login |
| `CW_AUTOMATE_PASSWORD` | Yes | Integrator password or user password |
| `CW_AUTOMATE_2FA_CODE` | No | Two-factor authentication code (forces `user` authentication) |
| `CW_AUTOMATE_AUTH_METHOD` | No | `integrator` (default) or `user` |

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
      "args": ["@wyre-technology/connectwise-automate-mcp"],
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
- Reboot computers remotely
- Run scripts on computers

#### Clients
- List all clients
- Get client details
- Create new clients
- Update existing clients

#### Alerts
- List alerts with filtering
- Get alert details
- Acknowledge alerts

#### Scripts
- List available scripts
- Get script details
- Execute scripts on computers

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
