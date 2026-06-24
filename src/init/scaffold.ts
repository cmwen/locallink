import fs from 'node:fs/promises';
import path from 'node:path';

import { resolvePaths } from '../shared/paths';

export interface InitWorkspaceResult {
  root: string;
  created: string[];
  skipped: string[];
  readmePath: string;
}

const DEFAULT_ENV_TEMPLATE = `# LocalLink starter environment
LOCALLINK_SYSTEM_ID=local-system
COMPOSE_PROJECT_NAME=locallink_local_system
PM2_HOME=.locallink/pm2/local-system

LOCALLINK_BIND_HOST=127.0.0.1
LOCALLINK_API_PORT=4010
LOCALLINK_DASHBOARD_ENABLED=false
LOCALLINK_DASHBOARD_PORT=4011
LOCALLINK_DEFAULT_PORT_START=5000
LOCALLINK_ENABLE_PHASE2_ADVISOR=true
LOCALLINK_PHASE2_PREFERRED_EDGE=auto

# Optional OpenObserve OTEL extension
LOCALLINK_OTEL_ENABLED=false
OPENOBSERVE_ENDPOINT=
OPENOBSERVE_ORGANIZATION=
OPENOBSERVE_STREAM=default
OPENOBSERVE_TOKEN=
`;

const EMPTY_COMPOSE_TEMPLATE = `name: \${COMPOSE_PROJECT_NAME:-locallink_local_system}

# LocalLink starter Docker topology
services: {}
`;

const MCP_REGISTRY_TEMPLATE = `{
  "servers": [],
  "volumes": []
}
`;

const LOCK_TEMPLATE = `{
  "services": {}
}
`;

const EXTENSIONS_TEMPLATE = `# Optional LocalLink workspace extensions.
extensions:
  - id: dashboard
    name: Dashboard
    kind: dashboard
    enabled: false
    exposedPorts:
      - "\${LOCALLINK_DASHBOARD_PORT:-4011}"
  - id: caddy
    name: Caddy Reverse Proxy
    kind: reverse-proxy
    enabled: false
    command: caddy
  - id: tailscale
    name: Tailscale Network Edge
    kind: network-edge
    enabled: false
    command: tailscale
  - id: openobserve
    name: OpenObserve OTEL
    kind: observability
    enabled: false
    requiredEnv:
      - OPENOBSERVE_ENDPOINT
      - OPENOBSERVE_ORGANIZATION
      - OPENOBSERVE_STREAM
      - OPENOBSERVE_TOKEN
`;

const SERVICES_TEMPLATE = `# LocalLink service topology.
#
# Docker services belong in docker-compose.yml. Native PM2, PWA, Windows, and
# task-backed services belong here with blueprint paths and metadata.
services:
  # - name: My Service
  #   group: pm2
  #   runtime: pm2
  #   runtimeName: my-service
  #   cwd: .
  #   blueprint: ./Dockerfile
  #   portEnv: MY_SERVICE_PORT
  #   dependsOn:
  #     - Postgres Compose
  #   downstream:
  #     - LocalLink Dashboard UI
  #   envVars:
  #     - MY_SERVICE_PORT
  #   docsUrl: https://example.com/docs
  #   notes: What this service does.
  #   detail: Longer explanation for humans and agents.
  #   tags:
  #     - api
  #     - pm2
`;

const EMPTY_ECOSYSTEM_TEMPLATE = `// Optional PM2-native escape hatch.
// Prefer locallink.services.yml plus Dockerfile-style blueprints for LocalLink topology.
module.exports = {
  apps: [],
};
`;

const TASKFILE_TEMPLATE = `version: "3"

tasks:
  up:
    cmds:
      - echo "Define your shared workspace bootstrap here"
  clear:
    cmds:
      - echo "Define your workspace cleanup here"
`;

const GITIGNORE_TEMPLATE = `# LocalLink secrets
.env
.env.local
.env.*.local

# Runtime output
dist/
tmp/
.cache/
.locallink/
`;

const AGENTS_TEMPLATE = `# AGENTS.md

This workspace is orchestrated by LocalLink.

## Dependency resolution rule

- Never hardcode ports, URLs, or credentials in service source code.
- Resolve upstream dependencies strictly from environment variables injected by LocalLink.

## Scaffolding conventions

- Declare Docker services in \`docker-compose.yml\`.
- Declare PM2, PWA, Windows, or task-backed services in \`locallink.services.yml\`.
- For native Node or Python services, maintain a declarative \`Dockerfile\` (or an explicitly referenced Dockerfile blueprint) as the static runtime contract.
- Use \`ecosystem.config.js\` only when a service needs PM2-native options such as clustering, watches, or custom log paths.
- Use \`locallink.extensions.yml\` for optional dashboard, Caddy, Tailscale, OpenObserve, or custom workspace capabilities.
- Add optional LocalLink metadata such as \`dependsOn\`, \`downstream\`, \`envVars\`, and \`docsUrl\`.

## Network isolation rules

- Phase 1 is localhost-only by default.
- Treat Tailscale / reverse-proxy recommendations as optional Phase 2 edge capabilities.
- Use relative paths or translated WSL paths for external volume mappings.
`;

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readEnvTemplate(appRoot: string): Promise<string> {
  try {
    return await fs.readFile(path.join(appRoot, '.env.example'), 'utf8');
  } catch {
    return DEFAULT_ENV_TEMPLATE;
  }
}

function buildReadmeTemplate(readmeFileName: string): string {
  return `# LocalLink starter workspace

This folder was initialized by \`locallink init\`.

## Generated files

- \`.env\` — local runtime defaults, system id, ports, Compose project name, and PM2 home
- \`.env.example\` — shareable non-secret defaults for collaborators and agents
- \`.gitignore\` — starter ignore rules for secrets and generated output
- \`Taskfile.yml\` — starter workspace orchestration tasks
- \`docker-compose.yml\` — Docker services and LocalLink labels
- \`locallink.services.yml\` — PM2 / PWA / Windows / task-backed services plus LocalLink metadata
- \`locallink.lock.json\` — resolved tool and service artifact versions
- \`locallink.extensions.yml\` — optional dashboard, edge, proxy, and observability extensions
- \`ecosystem.config.js\` — optional PM2-native escape hatch
- \`mcp-registry.json\` — optional registry for local-build MCP servers and mapped volumes
- \`AGENTS.md\` — LocalLink agent conventions and guardrails
- \`${readmeFileName}\` — this guide

## Start here

1. Add your Docker services to \`docker-compose.yml\`.
2. Add your PM2, PWA, Windows, or task-backed services to \`locallink.services.yml\`.
3. For native Node or Python services, create a Dockerfile that declares:
   - \`EXPOSE\` for the local service port
   - \`ENV\` keys for required runtime configuration
   - \`CMD\` / \`ENTRYPOINT\` for the launch contract that LocalLink can adapt to PM2
4. Enrich each service with optional metadata such as:
   - \`dependsOn\`
   - \`downstream\`
   - \`envVars\`
   - \`docsUrl\`
5. Bring up the workspace, or run individual LocalLink surfaces:

\`\`\`bash
locallink up
locallink down
locallink api
locallink dashboard
locallink mcp
\`\`\`

## Helpful notes

- Set \`LOCALLINK_ENABLE_PHASE2_ADVISOR=false\` in \`.env\` to opt out of Tailscale / reverse-proxy suggestions.
- Enable \`dashboard\`, \`caddy\`, \`tailscale\`, or \`openobserve\` in \`locallink.extensions.yml\` when those optional layers should be part of the workspace.
- Use a unique \`LOCALLINK_SYSTEM_ID\`, \`COMPOSE_PROJECT_NAME\`, \`PM2_HOME\`, and port block for each system workspace you run on the same machine.
- Use \`locallink up\` to start the API, active services, and enabled extensions; use \`locallink down\` to stop LocalLink-initiated processes.
- Use \`locallink api --log-level debug\` (or \`LOCALLINK_LOG_LEVEL=debug\`) when you want stderr traces for startup, workspace parsing, and runtime probing.
- LocalLink will surface a blueprint compliance warning when a local PM2 or task-backed service does not declare a readable Dockerfile blueprint.
- Dashboard state is rehydrated from external runtime managers on each refresh/startup; services LocalLink cannot verify confidently are shown as \`Unknown\`.
- The Resource view highlights high CPU / RAM processes and lets you inspect or terminate them from the dashboard.
- Keep the service metadata up to date so the dashboard can explain dependencies and operational context to users and agents.
`;
}

export async function initializeWorkspace(root: string): Promise<InitWorkspaceResult> {
  const paths = resolvePaths(root);
  const created: string[] = [];
  const skipped: string[] = [];
  const readmePath = (await exists(path.join(root, 'README.md')))
    ? path.join(root, 'README.locallink.md')
    : path.join(root, 'README.md');

  const files = [
    {
      target: path.join(root, '.env'),
      content: await readEnvTemplate(paths.appRoot),
    },
    {
      target: path.join(root, '.env.example'),
      content: await readEnvTemplate(paths.appRoot),
    },
    {
      target: path.join(root, '.gitignore'),
      content: GITIGNORE_TEMPLATE,
    },
    {
      target: path.join(root, 'Taskfile.yml'),
      content: TASKFILE_TEMPLATE,
    },
    {
      target: path.join(root, 'docker-compose.yml'),
      content: EMPTY_COMPOSE_TEMPLATE,
    },
    {
      target: path.join(root, 'locallink.services.yml'),
      content: SERVICES_TEMPLATE,
    },
    {
      target: path.join(root, 'locallink.lock.json'),
      content: LOCK_TEMPLATE,
    },
    {
      target: path.join(root, 'locallink.extensions.yml'),
      content: EXTENSIONS_TEMPLATE,
    },
    {
      target: path.join(root, 'ecosystem.config.js'),
      content: EMPTY_ECOSYSTEM_TEMPLATE,
    },
    {
      target: path.join(root, 'mcp-registry.json'),
      content: MCP_REGISTRY_TEMPLATE,
    },
    {
      target: path.join(root, 'AGENTS.md'),
      content: AGENTS_TEMPLATE,
    },
    {
      target: readmePath,
      content: buildReadmeTemplate(path.basename(readmePath)),
    },
  ];

  await fs.mkdir(root, { recursive: true });
  for (const file of files) {
    if (await exists(file.target)) {
      skipped.push(file.target);
      continue;
    }

    await fs.writeFile(file.target, file.content, 'utf8');
    created.push(file.target);
  }

  return {
    root,
    created,
    skipped,
    readmePath,
  };
}
