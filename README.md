# LocalLink Phase 1 MVP

LocalLink Phase 1 is a local-first orchestration MVP for a single developer workstation. It combines a Node + TypeScript control plane, a loopback-only HTTP dashboard, and an MCP stdio server so local tools and AI agents can inspect config, allocate ports, and trigger lifecycle actions from one place.

## What is implemented

- Node + TypeScript backend/control plane
- Local-only HTTP dashboard server, bound by default to `127.0.0.1`
- Static frontend/PWA assets in `public/`
  - `/` launcher
  - `/dashboard` dashboard
  - `/template` template preview
  - `manifest.webmanifest` + `sw.js`
- MCP stdio server with four tools:
  - `read_infra_config`
  - `write_infra_config`
  - `get_available_port`
  - `execute_task`
- Infra source of truth in:
  - `.env`
  - `.env.example`
  - `docker-compose.yml`
  - `ecosystem.config.js`
- Sample topology already declared in `docker-compose.yml`, `ecosystem.config.js`, and `Taskfile.yml`
- Backend endpoints for state, config editing, port allocation, task execution, and log streaming
- Live dashboard state rehydrated from Docker, PM2, and Windows process probes on each read, with last-known browser snapshot fallback for relaunches

The sample topology currently includes:

- Docker: `postgres`
- PM2/PWA: `LocalLink MCP Core`, `Queue Worker`, `LocalLink Dashboard UI`
- Taskfile-backed placeholders: `Windows File Indexer`, `AgentGateway Proxy`

## Install and run

### Prerequisites

- Node.js + pnpm
- Optional but required for live lifecycle control: `docker`, `pm2`, and `task`
- WSL + `tasklist.exe` if you want Windows process detection

LocalLink now runs startup diagnostics on boot and through `locallink doctor`. Missing PM2, Docker, Task, PWA assets, or Node runtime packages are surfaced with install guidance instead of failing silently.

### Setup

```bash
pnpm install
cp .env.example .env
```

`.env.example` ships with these defaults:

- `LOCALLINK_BIND_HOST=127.0.0.1`
- `LOCALLINK_WEB_PORT=4010`
- `LOCALLINK_DEFAULT_PORT_START=5000`
- `LOCALLINK_ENABLE_PHASE2_ADVISOR=true`
- `LOCALLINK_PHASE2_PREFERRED_EDGE=auto`

### Build

```bash
pnpm build
```

### Run the packaged CLI

```bash
pnpm doctor
pnpm start
```

LocalLink ships as a single CLI entrypoint in `bin/locallink.js`. Inside this repository, the pnpm scripts call that CLI for you:

```bash
node ./bin/locallink.js init
pnpm start
pnpm mcp
pnpm snapshot
pnpm doctor
node ./bin/locallink.js web --log-level debug
```

If you want the `locallink` command directly on your machine, link the package once:

```bash
pnpm link --global
locallink web
locallink mcp
locallink snapshot --log-level debug
```

When you launch `locallink` from another folder, it reads `.env`, `docker-compose.yml`, and `ecosystem.config.js` from that current working directory.
Use `--log-level debug` or `LOCALLINK_LOG_LEVEL=debug` when you want stderr traces for startup, state discovery, HTTP requests, and runtime probe failures.

Open:

- `http://127.0.0.1:4010/` - launcher
- `http://127.0.0.1:4010/dashboard` - dashboard
- `http://127.0.0.1:4010/template` - static template preview

### Run the MCP server directly

```bash
pnpm mcp
```

This starts the LocalLink MCP server on stdio for an MCP-capable client.

### Scaffold a new workspace

```bash
locallink init
locallink init my-local-infra
```

`locallink init` creates:

- `.env`
- `.env.example`
- `.gitignore`
- `Taskfile.yml`
- `docker-compose.yml`
- `ecosystem.config.js`
- `mcp-registry.json`
- `AGENTS.md`
- `README.md` or `README.locallink.md` if a README already exists

The generated starter config includes the Dockerfile blueprint convention, optional service metadata fields, the Phase 2 advisor toggle, and the agent guardrails file.

### Dev/test helpers

```bash
pnpm dev
pnpm dev:mcp
pnpm test
```

## HTTP API

All dashboard APIs are local-only and served from the same process as the UI.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/state` | Rebuilds the current dashboard snapshot from external runtime managers: services, ports, PWA status, logs, and constraints. |
| `GET` | `/api/configs` | Returns the raw infra files plus the derived service list. |
| `POST` | `/api/configs` | Writes one infra file using full `content` or a structured `patch`. |
| `POST` | `/api/ports/next` | Returns the next free local port, optionally starting from a supplied number. |
| `POST` | `/api/tasks` | Executes a lifecycle action for a declared service and returns the result plus a fresh snapshot. |
| `GET` | `/api/processes/:pid` | Inspect one local process with CPU, RAM, uptime, parent PID, and full command. |
| `POST` | `/api/processes/:pid/terminate` | Send `SIGTERM` or `SIGKILL` to a selected local process, then refresh the dashboard snapshot. |
| `GET` | `/api/logs/stream` | Server-sent events stream of lifecycle, Docker, and PM2 log lines. |

HTTP request bodies use camelCase:

- `/api/configs`: `{ "targetFile": "...", "content"?: "...", "patch"?: { ... } }`
- `/api/ports/next`: `{ "startFrom"?: 5000 }`
- `/api/tasks`: `{ "runtime": "docker|pm2|taskfile", "serviceName": "...", "action": "start|stop|restart|up" }`

## MCP tools

MCP inputs use snake_case:

| Tool | Input | Purpose |
| --- | --- | --- |
| `read_workspace_blueprint` | none | Returns a structural view of `.env`, `.env.example`, `docker-compose.yml`, `ecosystem.config.js`, and `mcp-registry.json`. |
| `patch_workspace_blueprint` | `target_file`, `content?`, `patch_payload?` | Updates one source-of-truth file with either raw content or a supported structured patch. |
| `allocate_system_port` | `preferred_start?` | Scans for the next sequentially free local port. |
| `verify_blueprint_compliance` | `service_name` | Checks whether a declared local service has a readable Dockerfile blueprint. |
| `orchestrate_service` | `runtime`, `service_name`, `action` | Runs Docker, PM2, or Taskfile lifecycle commands for a declared service. |

## Configuration model and patch expectations

LocalLink treats these files as the committable infra contract:

- `.env`: active local values
- `.env.example`: shareable defaults/template
- `docker-compose.yml`: Docker services plus `locallink.*` labels for UI/runtime metadata
- `ecosystem.config.js`: PM2/PWA/Windows/taskfile app definitions plus `locallink` metadata
- `mcp-registry.json`: optional registry for local-build MCP servers and mapped external volumes

Service discovery is metadata-driven:

- Docker services come from `docker-compose.yml > services`
- PM2, PWA, Windows, and taskfile-backed services come from `ecosystem.config.js > module.exports.apps`
- PM2 apps use slug-safe internal `name` values for reliable PM2 lifecycle control; the dashboard display name comes from `locallink.name`
- Native PM2 services can declare `locallink.dockerfile`, which LocalLink parses as a static blueprint (`EXPOSE`, `ENV`, `CMD` / `ENTRYPOINT`)
- PM2 and task-backed services can declare `locallink.dockerfile`; LocalLink surfaces that Dockerfile as blueprint metadata and warns when the declared blueprint is missing
- Taskfile-backed placeholder services use `taskName`/`runtimeName` from `ecosystem.config.js`, with commands resolved from `Taskfile.yml`

Optional service metadata now supported in both config surfaces:

| Field | Compose label | Ecosystem metadata | Purpose |
| --- | --- | --- | --- |
| Dependencies | `locallink.dependsOn` | `dependsOn` | Upstream services this service needs before it is useful |
| Downstream | `locallink.downstream` | `downstream` | Services or consumers that depend on this service |
| Env vars | `locallink.envVars` | `envVars` | Relevant environment variables to look at when operating the service |
| Docs link | `locallink.docsUrl` | `docsUrl` | Canonical external documentation for the service |
| Dockerfile blueprint | n/a | `dockerfile` | Declarative Dockerfile path for Dockerfile-as-blueprint parsing on native PM2 services |

Dependency and downstream metadata render as clickable service links in the dashboard so you can jump straight to the referenced service card and use its lifecycle actions there.

Prefer structured patches when possible:

```json
{ "kind": "env", "set": { "LOCALLINK_WEB_PORT": "4011" }, "unset": ["OLD_PORT"] }
```

```json
{
  "kind": "compose",
  "serviceName": "postgres",
  "updates": {
    "ports": ["5433:5432"],
    "labels": { "locallink.name": "Postgres Compose" }
  }
}
```

```json
{
  "kind": "ecosystem",
  "appName": "Queue Worker",
  "updates": {
    "env": { "PORT": { "sourceEnv": "QUEUE_WORKER_PORT" } },
    "locallink": { "group": "pm2", "runtime": "pm2" }
  }
}
```

Practical MVP rules:

- `write_infra_config` must target exactly one of the four source-of-truth files.
- Supported patches are intentionally narrow:
  - env patches set/unset keys
  - compose patches update one service at a time
  - ecosystem patches update one app at a time
- `ecosystem.config.js` patch support expects `module.exports = { apps: [...] }`.
- `{ "sourceEnv": "NAME" }` inside an ecosystem env patch writes `process.env.NAME`.
- If you need a shape the patcher does not support, send full `content` instead of a structured patch.
- Supported patch flows aim to preserve existing comments/formatting where practical.
- Task execution targets the LocalLink service `name` exposed by the config model.

## Assumptions and limitations

- Phase 1 is local-only by default: the dashboard binds to `127.0.0.1` unless you change `.env`.
- The HTTP dashboard is the only network listener here; the implemented MCP server is stdio-based, not an HTTP/TCP MCP endpoint.
- LocalLink treats Docker, PM2, and Windows process probes as the source of truth for service state; restarting LocalLink triggers a fresh runtime re-query instead of trusting stale in-memory state.
- If Docker, PM2, or Windows probing is unavailable, or a declared service has no trustworthy runtime probe, the dashboard reports that service as `Unknown` instead of guessing `Down`.
- Windows process detection is WSL-only and allowlist-based: a service is considered present only if `windowsProcessName` is declared in `ecosystem.config.js` and found via `tasklist.exe`.
- Live lifecycle control and log tailing depend on external binaries existing on `PATH`:
  - Docker flows call `docker`
  - PM2 flows call `pm2`
  - Taskfile flows call `task`
- Startup checks warn when those binaries are missing and the CLI/API error payloads include install guidance.
- `execute_task` only works for services already declared in `docker-compose.yml` or `ecosystem.config.js`.
- Blueprint compliance is warning-only in this MVP: LocalLink surfaces missing Dockerfile blueprints in the dashboard and logs, but it does not block lifecycle actions.
- The Resource view reads the current host process table, flags high CPU / RAM consumers, and exposes inspect / terminate actions for local processes.
- The Phase 2 advisor is opt-out. Set `LOCALLINK_ENABLE_PHASE2_ADVISOR=false` to suppress Tailscale and reverse-proxy suggestions entirely.
- Taskfile-backed services are placeholders in this MVP; the sample `Taskfile.yml` currently echoes start/stop/restart actions.
- Taskfile lifecycle lookup is convention-based: LocalLink tries `<taskName>:<action>` and `<action>:<taskName>`; for `up` it tries `<taskName>:up` and then `<taskName>`.
- The service worker caches shell assets only; `/api/*` routes are not cached. Live dashboard pages separately retain the last successful `/api/state` snapshot in browser storage so relaunches can reopen with the most recent live view while the API reconnects.
- Port suggestions are sequential and only count as free when the port is available on both `127.0.0.1` and `0.0.0.0`.
