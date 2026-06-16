# Product Requirement Document (PRD): LocalLink (Enhanced)

## 1. Executive Summary

LocalLink is a lightweight, local-first platform orchestrator and developer utility designed to manage a hybrid mix of applications (Docker containers, local CLI tools, and PWAs/Dev Servers) running within a single machine environment (WSL 2 / Windows).

Instead of adopting heavy cloud-native tooling like Kubernetes (k8s), LocalLink balances extreme structural simplicity with **native AI-friendliness**. The system is built from the ground up to be inspected, configured, booted, and extended by AI Developer Agents (such as Cursor, Claude Engineer, or Claude Desktop).

To ensure the local system behaves like a highly modular, predictable local platform, LocalLink enforces a lightweight software contract across mixed services. For native host languages (Node.js/Python) where runtime execution standards are inherently fragmented, LocalLink introduces **"Dockerfile as Blueprint"** parsing and automated **Blueprint Compliance** checks. This guarantees a consistent operational contract without introducing the deployment overhead of compiling or publishing live local Docker images during rapid development cycles.

The project follows a pragmatic, two-phased delivery strategy:

* **Phase 1 (Current Target):** A local-only, Stdio-based MCP core, a self-contained local PWA management dashboard, lightweight blueprint compliance checks, and automated workspace generation tools.
* **Phase 2 (Future Extension):** A production-grade hardening layer introducing secure reverse proxies, network edge access via Tailscale HTTPS, and multi-agent sandboxing.

---

## 2. Problem Statement & Objectives

### 2.1 Problem Statement

Modern local development setups often involve a messy, fragmented combination of infrastructure. While containerized applications benefit from uniform configuration standards, native host services (Node.js, Python CLI scripts, standalone binaries) lack any rigid runtime interface. Developers and AI agents routinely hardcode connection strings, mismatch network ports, and produce unisolated scripts that clutter the global OS environment.

When AI coding agents build new features into this ecosystem, they work in an interface vacuum. Without rigid, automated guardrails acting like the physical "pins and sockets" of a Lego block, AI agents produce code that violates structural dependencies, introducing breaking changes to the developer's surrounding local ecosystem.

### 2.2 Core Objectives

* **Unified Control:** Control Docker and local processes (via PM2) from a single point—via both an automated AI coding assistant and a visual standalone PWA Dashboard.
* **Blueprint-Driven Modularity:** Treat every service as a clear plug-and-play block. Native Node/Python apps must adapt to a predictable configuration interface identical to standard container constructs.
* **AI-First & Autonomous Engineering:** Provide explicit prompts, structural enforcement schemas, and a dedicated `AGENTS.md` context blueprint so that coding agents can independently scaffold new, fully compatible LocalLink services without human intervention.
* **Declarative & Portable Configuration:** Rely strictly on a centralized, relative workspace structure (`.env`, `docker-compose.yml`, `ecosystem.config.js`) that can be securely version-controlled inside a user's private GitHub infrastructure repository.
* **Externally Rehydrated Runtime State:** Treat Docker, PM2, and other external service managers as the source of truth so restarting LocalLink rebuilds the latest observable service state instead of relying on stale in-memory state.
* **Zero Infrastructure Bloat (Phase 1):** Avoid running network daemons, thick distributed logging engines, or heavy database backends to keep the system footprint near-zero.

---

## 3. Workspace Architecture & Generation

LocalLink enforces clean decoupling by separating the core management platform logic from the user's private system data.

### 3.1 The CLI Workspace Generator

LocalLink provides a native CLI command (`locallink init <workspace-name>`) that scaffolds a standardized, version-controllable orchestration workspace.

```text
my-local-infra/ (The Private Git Repo Workspace)
├── .gitignore               # Strictly ignores true .env secrets and raw app source code
├── Taskfile.yml             # Global system control tasks (e.g., task up, task clear)
├── docker-compose.yml       # Production/infrastructure container definition
├── ecosystem.config.js      # PM2 runtime matrix for dev-servers and local CLI apps
├── mcp-registry.json        # Declared local-build & out-of-the-box MCP servers
├── .env.example             # Blueprint env variables for the system
├── README.md                # General architecture setup and human instructions
└── AGENTS.md                # System prompt, guardrails, and instructions for AI Agents

```

### 3.2 The `AGENTS.md` Specification

The `AGENTS.md` file is a core pillar of LocalLink's AI-friendliness. It acts as a permanent, highly structured context window attachment for coding agents. It explicitly dictates:

* **The Environment Contract:** All services must be entirely decoupled. Services must *never* hardcode connection URLs, file system paths, or socket ports. They must parse their upstream dependencies strictly from environment variables injected by LocalLink (e.g., `process.env.CORE_API_URL` or `os.environ["DATABASE_URL"]`).
* **The Blueprint Protocol:** Every native application created (Node/Python) should include a declarative `Dockerfile` serving as its static runtime blueprint.
* **Network Isolation Rules:** Clear parameters governing WSL-to-Windows communication boundaries (`host.docker.internal`).

---

## 4. System Architecture & Components (Phase 1)

### 4.1 Control Plane

* **LocalLink Coding MCP Server:** A Node.js/TypeScript or Go utility executing over standard I/O (`Stdio`). It directly intercepts tool-calls from the user's primary programming environment (Cursor/Claude) to read files, query ports, and execute scripts.
* **Blueprint Compliance Check:** A lightweight validation step embedded inside the control plane. It checks whether declared local services expose a readable Dockerfile blueprint and surfaces warnings when the blueprint is missing.
* **Blueprint Configuration Engine:** Reads local Dockerfiles as *static text configuration parameters* rather than targeting an engine build. It translates structural `EXPOSE`, `ENV`, and `CMD` layers natively into active variables inside `ecosystem.config.js` (PM2) or `.env`.
* **PWA Dashboard Server:** A lightweight, local web server binding to `127.0.0.1` that distributes the LocalLink management panel UI. Developers can install this as a native desktop web application window.

### 4.2 Data Plane

* **Infrastructure Layer:** Docker Compose managing long-running state containers (e.g., PostgreSQL, Redis, LiteLLM proxy).
* **Development Process Layer:** PM2 managing high-velocity, live-reloading codebases running natively in WSL 2 (e.g., Vite PWA dev server, custom Python file-watching CLI tools running inside fully isolated Python virtual environments managed by the local workspace daemon).
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
* **Aggregated Log Streamer:** Real-time console interface streaming output from stdout/stderr of local PM2 processes and Docker container instances.

#### 5.1.5 LocalLink Coding MCP Toolkit (Tools & Prompts)

| Tool Method | Input Parameters | Expected System Behavior / Output |
| --- | --- | --- |
| `read_workspace_blueprint` | None | Returns the text contents of the workspace orchestration files (`.env`, `docker-compose.yml`, `ecosystem.config.js`, `mcp-registry.json`). |
| `patch_workspace_blueprint` | `target_file` (string), `patch_payload` (object/string) | Safely mutates, appends, or alters variables and configuration stubs within the designated infrastructure files. |
| `allocate_system_port` | `preferred_start` (number, optional) | Programmatically scans the network stack and returns the next sequentially open port number. |
| `verify_blueprint_compliance` | `service_name` (string) | Checks whether a declared local service has a readable Dockerfile blueprint, returning pass/warn guidance. |
| `orchestrate_service` | `runtime` ('docker'|'pm2'|'taskfile'), `service_name` (string), `action` ('start'|'stop'|'restart'|'up') | Runs the pre-flight verification checks. On absolute validation pass, executes the underlying terminal commands inside WSL 2, capturing and returning the command execution feedback. |

---

## 6. Non-Functional Requirements (Phase 1)

* **Blueprint Check Performance:** The Dockerfile blueprint check must verify service compliance in **< 150ms** to prevent execution lag within AI agent iterative coding loops.
* **Zero Network Exposure:** In Phase 1, the system must rely on `Stdio` for MCP and bind web access exclusively to `localhost` to ensure zero unintended ports are leaked onto shared local networks.
* **Runtime Isolation:** Python scripts must automatically execute under individual virtual environment instances (`.venv`) initialized dynamically by LocalLink on first boot to preserve host system health.
* **Snapshot Relaunch Resilience:** The live dashboard may cache the last successful runtime snapshot locally for quick relaunch, but it must replace that cache with a freshly re-queried runtime view as soon as external managers are reachable again.

---

## 7. Future Implementation Roadmap (Phase 2)

### 7.1 Reverse Proxying via Caddy & Tailscale HTTPS

* **Goal:** Eliminate local port management and insecure browser connection blocks, allowing remote devices (such as a mobile phone on the same network) to securely connect and install local PWAs over validated HTTPS.
* **Execution:** Add a lightweight **Caddy** container into the data plane. Caddy will parse incoming traffic directed at a **Tailscale** node domain and auto-provision real SSL certificates. Coding agents will interact with this layer through structured `Caddyfile` tool updates.

### 7.2 Containerized Agent Bridges (SSE Gateway)

* **Goal:** Allow internal background tools running inside Docker containers (like an automated n8n setup) to cleanly interact with local MCP configurations without sharing system terminal access.
* **Execution:** Add a network bridge layer converting standard Stdio inputs into Server-Sent Events (SSE) using an abstraction layer like AgentGateway.

### 7.3 Isolated Local-Build Data MCP Sandboxes

* **Goal:** Limit the potential damage of runtime automation scripts (e.g., if an automated n8n loop goes haywire).
* **Execution:** Isolate the LocalLink Management MCP (which can alter system settings and run shell processes) from local-build runtime data MCPs (e.g., a `logseq-mcp` or a `csv-data-mcp`). These specific application data MCPs will have their file permissions strictly sandboxed and locked to their configured directory paths.
