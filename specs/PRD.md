# Product Requirement Document (PRD): LocalLink (Enhanced)

## 1. Executive Summary

LocalLink is a lightweight, local-first platform orchestrator and developer utility designed to manage a hybrid mix of applications (Docker containers, local CLI tools, and PWAs/Dev Servers) running within a single machine environment (WSL 2 / Windows).

Instead of adopting heavy cloud-native tooling like Kubernetes (k8s), LocalLink balances extreme structural simplicity with **native AI-friendliness**. The system is built from the ground up to be inspected, configured, booted, and extended by AI Developer Agents (such as Cursor, Claude Engineer, or Claude Desktop).

To ensure the local system behaves like a highly modular, predictable local platform, LocalLink enforces a lightweight software contract across mixed services. For native host languages (Node.js/Python) where runtime execution standards are inherently fragmented, LocalLink introduces **"Dockerfile as Blueprint"** parsing and automated **Blueprint Compliance** checks. This guarantees a consistent operational contract without introducing the deployment overhead of compiling or publishing live local Docker images during rapid development cycles.

The project follows a pragmatic staged delivery strategy:

* **Phase 1 (Current Target):** A local-only, Stdio-based MCP core, a headless API control plane, an optional local PWA management dashboard, lightweight blueprint compliance checks, and automated workspace generation tools.
* **Phase 1.5 (Tool Workbench Extension):** Versioned tool management, temporary trial provisioning, promote-to-persist workflows, and safe removal/update operations exposed through MCP and the dashboard.
* **Phase 1.6 (Workspace Extensions):** Optional dashboard, Caddy reverse-proxy, Tailscale network edge, OpenObserve OTEL, and custom extensions declared in `locallink.extensions.yml` and surfaced through MCP/dashboard without making them core dependencies.
* **Phase 2 (Future Extension):** A production-grade hardening layer introducing secure reverse proxies, network edge access via Tailscale HTTPS, and multi-agent sandboxing.

---

## 2. Problem Statement & Objectives

### 2.1 Problem Statement

Modern local development setups often involve a messy, fragmented combination of infrastructure. While containerized applications benefit from uniform configuration standards, native host services (Node.js, Python CLI scripts, standalone binaries) lack any rigid runtime interface. Developers and AI agents routinely hardcode connection strings, mismatch network ports, and produce unisolated scripts that clutter the global OS environment.

When AI coding agents build new features into this ecosystem, they work in an interface vacuum. Without rigid, automated guardrails acting like the physical "pins and sockets" of a Lego block, AI agents produce code that violates structural dependencies, introducing breaking changes to the developer's surrounding local ecosystem.

### 2.2 Core Objectives

* **Unified Control:** Control Docker and local processes (via PM2) from a single point through a headless API, an automated AI coding assistant, and an optional visual standalone PWA Dashboard.
* **Blueprint-Driven Modularity:** Treat every service as a clear plug-and-play block. Native Node/Python apps must adapt to a predictable configuration interface identical to standard container constructs.
* **AI-First & Autonomous Engineering:** Provide explicit prompts, structural enforcement schemas, and a dedicated `AGENTS.md` context blueprint so that coding agents can independently scaffold new, fully compatible LocalLink services without human intervention.
* **Machine-Readable Operations:** Make the CLI and MCP server self-describing for coding agents through JSON status, lifecycle results, diagnostics, and an agent manifest that explains the safe workflow.
* **Declarative & Portable System Workspaces:** Rely strictly on centralized, relative system workspace folders (`.env`, `docker-compose.yml`, `locallink.services.yml`, `locallink.lock.json`, `locallink.extensions.yml`, optional `ecosystem.config.js`) that can be securely version-controlled inside a user's private GitHub infrastructure repository or stored as local test fixtures.
* **Versioned Tool Management:** Treat every managed tool as an explicit versioned dependency with a desired version, resolved runtime artifact, update policy, and audit trail.
* **Low-Friction Trialing:** Let users and AI agents temporarily provision tools, test them behind LocalLink controls, then either promote them into persistent workspace configuration or fully remove the trial without leaving orphaned processes, ports, files, or config.
* **Layered Optional Capabilities:** Keep dashboard serving, reverse proxying, private network exposure, and observability as opt-in extensions that can be detected and managed without bloating the default API process.
* **Externally Rehydrated Runtime State:** Treat Docker, PM2, and other external service managers as the source of truth so restarting LocalLink rebuilds the latest observable service state instead of relying on stale in-memory state.
* **Zero Infrastructure Bloat (Phase 1):** Avoid running network daemons, thick distributed logging engines, or heavy database backends to keep the system footprint near-zero.

---

## 3. Workspace Architecture & Generation

LocalLink enforces clean decoupling by separating the core management platform logic from one or more selected system workspaces. The app repository can contain example system workspaces for fixtures and local testing, while real user systems live in their own private folders.

System workspace selection must support:

* `--workspace <path>` for explicit CLI/API/MCP selection.
* `LOCALLINK_WORKSPACE=<path>` for scripted launches.
* Current-working-directory fallback for users who run the CLI inside a system workspace.

### 3.1 The CLI Workspace Generator

LocalLink provides a native CLI command (`locallink init <workspace-name>`) that scaffolds a standardized, version-controllable orchestration workspace.

```text
my-local-infra/ (A LocalLink System Workspace)
├── .gitignore               # Strictly ignores true .env secrets and raw app source code
├── Taskfile.yml             # Global system control tasks (e.g., task up, task clear)
├── docker-compose.yml       # Production/infrastructure container definition
├── locallink.services.yml   # PM2, PWA, Windows, and task-backed service metadata
├── locallink.lock.json      # Resolved tool/service versions and artifact identities
├── locallink.extensions.yml # Optional dashboard, proxy, edge, observability, and custom layers
├── .locallink/trials/       # Ignored ephemeral trial manifests, logs, and scratch state
├── ecosystem.config.js      # Optional PM2-native runtime overrides
├── mcp-registry.json        # Declared local-build & out-of-the-box MCP servers
├── .env.example             # Blueprint env variables for the system
├── README.md                # General architecture setup and human instructions
└── AGENTS.md                # System prompt, guardrails, and instructions for AI Agents

```

The LocalLink app repository itself should not require these runtime files at its root. Repository-local examples belong under `examples/systems/<system-id>/` and should be safe to use as test data.

Each system workspace must declare collision-avoidance values:

* `LOCALLINK_SYSTEM_ID`: stable system identifier used in docs, generated names, and UI.
* `COMPOSE_PROJECT_NAME`: Docker Compose project namespace for containers, networks, and volumes.
* `PM2_HOME`: per-system PM2 state directory, for example `.locallink/pm2/<system-id>`.
* `LOCALLINK_API_PORT` and `LOCALLINK_DASHBOARD_PORT`: LocalLink control-plane and optional UI ports.
* Service-specific host ports such as `POSTGRES_PORT`, `REDIS_PORT`, and tool trial ports.

`LOCALLINK_API_PORT` and `LOCALLINK_DASHBOARD_PORT` are preferences, not unsafe hard guarantees. `locallink up` must probe the local network stack before launching LocalLink-managed API/dashboard PM2 processes. If a preferred port is occupied by another system, LocalLink should allocate the next available loopback port from the workspace port range and record the real assignment in ignored runtime state at `.locallink/runtime.json`.

### 3.2 The `AGENTS.md` Specification

The `AGENTS.md` file is a core pillar of LocalLink's AI-friendliness. It acts as a permanent, highly structured context window attachment for coding agents. It explicitly dictates:

* **The Environment Contract:** All services must be entirely decoupled. Services must *never* hardcode connection URLs, file system paths, or socket ports. They must parse their upstream dependencies strictly from environment variables injected by LocalLink (e.g., `process.env.CORE_API_URL` or `os.environ["DATABASE_URL"]`).
* **The Blueprint Protocol:** Every native application created (Node/Python) should include a declarative `Dockerfile` serving as its static runtime blueprint.
* **The Version Pinning Protocol:** Every persisted tool should declare a desired version or immutable source reference. Agents must avoid unpinned "latest" installs unless the user explicitly requests a one-off trial.
* **The Trial Protocol:** Trial services must be marked as ephemeral, isolated under `.locallink/trials/`, and promoted into the committed workspace only after explicit user acceptance.
* **Network Isolation Rules:** Clear parameters governing WSL-to-Windows communication boundaries (`host.docker.internal`).

---

## 4. System Architecture & Components (Phase 1)

### 4.1 Control Plane

* **LocalLink CLI/API Control Plane:** A Node.js/TypeScript utility that starts headless by default (`locallink api`), reads workspace configuration, probes external runtime managers, and exposes local-only HTTP APIs.
* **Workspace Lifecycle Runner:** `locallink up` starts the selected workspace's LocalLink API, active configured services, and enabled extensions. `locallink down` stops enabled extensions, declared services, and the LocalLink-managed API process.
* **Agent-Aware CLI Surface:** `locallink ai --json` exposes machine-readable guidance, `locallink status --json` exposes assigned ports and service counts, and lifecycle/diagnostic commands support JSON output for agents that need parseable feedback.
* **LocalLink Coding MCP Server:** A Stdio server that directly exposes tool-calls from the user's primary programming environment to read files, query ports, inspect extensions, update versions, provision trials, and execute scripts.
* **Blueprint Compliance Check:** A lightweight validation step embedded inside the control plane. It checks whether declared local services expose a readable Dockerfile blueprint and surfaces warnings when the blueprint is missing.
* **Blueprint Configuration Engine:** Reads local Dockerfiles as *static text configuration parameters* rather than targeting an engine build. It translates structural `EXPOSE`, `ENV`, and `CMD` layers natively into LocalLink service metadata, PM2 launch commands, or `.env`.
* **Tool Version Manager (Phase 1.5):** Resolves desired service/tool versions into concrete artifacts, writes a local lock file, detects available upgrades, and applies version changes through explicit MCP/dashboard actions.
* **Trial Provisioner (Phase 1.5):** Creates temporary service definitions and runtime artifacts in a controlled scratch area, allocates ports, starts/stops trial services, and supports promote-or-remove decisions.
* **Optional PWA Dashboard Server:** A lightweight, local web server binding to `127.0.0.1` that distributes the LocalLink management panel UI only when launched with `locallink dashboard` or enabled through the dashboard extension.
* **Extension Registry:** `locallink.extensions.yml` declares optional layers such as dashboard, Caddy, Tailscale, and OpenObserve OTEL. Extension status is visible through MCP and the dashboard, and secret values are represented only as present/missing environment keys.

### 4.2 Data Plane

* **Infrastructure Layer:** Docker Compose managing long-running state containers (e.g., PostgreSQL, Redis, LiteLLM proxy). Each system should set a unique `COMPOSE_PROJECT_NAME` and avoid hardcoded `container_name` values unless they include the system identifier.
* **Development Process Layer:** PM2 managing high-velocity, live-reloading codebases running natively in WSL 2. Each system should use a unique `PM2_HOME` and unique service `runtimeName` values so multiple LocalLink systems can run without process-name collisions.
* **Tool Artifact Layer:** Versioned external tools are represented by immutable or semver-pinned artifacts: Docker image tags/digests, npm/package versions, Git commit SHAs/tags, local binary paths plus checksums, or Taskfile command references.
* **External Volume Mapping Engine:** Declared directories located *outside* the LocalLink root (such as a Windows-native Logseq markdown folder) are registered via `mcp-registry.json` and dynamically bound into sandboxed runtime targets using path translation mapping.

---

## 5. Functional Requirements

### 5.1 Phase 1 Core Feature Set (MVP)

#### 5.1.1 Workspace Scaffolding

* The CLI tool must create a clean workspace directory containing all required configuration stubs, the `.env` pipeline, and the immutable `AGENTS.md` context template file.

#### 5.1.2 The "Dockerfile as Blueprint" Parsing Engine

* For all native Node/Python codebases registered in the workspace, LocalLink must natively parse their project-level `Dockerfile` as a declarative configuration sheet.
* **EXPOSE Parsing:** Extract the requested container port, cross-check it against system availability, and feed it dynamically into LocalLink's variable stack.
* **ENV Parsing:** Automatically parse required environment variables, logging them to `.env.example` and injecting them into the application runtime profile.
* **CMD/ENTRYPOINT Parsing:** Direct the execution parameters straight into PM2's instantiation wrapper without forcing a local image compile.

#### 5.1.3 Blueprint Compliance

* Before executing `orchestrate_service` for a declared local PM2 or task-backed service, LocalLink should check whether a Dockerfile blueprint is declared and readable.
* **Warning-only behavior:** Missing or unreadable Dockerfile blueprints should be surfaced as warnings in the dashboard, logs, and MCP responses, but should not block the startup sequence in Phase 1.
* The compliance result should remain simple and structured so coding agents can add or repair Dockerfile blueprint declarations quickly.

#### 5.1.4 LocalLink PWA Dashboard App

* **System Health Grid:** Visual status dashboard reporting CPU, memory, and runtime errors across Docker containers and PM2 applications.
* **Runtime State Rehydration:** Every dashboard load or refresh must re-query Docker, PM2, and any supported host-process probes so terminating and restarting LocalLink still shows the latest externally managed service state.
* **Unknown-over-Guessing:** If LocalLink cannot verify a service accurately—because the runtime manager is unavailable, the probe is unsupported, or the service has no trustworthy process mapping—the dashboard must render that service as `Unknown` instead of inferring `Down`.
* **Manual Lifecycle Anchors:** Simple clickable toggles to run, halt, or restart arbitrary system services.
* **Signal-First Log Streamer:** Real-time console interface streaming output from stdout/stderr of local PM2 processes and Docker container instances, defaulting to alerts/lifecycle signal with full logs available on demand.

#### 5.1.5 LocalLink Coding MCP Toolkit (Tools & Prompts)

| Tool Method | Input Parameters | Expected System Behavior / Output |
| --- | --- | --- |
| `read_ai_manifest` | None | Returns agent-facing LocalLink CLI guidance, supported JSON commands, the runtime state path, and current workspace status. |
| `read_workspace_status` | None | Returns assigned LocalLink API/dashboard ports and URLs, service counts, and next available port information. |
| `read_workspace_blueprint` | None | Returns the text contents of the workspace orchestration files (`.env`, `docker-compose.yml`, `locallink.services.yml`, `locallink.lock.json`, `locallink.extensions.yml`, optional `ecosystem.config.js`, `mcp-registry.json`). |
| `patch_workspace_blueprint` | `target_file` (string), `patch_payload` (object/string) | Safely mutates, appends, or alters variables and configuration stubs within the designated infrastructure files. |
| `read_extension_workspace` | None | Returns detected optional extension status, exported URLs/ports, missing environment variables, and command availability without exposing secret values. |
| `allocate_system_port` | `preferred_start` (number, optional) | Programmatically scans the network stack and returns the next sequentially open port number. |
| `verify_blueprint_compliance` | `service_name` (string) | Checks whether a declared local service has a readable Dockerfile blueprint, returning pass/warn guidance. |
| `orchestrate_service` | `runtime` ('docker'|'pm2'|'taskfile'), `service_name` (string), `action` ('start'|'stop'|'restart'|'up') | Runs the pre-flight verification checks. On absolute validation pass, executes the underlying terminal commands inside WSL 2, capturing and returning the command execution feedback. |

#### 5.1.6 Workspace Lifecycle Commands

* `locallink up` should use the selected system workspace to start:
  * the LocalLink API as a PM2-managed process
  * all active declared Docker, PM2, and taskfile services
  * enabled extensions with known lifecycle behavior, including the dashboard extension
* `locallink down` should reverse that order:
  * enabled extensions first
  * declared services next
  * the LocalLink API process last
* Extensions without explicit or built-in lifecycle behavior should be reported as skipped rather than treated as failures.
* `down` should be idempotent for LocalLink-managed PM2 processes that are already stopped or missing.
* `up` should be idempotent for LocalLink-managed API/dashboard PM2 processes that are already running.
* `status --json` should be the canonical way for agents to discover the real assigned API/dashboard URLs after `up`, especially when multiple LocalLink systems are running.
* `ai --json` should be the canonical self-description command for coding agents. It must identify the workspace, runtime state file, machine-readable commands, and recommended lifecycle workflow.

### 5.2 Phase 1.5 Tool Management and Trials

#### 5.2.1 Tool Management MCP Toolkit

| Tool Method | Input Parameters | Expected System Behavior / Output |
| --- | --- | --- |
| `plan_tool_trial` | `tool_source`, `version?`, `runtime?`, `ports?` | Produces a dry-run provisioning plan, including required files, ports, runtime, permissions, and cleanup scope. |
| `provision_tool_trial` | `approved_plan_id` | Creates an ephemeral service under `.locallink/trials/`, allocates runtime resources, starts the service if requested, and records a trial manifest. |
| `promote_tool_trial` | `trial_id`, `service_name` | Converts a successful trial into persistent workspace config by updating `locallink.services.yml`, relevant blueprints, `.env.example`, and `locallink.lock.json`. |
| `remove_tool_service` | `service_name`, `mode` ('trial'|'persistent'), `dry_run?` | Stops the runtime, removes managed artifacts, releases LocalLink metadata, and returns a deletion report. Persistent removals require an explicit dry-run preview before mutation. |
| `update_tool_version` | `service_name`, `target_version`, `dry_run?` | Plans or applies a controlled version change, updates the lock file, and restarts the service only after the requested change is accepted. |

#### 5.2.2 Versioned Tool and Service Registry

* `locallink.services.yml` is the desired-state manifest for persisted services. Each service should be able to declare:
  * `source.type`: `docker-image`, `npm`, `git`, `local-binary`, `taskfile`, or `manual`.
  * `source.ref`: package name, image name, Git URL, binary path, or task namespace.
  * `version.desired`: user-requested version range, tag, commit SHA, or exact version.
  * `version.policy`: `manual`, `notify`, or `auto-minor` (default: `manual`).
  * `blueprint`: Dockerfile-style runtime contract for native services.
  * `state`: `active`, `trial`, `disabled`, or `retired`.
* `locallink.lock.json` is the resolved-state lock file. It records immutable details such as package versions, Docker image digests, Git commit SHAs, checksums, resolved ports, install timestamps, and the LocalLink version that wrote the entry.
* The dashboard and MCP snapshot should surface version drift:
  * desired version equals resolved version: healthy
  * upgrade available but not applied: informational
  * desired version cannot be resolved: warning
  * running artifact differs from lock file: warning
* Version changes should be two-step by default: first produce a plan, then apply. Plans should include expected config diffs, runtime restart impact, rollback target, and any data directories that may be touched.

Example persisted service entry:

```yaml
services:
  - name: Example MCP Tool
    group: pm2
    runtime: pm2
    runtimeName: example-mcp-tool
    source:
      type: npm
      ref: example-mcp-server
    version:
      desired: 1.4.2
      policy: manual
    blueprint: ./blueprints/example-mcp-tool.Dockerfile
    state: active
```

Example lock entry:

```json
{
  "services": {
    "Example MCP Tool": {
      "source": { "type": "npm", "ref": "example-mcp-server" },
      "resolvedVersion": "1.4.2",
      "resolvedAt": "2026-06-21T00:00:00.000Z",
      "artifact": {
        "kind": "npm",
        "integrity": "sha512-..."
      }
    }
  }
}
```

#### 5.2.3 Temporary Tool Trial Lifecycle

* LocalLink should support a reversible trial lifecycle for tools the user may not want to keep:
  1. **Plan:** Inspect the requested tool source and generate a dry-run plan with ports, runtime, permissions, env vars, expected files, and cleanup scope.
  2. **Provision:** Create a trial manifest under `.locallink/trials/<trial-id>/manifest.yml`, allocate ports, install or reference the runtime artifact, and start the service if requested.
  3. **Observe:** Expose trial services in the dashboard with a clear `Trial` badge, logs, health, version, and expiration metadata.
  4. **Promote:** Convert the trial into persistent config by writing `locallink.services.yml`, blueprints, env templates, and lock entries.
  5. **Remove:** Stop processes, remove managed trial files, release ports from LocalLink's recent allocation ledger, and record a cleanup report.
* Trial services must not mutate committed workspace files unless promoted.
* Trial artifacts must be contained under `.locallink/trials/` except for runtime-manager state that cannot practically be relocated (for example PM2 process entries). Those external runtime entries must be tagged with the trial ID for cleanup.
* Trials should support TTL metadata (`expiresAt`) and dashboard reminders. Expired trials should be shown as cleanup candidates, but automatic deletion should remain opt-in during Phase 1.
* Persistent removals should be more conservative than trial removals. A persistent service removal must show a dry-run report before deleting or editing any files.
* Promotion should preserve provenance by copying the trial's resolved artifact details into `locallink.lock.json`.

## 6. Non-Functional Requirements (Phase 1)

* **Blueprint Check Performance:** The Dockerfile blueprint check must verify service compliance in **< 150ms** to prevent execution lag within AI agent iterative coding loops.
* **Zero Network Exposure:** In Phase 1, the system must rely on `Stdio` for MCP and bind web access exclusively to `localhost` to ensure zero unintended ports are leaked onto shared local networks.
* **Runtime Isolation:** Python scripts must automatically execute under individual virtual environment instances (`.venv`) initialized dynamically by LocalLink on first boot to preserve host system health.
* **Snapshot Relaunch Resilience:** The live dashboard may cache the last successful runtime snapshot locally for quick relaunch, but it must replace that cache with a freshly re-queried runtime view as soon as external managers are reachable again.
* **Version Resolution Transparency:** Any action that installs, updates, or removes a tool must return the requested version, resolved version, artifact identity, affected files, affected runtime processes, and rollback guidance.
* **Reversible Trial Safety:** Trial provisioning must be isolated, tagged, and removable. A failed or abandoned trial must not corrupt persistent workspace config.
* **Destructive Action Preview:** Persistent service removal and version downgrade/upgrade actions must support a dry-run mode and should require explicit user approval before mutating files or stopping persistent services.
* **Multi-System Collision Avoidance:** Running multiple LocalLink systems on one machine must not require editing app code. Each system workspace should isolate ports, Compose project names, PM2 state, PM2 process names, and trial directories.
* **Parseable Agent Feedback:** Agent-facing commands and MCP tools must return structured JSON for status, diagnostics, lifecycle steps, port allocation, and workspace guidance so coding agents do not need to scrape human console text.

---

## 7. Future Implementation Roadmap

### 7.0 Phase 1.5 Tool Marketplace and Trial Manager

* **Goal:** Make LocalLink feel like a local tool workbench where AI agents can safely try, compare, update, promote, and remove tools without hand-editing every configuration file.
* **Execution:** Add MCP/dashboard workflows for tool discovery, trial planning, ephemeral provisioning, promotion to `locallink.services.yml`, version lock updates, and cleanup reports.
* **Version Strategy:** Keep desired versions in `locallink.services.yml`; keep resolved immutable artifacts in `locallink.lock.json`; surface drift and available updates in the dashboard.
* **Trial Strategy:** Keep temporary definitions under `.locallink/trials/`; tag runtime processes with trial IDs; require explicit promotion before writing committed workspace files.

### 7.1 Reverse Proxying via Caddy & Tailscale HTTPS

* **Goal:** Eliminate local port management and insecure browser connection blocks, allowing remote devices (such as a mobile phone on the same network) to securely connect and install local PWAs over validated HTTPS.
* **Execution:** Add a lightweight **Caddy** container into the data plane. Caddy will parse incoming traffic directed at a **Tailscale** node domain and auto-provision real SSL certificates. Coding agents will interact with this layer through structured `Caddyfile` tool updates.

### 7.2 Containerized Agent Bridges (SSE Gateway)

* **Goal:** Allow internal background tools running inside Docker containers (like an automated n8n setup) to cleanly interact with local MCP configurations without sharing system terminal access.
* **Execution:** Add a network bridge layer converting standard Stdio inputs into Server-Sent Events (SSE) using an abstraction layer like AgentGateway.

### 7.3 Isolated Local-Build Data MCP Sandboxes

* **Goal:** Limit the potential damage of runtime automation scripts (e.g., if an automated n8n loop goes haywire).
* **Execution:** Isolate the LocalLink Management MCP (which can alter system settings and run shell processes) from local-build runtime data MCPs (e.g., a `logseq-mcp` or a `csv-data-mcp`). These specific application data MCPs will have their file permissions strictly sandboxed and locked to their configured directory paths.
