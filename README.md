# LocalLink Phase 1 MVP

LocalLink Phase 1 is a local-first orchestration MVP for a developer workstation. Multiple isolated LocalLink workspaces can run on the same machine. Each workspace gets its own identity, state, PM2 namespace, Docker Compose project, and dashboard port. The Node + TypeScript control plane, loopback-only HTTP dashboard, and MCP stdio server let local tools and AI agents inspect config, allocate ports, and trigger lifecycle actions from one place.

## Product goal

LocalLink's dashboard and local web server must work without any optional
extension. Users can manage their own Docker, PM2, and development services and
ports; LocalLink makes those services easy to find and operate when they provide
clear runtime metadata, environment-variable names, dependencies, health
information, and a Dockerfile or Dockerfile blueprint.

Private Edge, Identity, and Observability are optional capability layers. They
should automate local installation and derived configuration while clearly
pausing for external security decisions that only the user can make. Services
should consume generic OIDC and OpenTelemetry contracts so Pocket ID,
OpenObserve, or another compatible provider can be replaced without rewriting
the application.

Coding agents are also a first-class user. The product direction includes an
installable LocalLink agent skill that teaches agents how to discover workspace
configuration, declare services and Dockerfile blueprints, and integrate generic
OIDC and OTLP interfaces without copying secrets or coupling applications to one
provider.

See [the full product goal and capability boundaries](docs/product-goal.md).

## What is implemented

- Node + TypeScript backend/control plane
- Local-only HTTP dashboard server, bound to a loopback host in Phase 1
- React + TypeScript frontend in `frontend/`, built with Vite into `public/`
  - `public/` is the generated/static browser shell served by Fastify
  - `/` launcher
  - `/dashboard` dashboard
  - `/current`, `/extensions`, `/external`, `/resources` direct workspace routes
  - `/template` dashboard template surface
  - `/docs` static project documentation
  - `manifest.webmanifest` + `sw.js`
- MCP stdio workspace toolset including:
  - `read_infra_config`
  - `write_infra_config`
  - `get_available_port`
  - `execute_task`
  - `plan_extension_onboarding`
  - `apply_extension_workspace_plan`
  - `apply_private_edge_routes`
- Infra source of truth in:
  - `.env`
  - `.env.example`
  - `docker-compose.yml`
  - `locallink.services.yml`
  - `locallink.extensions.yml`
  - `ecosystem.config.js`
- Sample topology already declared in `docker-compose.yml`, `ecosystem.config.js`, and `Taskfile.yml`
- Backend endpoints for state, config editing, port allocation, task execution, and log streaming
- Evidence-backed extension lifecycle reporting in the dashboard, `locallink extensions`, and `/api/extensions`
- Live dashboard state rehydrated from Docker, PM2, and Windows process probes on each read, with last-known browser snapshot fallback for relaunches

This repository's sample topology currently includes:

- Docker: `pocket-id` (sample identity extension, explicit `identity` profile) and `postgres`
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

- `LOCALLINK_WORKSPACE_ID=locallink-dev`
- `COMPOSE_PROJECT_NAME=locallink_locallink_dev`
- `PM2_HOME=.locallink/pm2`
- `LOCALLINK_BIND_HOST=127.0.0.1`
- `LOCALLINK_WEB_PORT=auto`
- `LOCALLINK_WEB_PORT_START=4010`
- `LOCALLINK_DEFAULT_PORT_START=5000`
- `LOCALLINK_ENABLE_PHASE2_ADVISOR=true`
- `LOCALLINK_PHASE2_PREFERRED_EDGE=auto`
- `POCKET_ID_APP_URL=https://pocket-id.example-tailnet.ts.net` (replace with the private Tailscale Serve issuer)
- `POCKET_ID_PORT=1411`

### Build

```bash
pnpm build
```

The build runs the React/Vite frontend first, then compiles the Node + TypeScript control plane, then copies `public/` into `dist/public`.

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
pnpm add -g .
locallink web
locallink mcp
locallink snapshot --log-level debug
locallink extensions
locallink extension plan private-edge
locallink extension apply private-edge
locallink extension plan private-edge "My API"
locallink extension apply-routes private-edge "private-edge:<token-from-fresh-plan>"
```

When you launch `locallink` from another folder, it reads environment, service, extension, and runtime declarations from that current working directory.
Use `--log-level debug` or `LOCALLINK_LOG_LEVEL=debug` when you want stderr traces for startup, state discovery, HTTP requests, and runtime probe failures.

With the repository defaults, open the URL reported at startup or read it from
`.locallink/runtime.json`. The first workspace normally receives port 4010;
additional workspaces automatically use the next free port. Typical routes are:

- `http://127.0.0.1:4010/` - launcher
- `http://127.0.0.1:4010/dashboard` - dashboard
- `http://127.0.0.1:4010/current` - current workspace
- `http://127.0.0.1:4010/extensions` - extensions workspace
- `http://127.0.0.1:4010/resources` - resources workspace
- `http://127.0.0.1:4010/template` - dashboard template surface
- `http://127.0.0.1:4010/docs` - static project documentation

For a deeper implementation and operations guide, open [docs/index.html](docs/index.html) directly or use the dashboard docs route after starting the web server.

### Private Pocket ID application SSO

This repository registers Pocket ID as a sample application-identity extension and declares it as an opt-in Docker Compose profile. A newly initialized workspace does not install or enable it. Tailscale remains the network gate with its existing login provider; Pocket ID supplies passkey-backed OIDC sessions to internal applications after the user joins the tailnet.

```bash
cp .env.example .env
openssl rand -base64 32
# Set POCKET_ID_APP_URL and POCKET_ID_ENCRYPTION_KEY in .env.
docker compose --profile identity up -d pocket-id
```

Use [the private Pocket ID + Tailscale setup guide](docs/pocket-id-tailscale.html) to configure a stable tailnet-only HTTPS issuer and register each internal service as an OIDC client. The dashboard also links to the [Pocket ID installation guide](https://pocket-id.org/docs/setup/installation) and [Tailscale Serve guide](https://tailscale.com/docs/features/tailscale-serve).

Client IDs, client secrets, Pocket ID encryption keys, and real issuer domains belong in local secret management—not committed templates. Applications without native OIDC can use an OIDC-aware proxy documented by Pocket ID.

LocalLink's Dashboard, reverse proxy, Tailscale edge, Pocket ID, and observability capabilities are explained in [the out-of-box extension guide](docs/extensions.html). Workspace capability declarations live in `locallink.extensions.yml`; runtime services and secrets remain separately explicit. Extensions are optional: a workspace that enables none of them still retains the dashboard, service discovery, runtime state, ports, logs, and lifecycle controls.

Private Edge service exposure is opt-in per workspace. LocalLink records selected service ports in the network-edge declaration and only associates Tailscale routes or dashboard edge URLs with those selected ports.
The read-only onboarding plan also derives workspace-specific HTTPS listeners, compares them with live Tailscale Serve routes, and returns exact apply and rollback argument arrays. By default the listener range is derived from the stable workspace ID so separate LocalLink workspaces do not intentionally share a machine-wide port. Set `LOCALLINK_PRIVATE_EDGE_PORT_START` to pin the first listener for a workspace; LocalLink blocks a generated route when that listener is already occupied instead of replacing it. Route commands are preview-only at this checkpoint.

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
- `locallink.extensions.yml`
- `ecosystem.config.js`
- `mcp-registry.json`
- `AGENTS.md`
- `README.md` or `README.locallink.md` if a README already exists

The generated starter is extension-free: it includes the dashboard declaration, isolated Docker/PM2 namespaces, automatic dashboard port selection, the Dockerfile blueprint convention, optional service metadata fields, the Phase 2 advisor toggle, and the agent guardrails file. Private Edge, identity, and observability capabilities can be added later per workspace.

### Dev/test helpers

```bash
pnpm dev
pnpm dev:frontend
pnpm dev:mcp
pnpm test
```

## HTTP API

All dashboard APIs are local-only and served from the same process as the UI.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/state` | Rebuilds the current dashboard snapshot from external runtime managers: services, ports, PWA status, logs, and constraints. |
| `GET` | `/api/extensions` | Separates available capabilities, workspace declarations, host installation, manual onboarding, configuration, and runtime health. |
| `POST` | `/api/extensions/plan` | Preview workspace-owned Private Edge changes, optional explicit service selections, and user-owned security checkpoints without writing files. |
| `POST` | `/api/extensions/apply` | Idempotently apply only the declaration, selected service ports, and local environment portion of a Private Edge plan. |
| `POST` | `/api/extensions/routes/apply` | Apply a freshly confirmed Tailscale Serve route plan, verify every selected route, record workspace ownership, and roll back newly created routes on failure. |
| `GET` | `/api/configs` | Returns the raw infra files plus the derived service list. |
| `POST` | `/api/configs` | Writes one infra file using full `content` or a structured `patch`. |
| `POST` | `/api/ports/next` | Returns the next free local port, optionally starting from a supplied number. |
| `POST` | `/api/tasks` | Executes a lifecycle action for a declared service and returns the result plus a fresh snapshot. |
| `GET` | `/api/processes/:pid` | Inspect one local process with CPU, RAM, uptime, parent PID, and full command. |
| `GET` | `/api/processes/:pid/termination-review` | Review process identity, parent/child relationships, and open bindings before termination. |
| `POST` | `/api/processes/:pid/terminate` | Send `SIGTERM` or `SIGKILL` to a selected local process, then refresh the dashboard snapshot. |
| `GET` | `/api/workspace/settings` | Read persisted extension preferences, temporary runtime plans, version queues, and port reservations. |
| `PATCH` | `/api/workspace/settings` | Persist extension preferences for the current workspace. |
| `POST` | `/api/workspace/runtimes` | Persist a temporary runtime plan without claiming that it has been launched. |
| `POST` | `/api/workspace/updates` | Queue a version update plan. |
| `DELETE` | `/api/workspace/updates/:id` | Cancel a queued version update plan. |
| `POST` | `/api/ports/reservations` | Bind and persist a loopback port reservation. |
| `DELETE` | `/api/ports/reservations/:id` | Release a port reservation. |
| `GET` | `/api/logs/stream` | Server-sent events stream of lifecycle, Docker, and PM2 log lines. |

HTTP request bodies use camelCase:

- `/api/configs`: `{ "targetFile": "...", "content"?: "...", "patch"?: { ... } }`
- `/api/ports/next`: `{ "startFrom"?: 5000, "reserve"?: true, "service"?: "new service" }`
- `/api/tasks`: `{ "runtime": "docker|pm2|taskfile", "serviceName": "...", "action": "start|stop|restart|up" }`
- `/api/extensions/routes/apply`: `{ "capability": "private-edge", "confirmationToken": "private-edge:<token-from-fresh-plan>" }`

## MCP tools

MCP inputs use snake_case:

| Tool | Input | Purpose |
| --- | --- | --- |
| `read_workspace_blueprint` | none | Returns a structural view of `.env`, `.env.example`, `docker-compose.yml`, `ecosystem.config.js`, and `mcp-registry.json`. |
| `patch_workspace_blueprint` | `target_file`, `content?`, `patch_payload?` | Updates one source-of-truth file with either raw content or a supported structured patch. |
| `allocate_system_port` | `preferred_start?` | Scans for the next sequentially free local port. |
| `verify_blueprint_compliance` | `service_name` | Checks whether a declared local service has a readable Dockerfile blueprint. |
| `plan_extension_onboarding` | `capability` | Previews workspace changes and manual security checkpoints without writing files. |
| `apply_extension_workspace_plan` | `capability` | Applies only the workspace-owned portion of a reviewed extension plan. |
| `apply_private_edge_routes` | `capability`, `confirmation_token` | Applies the exact current route plan after explicit confirmation, verifies it, records ownership, and rolls back this attempt on failure. |
| `orchestrate_service` | `runtime`, `service_name`, `action` | Runs Docker, PM2, or Taskfile lifecycle commands for a declared service. |

## Configuration model and patch expectations

LocalLink treats these files as the committable infra contract:

- `.env`: active local values
- `.env.example`: shareable defaults/template
- `docker-compose.yml`: Docker services plus `locallink.*` labels for UI/runtime metadata
- `locallink.services.yml`: preferred PM2, PWA, Windows, and task-backed service registry
- `locallink.extensions.yml`: optional dashboard, proxy, private edge, identity, observability, and custom capability declarations
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

- Phase 1 is local-only: the dashboard coerces non-loopback bind hosts back to `127.0.0.1`, even if `.env` drifts.
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
