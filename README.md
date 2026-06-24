# LocalLink Phase 1 MVP

LocalLink Phase 1 is a local-first orchestration MVP for a single developer workstation. It combines a Node + TypeScript control-plane API, an optional loopback-only dashboard, and an MCP stdio server so local tools and AI agents can inspect config, allocate ports, and trigger lifecycle actions from one place.

## What is implemented

- Node + TypeScript backend/control plane
- Headless local HTTP API server by default, bound to a loopback host in Phase 1
- Optional dashboard surface launched with `locallink dashboard`
- Static frontend/PWA assets in `public/`
  - `/` launcher
  - `/dashboard` dashboard
  - `/template` template preview
  - `/docs` static project documentation
  - `manifest.webmanifest` + `sw.js`
- MCP stdio server with blueprint, extension, version, trial, port, and lifecycle tools
- AI-aware CLI affordances: `--json`, `status`, `ai`, idempotent `up`/`down`, and `.locallink/runtime.json`
- System workspace source of truth in `examples/systems/local-dev/`:
  - `.env`
  - `.env.example`
  - `docker-compose.yml`
  - `locallink.services.yml`
  - `locallink.lock.json`
  - `locallink.extensions.yml`
  - `ecosystem.config.js`
- Sample topology already declared under `examples/systems/local-dev/` in `docker-compose.yml`, `locallink.services.yml`, Dockerfile-style blueprints, and `Taskfile.yml`
- Backend endpoints for state, config editing, port allocation, task execution, and log streaming
- Live dashboard state rehydrated from Docker, PM2, and Windows process probes on each read, with last-known browser snapshot fallback for relaunches

The sample topology currently includes:

- Docker: `postgres`
- PM2: `LocalLink MCP Core`, `Queue Worker`
- Extensions: optional `dashboard`, `caddy`, `tailscale`, and `openobserve`
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
```

The repo ships one runnable system fixture at `examples/systems/local-dev`. Its committed `.env` uses non-secret test values:

- `LOCALLINK_BIND_HOST=127.0.0.1`
- `LOCALLINK_SYSTEM_ID=local-dev`
- `COMPOSE_PROJECT_NAME=locallink_local_dev`
- `PM2_HOME=.locallink/pm2/local-dev`
- `LOCALLINK_API_PORT=4110`
- `LOCALLINK_DASHBOARD_ENABLED=false`
- `LOCALLINK_DASHBOARD_PORT=4111`
- `LOCALLINK_DEFAULT_PORT_START=5100`
- `POSTGRES_PORT=55432`
- `QUEUE_WORKER_PORT=6102`
- `LOCALLINK_ENABLE_PHASE2_ADVISOR=true`
- `LOCALLINK_PHASE2_PREFERRED_EDGE=auto`

For the smallest lifecycle check, use `examples/systems/smoke`:

```bash
pnpm up:smoke
pnpm status:smoke
pnpm ai:smoke
pnpm down:smoke
```

`up:smoke` prefers ports `4210` and `4211`, but LocalLink now checks the local network stack before launching. If either port is occupied by another system, the assigned API and dashboard URLs are written to `examples/systems/smoke/.locallink/runtime.json` and returned by `pnpm status:smoke`.

### Build

```bash
pnpm build
```

### Run the packaged CLI

```bash
pnpm doctor
pnpm up
pnpm down
pnpm status
pnpm ai
pnpm start
pnpm dashboard
```

LocalLink ships as a single CLI entrypoint in `bin/locallink.js`. Inside this repository, the pnpm scripts call that CLI for you:

```bash
node ./bin/locallink.js init
pnpm up
pnpm down
pnpm status
pnpm ai
pnpm start
pnpm dashboard
pnpm mcp
pnpm snapshot
pnpm doctor
node ./bin/locallink.js --workspace examples/systems/local-dev api --log-level debug
node ./bin/locallink.js --workspace examples/systems/local-dev dashboard --log-level debug
```

If you want the `locallink` command directly on your machine, link the package once:

```bash
pnpm link --global
locallink api
locallink dashboard
locallink up
locallink down
locallink status --json
locallink ai --json
locallink mcp
locallink snapshot --log-level debug
```

When you launch `locallink`, it reads `.env`, `docker-compose.yml`, `locallink.services.yml`, `locallink.lock.json`, `locallink.extensions.yml`, optional `ecosystem.config.js`, and `mcp-registry.json` from the selected system workspace. Select a workspace with `--workspace PATH`, `LOCALLINK_WORKSPACE`, or by running the CLI from inside that folder.
Use `--log-level debug` or `LOCALLINK_LOG_LEVEL=debug` when you want stderr traces for startup, state discovery, HTTP requests, and runtime probe failures.

### AI-aware CLI surface

LocalLink keeps the human CLI readable while exposing stable machine-readable output for agents:

- `locallink ai --json` returns the agent manifest: supported commands, workspace root, runtime state file, and current status.
- `locallink status --json` returns assigned API/dashboard process metadata, URLs, service counts, and the next available system port.
- `locallink up --json` and `locallink down --json` return structured lifecycle step results and are idempotent for LocalLink-managed PM2 processes.
- `locallink doctor --json` returns startup diagnostics without console formatting.
- `.locallink/runtime.json` records the ports and PM2 names LocalLink assigned during `up`; it is ignored runtime state, not committed desired state.

This is the preferred path for AI agents: read `ai --json`, run `status --json`, use `up --json` only when the API or dashboard is not already available, and call `down --json` when the workspace should be fully stopped.

Open these after `locallink dashboard`:

- `http://127.0.0.1:4111/` - launcher
- `http://127.0.0.1:4111/dashboard` - dashboard
- `http://127.0.0.1:4111/template` - static template preview
- `http://127.0.0.1:4111/docs` - static project documentation

For a deeper implementation and operations guide, open [docs/index.html](docs/index.html) directly or use the dashboard docs route after starting the web server.

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
- `locallink.services.yml`
- `locallink.lock.json`
- `locallink.extensions.yml`
- `ecosystem.config.js`
- `mcp-registry.json`
- `AGENTS.md`
- `README.md` or `README.locallink.md` if a README already exists

The generated starter config includes the Dockerfile blueprint convention, optional service metadata fields, the Phase 2 advisor toggle, and the agent guardrails file.

### Multiple systems on one machine

Each runnable system should live in its own workspace folder. Use unique values for:

- `LOCALLINK_SYSTEM_ID`
- `COMPOSE_PROJECT_NAME`
- `PM2_HOME`
- `LOCALLINK_API_PORT` and `LOCALLINK_DASHBOARD_PORT`
- service ports such as `POSTGRES_PORT` and `QUEUE_WORKER_PORT`

Docker Compose should use the workspace `COMPOSE_PROJECT_NAME` instead of hardcoded container names. PM2 services should use unique `runtimeName` values and a per-system `PM2_HOME` such as `.locallink/pm2/<system-id>`.

`locallink up` starts the LocalLink API under PM2, starts declared active services, then starts enabled extensions such as the dashboard. `locallink down` stops enabled extensions first, then declared services, then the LocalLink API process it initiated.

If a preferred LocalLink API or dashboard port is already bound, `up` automatically chooses the next available loopback port from the workspace port range and stores that assignment in `.locallink/runtime.json`. The next `status --json` call reports the real URL, which prevents agents from hardcoding stale ports when multiple systems are active.

### Dev/test helpers

```bash
pnpm dev
pnpm dev:mcp
pnpm test
```

## HTTP API

All APIs are local-only. `locallink api` serves the API without the dashboard shell; `locallink dashboard` serves the same API plus static UI routes.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/state` | Rebuilds the current dashboard snapshot from external runtime managers: services, ports, PWA status, logs, and constraints. |
| `GET` | `/api/configs` | Returns the raw infra files plus the derived service list. |
| `GET` | `/api/extensions` | Returns optional dashboard, proxy, network edge, observability, and custom extension status. |
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
| `read_ai_manifest` | none | Returns agent-facing LocalLink CLI guidance, JSON commands, runtime state path, and current status. |
| `read_workspace_status` | none | Returns assigned API/dashboard ports, URLs, service counts, and next available port. |
| `read_workspace_blueprint` | none | Returns a structural view of `.env`, `.env.example`, `docker-compose.yml`, `locallink.services.yml`, `locallink.lock.json`, `locallink.extensions.yml`, optional `ecosystem.config.js`, and `mcp-registry.json`. |
| `patch_workspace_blueprint` | `target_file`, `content?`, `patch_payload?` | Updates one source-of-truth file with either raw content or a supported structured patch. |
| `read_extension_workspace` | none | Returns optional dashboard, Caddy, Tailscale, OpenObserve, and custom extension status without exposing secret values. |
| `allocate_system_port` | `preferred_start?` | Scans for the next sequentially free local port. |
| `verify_blueprint_compliance` | `service_name` | Checks whether a declared local service has a readable Dockerfile blueprint. |
| `orchestrate_service` | `runtime`, `service_name`, `action` | Runs Docker, PM2, or Taskfile lifecycle commands for a declared service. |
| `read_tool_workspace` | none | Returns version lock status and active temporary trials. |
| `check_tool_version` | `service_name` | Checks the latest available version when the source can be resolved. |
| `update_tool_version` | `service_name`, `target_version`, `dry_run?` | Plans or applies a version lock update. |
| `plan_tool_trial` | `service_name`, `tool_source?`, `version?`, `runtime?` | Creates a dry-run plan for a temporary tool service. |
| `provision_tool_trial` | `approved_plan_id` | Writes the temporary service manifest under `.locallink/trials/`. |
| `promote_tool_trial` | `trial_id`, `service_name?` | Promotes a temporary service into persistent config. |
| `remove_tool_service` | `service_name`, `mode`, `dry_run?` | Plans or removes a trial or persistent service. |

## Configuration model and patch expectations

LocalLink treats these files in each selected system workspace as the committable infra contract:

- `.env`: active local values
- `.env.example`: shareable defaults/template
- `docker-compose.yml`: Docker services plus `locallink.*` labels for UI/runtime metadata
- `locallink.services.yml`: PM2/PWA/Windows/taskfile service metadata plus blueprint paths
- `locallink.lock.json`: resolved tool versions, artifact references, and latest-check results
- `locallink.extensions.yml`: optional dashboard, edge, proxy, observability, and custom capabilities
- `ecosystem.config.js`: optional PM2-native escape hatch for clustering, watch mode, log paths, or other PM2-specific settings
- `mcp-registry.json`: optional registry for local-build MCP servers and mapped external volumes

Service discovery is metadata-driven:

- Docker services come from `docker-compose.yml > services`
- PM2, PWA, Windows, and taskfile-backed services come from `locallink.services.yml > services`
- Legacy PM2/PWA/Windows/taskfile metadata is still read from `ecosystem.config.js > module.exports.apps`, but `locallink.services.yml` wins when both declare the same service
- PM2 apps use `runtimeName` for reliable PM2 lifecycle control and service `name` for the dashboard display name
- Native PM2 services declare a `blueprint` path to a Dockerfile-style static contract (`EXPOSE`, `ENV`, `CMD` / `ENTRYPOINT`)
- PM2 lifecycle can be derived from the blueprint `CMD`; `script`/`args` metadata is only needed when the launch contract should differ from the blueprint
- Taskfile-backed placeholder services use `taskName`/`runtimeName` from `locallink.services.yml`, with commands resolved from `Taskfile.yml`

Optional service metadata:

| Field | Compose label | Service registry field | Purpose |
| --- | --- | --- | --- |
| Dependencies | `locallink.dependsOn` | `dependsOn` | Upstream services this service needs before it is useful |
| Downstream | `locallink.downstream` | `downstream` | Services or consumers that depend on this service |
| Env vars | `locallink.envVars` | `envVars` | Relevant environment variables to look at when operating the service |
| Docs link | `locallink.docsUrl` | `docsUrl` | Canonical external documentation for the service |
| Dockerfile blueprint | n/a | `blueprint` | Declarative Dockerfile path for Dockerfile-as-blueprint parsing on native PM2 services |

Dependency and downstream metadata render as clickable service links in the dashboard so you can jump straight to the referenced service card and use its lifecycle actions there.

Prefer structured patches when possible:

```json
{ "kind": "env", "set": { "LOCALLINK_API_PORT": "4010", "LOCALLINK_DASHBOARD_PORT": "4011" }, "unset": ["OLD_PORT"] }
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
  "target_file": "locallink.services.yml",
  "content": "services:\n  - name: Queue Worker\n    group: pm2\n    runtime: pm2\n    runtimeName: queue-worker\n    blueprint: ./blueprints/queue-worker.Dockerfile\n"
}
```

Practical MVP rules:

- `write_infra_config` must target exactly one supported source-of-truth file.
- Supported patches are intentionally narrow:
  - env patches set/unset keys
  - compose patches update one service at a time
  - ecosystem patches update one app at a time
- `locallink.services.yml` currently uses raw-content updates; structured patches remain available for env, compose, and legacy ecosystem edits.
- `ecosystem.config.js` patch support expects `module.exports = { apps: [...] }`.
- `{ "sourceEnv": "NAME" }` inside an ecosystem env patch writes `process.env.NAME`.
- If you need a shape the patcher does not support, send full `content` instead of a structured patch.
- Supported patch flows aim to preserve existing comments/formatting where practical.
- Task execution targets the LocalLink service `name` exposed by the config model.

## Assumptions and limitations

- Phase 1 is local-only: the API/dashboard surfaces coerce non-loopback bind hosts back to `127.0.0.1`, even if `.env` drifts.
- The HTTP API is the only default network listener here; the dashboard is optional and the implemented MCP server is stdio-based, not an HTTP/TCP MCP endpoint.
- LocalLink treats Docker, PM2, and Windows process probes as the source of truth for service state; restarting LocalLink triggers a fresh runtime re-query instead of trusting stale in-memory state.
- If Docker, PM2, or Windows probing is unavailable, or a declared service has no trustworthy runtime probe, the dashboard reports that service as `Unknown` instead of guessing `Down`.
- Windows process detection is WSL-only and allowlist-based: a service is considered present only if `windowsProcessName` is declared in `locallink.services.yml` or legacy `ecosystem.config.js` and found via `tasklist.exe`.
- Live lifecycle control and log tailing depend on external binaries existing on `PATH`:
  - Docker flows call `docker`
  - PM2 flows call `pm2`
  - Taskfile flows call `task`
- Startup checks warn when those binaries are missing and the CLI/API error payloads include install guidance.
- `execute_task` only works for services already declared in `docker-compose.yml`, `locallink.services.yml`, or legacy `ecosystem.config.js`.
- Blueprint compliance is warning-only in this MVP: LocalLink surfaces missing Dockerfile blueprints in the dashboard and logs, but it does not block lifecycle actions.
- The Resource view reads the current host process table, flags high CPU / RAM consumers, and exposes inspect / terminate actions for local processes.
- The Phase 2 advisor is opt-out. Set `LOCALLINK_ENABLE_PHASE2_ADVISOR=false` to suppress Tailscale and reverse-proxy suggestions entirely.
- Taskfile-backed services are placeholders in this MVP; the sample `Taskfile.yml` currently echoes start/stop/restart actions.
- Taskfile lifecycle lookup is convention-based: LocalLink tries `<taskName>:<action>` and `<action>:<taskName>`; for `up` it tries `<taskName>:up` and then `<taskName>`.
- The service worker caches shell assets only; `/api/*` routes are not cached. Live dashboard pages separately retain the last successful `/api/state` snapshot in browser storage so relaunches can reopen with the most recent live view while the API reconnects.
- Port suggestions are sequential and only count as free when the port is available on both `127.0.0.1` and `0.0.0.0`.
