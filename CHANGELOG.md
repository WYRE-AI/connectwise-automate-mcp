## [Unreleased]

### Added

- **Script runs now wait for their result instead of reporting "queued".** `cwautomate_scripts_execute` and `cwautomate_computers_run_script` launch the script, then poll Automate's script history until it reaches a terminal state, returning the per-computer verdict (`Success` / `Failure` / `Information`) and Automate's `DiagnosticMessage` — the only failure reason the API exposes. Automate has no synchronous run and hands back no job ID, so the outcome has to be recovered from history; runs are correlated by history-row identity against a pre-launch baseline, which is immune to clock skew and cannot latch onto a run that was already in flight. A run that outlasts `timeout_seconds` (default 90) returns `completed: false` and keeps running server-side. Pass `wait: false` for the old fire-and-forget behaviour.
- **`cwautomate_scripts_history` and `cwautomate_scripts_running`** — read a computer's completed script runs and its currently-running scripts. These are how you pick up the result of a run launched with `wait: false`, or one that outlasted its timeout.
- **`cwautomate_commands_list` and `cwautomate_computers_run_command`** — the Automate command catalog and catalog-command execution with result polling. The catalog was previously unreachable, so there was no way to discover valid command IDs. Note that the API user's command level and the group-level "Send Commands" grant silently cap which commands may be issued.
- **Interactive device card via MCP Apps (SEP-1865).** `cwautomate_computers_get` results now render as an interactive card in MCP Apps hosts (Claude Desktop/web, and other hosts advertising the `io.modelcontextprotocol/ui` extension), instead of a wall of JSON. The card shows the device name, online status, type, client and location as human-readable labels, OS, last user, IP address, serial number, agent version, and last contact. The card is read-only — no write actions. Non-App hosts are unaffected: the tool's JSON payload is unchanged apart from a new `_card` field.
  - The renderable tool advertises the UI via `_meta` (`ui/resourceUri`, plus the nested `ui.resourceUri` form) pointing at a new `ui://cwautomate/device-card.html` resource served as `text/html;profile=mcp-app`. The card HTML is a self-contained vite single-file bundle embedded at build time (`src/generated/device-card-html.ts`, committed), so it serves identically from stdio, Node HTTP, and the fs-less Cloudflare Workers runtime. The server now declares the `resources` capability and answers `resources/list` / `resources/read` (`src/resources.ts`).
  - The card is neutral by default (system fonts, no vendor identity, no external fetches) and brandable via `window.__BRAND__` injection or `MCP_BRAND_*` env vars (`MCP_BRAND_NAME`, `MCP_BRAND_LOGO_URL`, `MCP_BRAND_PRIMARY_COLOR`, `MCP_BRAND_ACCENT_COLOR`, `MCP_BRAND_BG`, `MCP_BRAND_TEXT`): at serve time the server replaces the card's BRAND_INJECT marker with an inline, `<`-escaped `window.__BRAND__` script, so self-hosters can theme the card without rebuilding. No brand configured = HTML served unchanged.

### Fixed

- **Script execution never ran, and issued commands came back terminated.** The client library called script endpoints that do not exist on ConnectWise Automate (`POST /Scripts/Execute`, `GET /Scripts/Executions`, `GET /Scripts/Folders`), and posted commands in a shape Automate cannot bind. Verified against ConnectWise's published OpenAPI 3.0 spec for Automate API v1.
  - Commands are a fixed, server-defined catalog addressed by ID. We sent a flat free-text `{ Command: "ipconfig /all", PowerShell: true }`; Automate expects `{ ComputerId, Command: { Id }, Parameters: string[] }`. Every field bound to null, so the agent received an empty command and the run terminated on arrival — over HTTP 200, which is why nothing surfaced as an error.
  - Scripts now launch through `POST /Batch/ScriptExecute`, which covers every target in one call and returns per-target acceptance, so a target the server refused (permissions, unknown ID) is distinguishable from one whose script is merely still running.
  - Fixed in `@wyre-technology/node-connectwise-automate` v2.0.0 ([node-connectwise-automate#72](https://github.com/wyre-technology/node-connectwise-automate/pull/72)).
- **Script and command tools reported `success: true` regardless of what happened.** The result was hardcoded, so a rejected or failed run was indistinguishable from a successful one. Both now report the run's real outcome.
- **All API-backed tools returned `{}` and then failed with "Body is unusable: Body has already been read"** ([#54](https://github.com/wyre-technology/connectwise-automate-mcp/issues/54)). Root cause was in the client library's HTTP layer: the error path consumed the response body twice, and a 200 with a non-JSON body (hosted-Automate WAF/proxy pages) was silently returned as an empty object. Fixed in `@wyre-technology/node-connectwise-automate` v1.0.4 ([node-connectwise-automate#54](https://github.com/wyre-technology/node-connectwise-automate/pull/54)): bodies are read exactly once, JSON parses regardless of a mislabeled content-type header, and a non-JSON 200 raises a descriptive error carrying the content-type and a body snippet instead of masquerading as an empty success.
- **The client library was not declared as a dependency.** `package.json` listed only `@modelcontextprotocol/sdk` while the code dynamically imports `@wyre-technology/node-connectwise-automate` at runtime (an orphaned lockfile entry masked this locally). Now declared explicitly at `^1.0.4`, so `npx`/fresh installs always resolve the client — and always get the fixed HTTP layer.

- **Deploy buttons:** authenticate against the GitHub Packages npm registry during
  one-click cloud builds. The `@wyre-technology/node-connectwise-automate` dependency
  lives on GitHub Packages, which has no anonymous read, so `npm install` failed with
  `401 Unauthorized` on DigitalOcean. Operators now supply a `read:packages` PAT as a
  build variable (`GITHUB_TOKEN` build-time secret for DigitalOcean, `NODE_AUTH_TOKEN`
  for Cloudflare Workers). The `.npmrc` reads the token and `.do/deploy.template.yaml`
  declares the build-time secret. Part of the fleet-wide fix mirroring
  wyre-technology/ninjaone-mcp#35.
- **CI (`mcp-assert`):** added an in-process regression guard
  (`src/__tests__/mcp-assert-contract.test.ts`) that pins the same baseline
  contract the `mcp-assert` check enforces — the `cwautomate_scripts_list`
  canary is registered upfront and returns `isError` without credentials, and
  unknown tools return `isError`. The check went red once on 2026-06-05 from a
  transient upstream failure downloading the `mcp-assert` binary (HTTP 403),
  not a code defect; both assertions pass on `main`. This test makes the
  contract enforceable by `npm test` so a real source regression (e.g.
  re-introducing an HTTP transport default or gating the canary behind
  navigation) is caught locally instead of only by the external check.

### Changed

- **Publishing:** the package now publishes to the GitHub Packages npm registry
  (`@semantic-release/npm` `npmPublish: true`), aligning with the rest of the
  `@wyre-technology` fleet.

## [1.3.3](https://github.com/wyre-technology/connectwise-automate-mcp/compare/v1.3.2...v1.3.3) (2026-04-06)


### Bug Fixes

* per-request MCP Server+Transport for gateway compatibility ([3a16ac3](https://github.com/wyre-technology/connectwise-automate-mcp/commit/3a16ac3a5edad2d5e58a3db69c6c3d8ca570887d))

## [1.3.2](https://github.com/wyre-technology/connectwise-automate-mcp/compare/v1.3.1...v1.3.2) (2026-03-31)


### Bug Fixes

* **deploy:** replace node_compat with nodejs_compat for Wrangler v4 ([249f04b](https://github.com/wyre-technology/connectwise-automate-mcp/commit/249f04bfdb65606d8faf627111e575c6a225a97b))

## [1.3.1](https://github.com/wyre-technology/connectwise-automate-mcp/compare/v1.3.0...v1.3.1) (2026-03-10)


### Bug Fixes

* **lint:** use const for locationId (never reassigned) ([6a23f80](https://github.com/wyre-technology/connectwise-automate-mcp/commit/6a23f8051d78837e0a5223d5e91f9f52307becb9))

# [1.3.0](https://github.com/wyre-technology/connectwise-automate-mcp/compare/v1.2.5...v1.3.0) (2026-03-10)


### Features

* **elicitation:** add MCP elicitation support with graceful fallback ([#1](https://github.com/wyre-technology/connectwise-automate-mcp/issues/1)) ([cefce30](https://github.com/wyre-technology/connectwise-automate-mcp/commit/cefce3069d6d1fdca9f4f5259a4ced05340e615e))

## [1.2.5](https://github.com/wyre-technology/connectwise-automate-mcp/compare/v1.2.4...v1.2.5) (2026-03-02)


### Bug Fixes

* **ci:** use Node 22 in release job for semantic-release v25 compatibility ([ab5fd65](https://github.com/wyre-technology/connectwise-automate-mcp/commit/ab5fd65c7760016f9fdec001e71297017f8fd3e8))

## [1.2.4](https://github.com/wyre-technology/connectwise-automate-mcp/compare/v1.2.3...v1.2.4) (2026-03-02)


### Bug Fixes

* **ci:** fix broken YAML in Discord notification step ([2bac5e8](https://github.com/wyre-technology/connectwise-automate-mcp/commit/2bac5e8203a6e14f5878658814aebb87757a58db))
* **deps:** upgrade semantic-release to ^25.0.0 for github plugin compatibility ([a5271e7](https://github.com/wyre-technology/connectwise-automate-mcp/commit/a5271e7ee6a820f0a6efb93c6bfb04f5b439a362))

## [1.2.3](https://github.com/wyre-technology/connectwise-automate-mcp/compare/v1.2.2...v1.2.3) (2026-02-26)


### Bug Fixes

* **ci:** move Discord notification into release workflow ([162ea77](https://github.com/wyre-technology/connectwise-automate-mcp/commit/162ea77269fb745e01b0c38e2a83017203ef0322))

## [1.2.2](https://github.com/wyre-technology/connectwise-automate-mcp/compare/v1.2.1...v1.2.2) (2026-02-18)


### Bug Fixes

* **ci:** convert pack-mcpb.js to ESM imports ([c0d6c51](https://github.com/wyre-technology/connectwise-automate-mcp/commit/c0d6c51b0e1708f781928580bb6028cbe42bcb9d))

## [1.2.1](https://github.com/wyre-technology/connectwise-automate-mcp/compare/v1.2.0...v1.2.1) (2026-02-18)


### Bug Fixes

* use npm install in Dockerfile for lock file compatibility ([afe02b3](https://github.com/wyre-technology/connectwise-automate-mcp/commit/afe02b340d6b8dfd60e8b89625cc619114d2e422))

# [1.2.0](https://github.com/wyre-technology/connectwise-automate-mcp/compare/v1.1.0...v1.2.0) (2026-02-18)


### Bug Fixes

* **ci:** fix release workflow failures ([3107f4c](https://github.com/wyre-technology/connectwise-automate-mcp/commit/3107f4c4ed7abb3e32bb6cbb55836ce390b40e35))
* **docker:** drop arm64 platform to fix QEMU build failures ([29951e6](https://github.com/wyre-technology/connectwise-automate-mcp/commit/29951e6cec869b9ef93695f1639cc5806ac74a18))
* use npm install instead of npm ci for lock file compatibility ([2c0134a](https://github.com/wyre-technology/connectwise-automate-mcp/commit/2c0134abd794e71313cec9203f4f89f67dd99648))


### Features

* add MCPB bundle to release workflow ([bdab179](https://github.com/wyre-technology/connectwise-automate-mcp/commit/bdab1791ea198b523db877773026bd89665b9b20))
* add MCPB manifest for desktop installation ([7661d6c](https://github.com/wyre-technology/connectwise-automate-mcp/commit/7661d6ccf31fc5347bdf0eab833d993801b361ac))
* add MCPB pack script ([396e797](https://github.com/wyre-technology/connectwise-automate-mcp/commit/396e7978cb78ae15aa8851f8bb7d63e85952cf6d))

# [1.1.0](https://github.com/wyre-technology/connectwise-automate-mcp/compare/v1.0.0...v1.1.0) (2026-02-17)


### Bug Fixes

* **ci:** fix release workflow with npm auth, Node 22, and Docker build ([3b81a43](https://github.com/wyre-technology/connectwise-automate-mcp/commit/3b81a4338608a687491d5de2e6d625009549d1b3))
* **ci:** remove old [@asachs01](https://github.com/asachs01) scope from .npmrc ([7fa6cb7](https://github.com/wyre-technology/connectwise-automate-mcp/commit/7fa6cb72a484a068804b37e5c5fce938dc64acd8))
* **ci:** replace Dockerfile with proper multi-stage build ([e73dbb6](https://github.com/wyre-technology/connectwise-automate-mcp/commit/e73dbb686e0a1922a5c1142ce6b8ff17d57bb858))
* **ci:** revert ci.yml release job scope to [@asachs01](https://github.com/asachs01) ([e86c99e](https://github.com/wyre-technology/connectwise-automate-mcp/commit/e86c99e793c4cfe74d14d45632c798a967f7d9a7))
* **ci:** revert release.yml npm config to [@asachs01](https://github.com/asachs01) scope ([5c879ed](https://github.com/wyre-technology/connectwise-automate-mcp/commit/5c879ed123f9b18273c6c1fc583535aa4e44c9fb))
* **ci:** update dependency scope from [@asachs01](https://github.com/asachs01) to [@wyre-technology](https://github.com/wyre-technology) ([c9e78bc](https://github.com/wyre-technology/connectwise-automate-mcp/commit/c9e78bce9ecfc6fb08737d27e6ac6f15e9caad9f))
* **docker:** use [@asachs01](https://github.com/asachs01) scope in .npmrc during build ([80e92aa](https://github.com/wyre-technology/connectwise-automate-mcp/commit/80e92aac2343ed0d72e515586ba9462c9dffea7a))
* escape newlines in .releaserc.json message template ([bd71ee4](https://github.com/wyre-technology/connectwise-automate-mcp/commit/bd71ee4dc67a82fd4dc93ccf9c29e7bf345c40da))
* revert .npmrc to [@asachs01](https://github.com/asachs01) scope for GitHub Packages registry ([4ee14cf](https://github.com/wyre-technology/connectwise-automate-mcp/commit/4ee14cfb76cafd9b10d545f4f097c86830765de6))
* revert peerDependencies to [@asachs01](https://github.com/asachs01) scope (package not published under [@wyre-technology](https://github.com/wyre-technology)) ([9292efc](https://github.com/wyre-technology/connectwise-automate-mcp/commit/9292efc6d9726f93d34bbbd196e592f098db54ee))


### Features

* add mcpb packaging support ([891251c](https://github.com/wyre-technology/connectwise-automate-mcp/commit/891251c7b38dccb1833fbea0d8c3bd20903d8f85))
* add mcpb packaging support ([0f019fd](https://github.com/wyre-technology/connectwise-automate-mcp/commit/0f019fdb88260aff2361886e0a4939e0ea9ed86d))
* add mcpb packaging support ([b47adfb](https://github.com/wyre-technology/connectwise-automate-mcp/commit/b47adfbef4ad41b24267ccb4a5faf4938f6fb5d4))
* add mcpb packaging support ([b572546](https://github.com/wyre-technology/connectwise-automate-mcp/commit/b572546b9d7496ee1eaf52c6738939303bb320e3))
* add mcpb packaging support ([2f3057b](https://github.com/wyre-technology/connectwise-automate-mcp/commit/2f3057b60183dbafcd0fb02334636b044e762afe))

# 1.0.0 (2026-02-13)


### Bug Fixes

* **ci:** Add GitHub Packages auth to test job for scoped dependency ([24f6717](https://github.com/wyre-technology/connectwise-automate-mcp/commit/24f671752b30411d2998916e25185f1c459fb2eb))
* **ci:** Fix workflow scope and regenerate lock file ([e534672](https://github.com/wyre-technology/connectwise-automate-mcp/commit/e5346724761eba88af14ff24b381d176564a26c8))


### Features

* add deploy infrastructure (docker-compose, DO, Cloudflare) and badges ([5a4c94e](https://github.com/wyre-technology/connectwise-automate-mcp/commit/5a4c94eaf6022c4d604b3eca7fa872ac0e534076))
* Initial ConnectWise Automate MCP server with decision tree architecture ([3202229](https://github.com/wyre-technology/connectwise-automate-mcp/commit/320222947f78f2d79b8a0d6ddc8576a5d204c242))

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- HTTP Streamable transport mode (`MCP_TRANSPORT=http`) on configurable port/host
- Gateway credential injection via `X-CWA-Server`, `X-CWA-Client-ID`, `X-CWA-Username`, `X-CWA-Password` headers
- Per-request credential isolation (no process.env mutation) for multi-tenant gateway deployments
- `/health` endpoint for container health checks
- `createClientDirect()`, `setClientOverride()`, `clearClientOverride()` in client utility
- Graceful shutdown on SIGINT/SIGTERM for HTTP transport
- Unhandled rejection and uncaught exception handlers
- Initial release of ConnectWise Automate MCP server
- Decision tree architecture with domain navigation
- Computers domain with list, get, search, reboot, and run script tools
- Clients domain with list, get, create, and update tools
- Alerts domain with list, get, and acknowledge tools
- Scripts domain with list, get, and execute tools
- Lazy loading for client initialization and domain handlers
- Comprehensive Vitest test suite
- Docker support

[Unreleased]: https://github.com/wyre-technology/connectwise-automate-mcp/compare/HEAD
