# connectwise-automate-mcp

MCP server over `@wyre-ai/node-connectwise-automate`. The client library, not this
server, owns the knowledge of which Automate routes exist; when a tool needs something
the library lacks, check the library's `CLAUDE.md` and the official swagger before
adding a route here.

## Working here

- `npm test` (vitest, SDK mocked per domain), `npm run typecheck`, `npm run lint`,
  `npm run build` (tsc; the device-card HTML is a committed generated file).
- `CHANGELOG.md` is hand-maintained (keepachangelog); add to `[Unreleased]`.
- `@wyre-ai/*` and `@wyre-technology/*` both resolve to GitHub Packages via the project
  `.npmrc`; installs need a token with `read:packages` in `NODE_AUTH_TOKEN`
  (`gh auth refresh -s read:packages` locally; `GITHUB_TOKEN` in CI).

## Learnings - 2026-09-08

- Filtering on Automate list routes is only possible through the `condition`
  expression. Any other filter sent as a query parameter is silently ignored and the
  route returns everything — this bit `cwautomate_scripts_list` (`name`), the alert
  filters, the client filter on locations and `folder_id`. Build conditions with
  `src/utils/odata.ts` (`containsCondition`, `equalsCondition`, `andConditions`).
- There is no reboot route. A reboot is a catalog command
  (`GET /Commands` → `POST /Computers/{id}/CommandExecute`), and catalog ids/names are
  instance-defined, so `cwautomate_computers_reboot` auto-resolves by name and accepts
  an explicit `command_id`.
- Alerts are read-only in the API and carry no status field; the acknowledge tool was
  calling a route that does not exist.
- Script and command results: commands are correlated by the execution id Automate
  returns; script runs have no handle at all and are recovered from
  `ScriptHistory` by identity against a pre-launch baseline.
- `results.ts` tolerates both a bare array and a `{ Data }` envelope on purpose; since
  library v3 the wire shape is always the bare array.
