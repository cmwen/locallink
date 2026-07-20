import fs from 'node:fs/promises';
import path from 'node:path';

import { composeProjectName, deriveWorkspaceIdentity } from '../workspace/identity';

export interface InitWorkspaceResult {
  root: string;
  created: string[];
  skipped: string[];
  readmePath: string;
}

function buildEnvTemplate(root: string): string {
  const identity = deriveWorkspaceIdentity(root);
  return `# LocalLink starter environment
LOCALLINK_WORKSPACE_ID=${identity.id}
COMPOSE_PROJECT_NAME=${composeProjectName(identity.id)}
PM2_HOME=.locallink/pm2
LOCALLINK_BIND_HOST=127.0.0.1
LOCALLINK_WEB_PORT=auto
LOCALLINK_WEB_PORT_START=4010
LOCALLINK_DEFAULT_PORT_START=5000
LOCALLINK_ENABLE_PHASE2_ADVISOR=true
LOCALLINK_PHASE2_PREFERRED_EDGE=auto
# Optional: pin the first generated per-workspace Tailscale HTTPS listener.
# LOCALLINK_PRIVATE_EDGE_PORT_START=7451
`;
}

const EMPTY_COMPOSE_TEMPLATE = `# LocalLink starter Docker topology.
# Add services here or install an optional capability through LocalLink.
services: {}
`;

const MCP_REGISTRY_TEMPLATE = `{
  "servers": [],
  "volumes": []
}
`;

const EXTENSIONS_TEMPLATE = `# LocalLink workspace capabilities.
# Optional network edge, identity, and observability extensions are installed per workspace.
extensions:
  - id: dashboard
    name: Dashboard
    kind: dashboard
    enabled: true
    exposedPorts:
      - "\${LOCALLINK_WEB_PORT:-auto}"
    docsUrl: /docs/extensions.html#dashboard
`;

const EMPTY_ECOSYSTEM_TEMPLATE = `// LocalLink starter PM2 / task topology.
module.exports = {
  apps: [
    // {
    //   name: 'my-runtime-name',
    //   script: './server.js',
    //   locallink: {
    //     name: 'My Service',
    //     group: 'pm2',
    //     runtime: 'pm2',
    //     dockerfile: './Dockerfile',
    //     portEnv: 'MY_SERVICE_PORT',
    //     dependsOn: ['Postgres Compose'],
    //     downstream: ['LocalLink Dashboard UI'],
    //     envVars: ['MY_SERVICE_PORT'],
    //     docsUrl: 'https://example.com/docs',
    //     notes: 'What this service does.',
    //     detail: 'Longer explanation for humans and agents.',
    //     tags: ['api', 'pm2'],
    //   },
    // },
  ],
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
.locallink/
dist/
tmp/
.cache/
`;

const AGENTS_TEMPLATE = `# AGENTS.md

This workspace is orchestrated by LocalLink.

## Dependency resolution rule

- Never hardcode ports, URLs, or credentials in service source code.
- Resolve upstream dependencies strictly from environment variables injected by LocalLink.
- Keep identity and telemetry adapters provider-neutral so extensions can be replaced without rewriting application code.
- Read OIDC and OpenTelemetry configuration from the workspace environment; never print or commit secret values.

## Scaffolding conventions

- Declare Docker services in \`docker-compose.yml\`.
- Declare PM2 or task-backed services in \`ecosystem.config.js\`.
- For native Node or Python services, maintain a declarative \`Dockerfile\` (or an explicitly referenced Dockerfile blueprint) as the static runtime contract.
- Add optional LocalLink metadata such as \`dependsOn\`, \`downstream\`, \`envVars\`, and \`docsUrl\`.

## Network isolation rules

- Phase 1 is localhost-only by default.
- Treat Tailscale, reverse proxy, identity, and observability integrations as optional workspace extensions.
- Do not assume an extension installed in one LocalLink workspace is available to another workspace.
- Keep LocalLink state, PM2 processes, Docker Compose resources, generated configuration, and secrets inside this workspace's namespace.
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

function buildReadmeTemplate(readmeFileName: string): string {
  return `# LocalLink starter workspace

This folder was initialized by \`locallink init\`.

## Generated files

- \`.env\` — local runtime defaults and this workspace's stable identity
- \`.env.example\` — shareable defaults for collaborators and agents
- \`.gitignore\` — starter ignore rules for secrets and generated output
- \`Taskfile.yml\` — starter workspace orchestration tasks
- \`docker-compose.yml\` — Docker services and LocalLink labels
- \`locallink.extensions.yml\` — enabled capabilities and their readiness requirements
- \`ecosystem.config.js\` — PM2 / task-backed services plus LocalLink metadata
- \`mcp-registry.json\` — optional registry for local-build MCP servers and mapped volumes
- \`AGENTS.md\` — LocalLink agent conventions and guardrails
- \`${readmeFileName}\` — this guide

## Start here

1. Add your Docker services to \`docker-compose.yml\`.
2. Add your PM2 or task-backed services to \`ecosystem.config.js\`.
3. For native Node or Python services, create a Dockerfile that declares:
   - \`EXPOSE\` for the local service port
   - \`ENV\` keys for required runtime configuration
   - \`CMD\` / \`ENTRYPOINT\` for the launch contract
4. Enrich each service with optional metadata such as:
   - \`dependsOn\`
   - \`downstream\`
   - \`envVars\`
   - \`docsUrl\`
5. Run LocalLink:

\`\`\`bash
locallink web
locallink mcp
locallink extensions
locallink extension plan private-edge
\`\`\`

## Helpful notes

- Each workspace has a stable \`LOCALLINK_WORKSPACE_ID\`, its own Docker Compose project, its own PM2 home, and its own \`.locallink\` state directory.
- \`LOCALLINK_WEB_PORT=auto\` finds the first available dashboard port from \`LOCALLINK_WEB_PORT_START\`, so multiple LocalLink dashboards can run on one machine. Set a numeric port to pin it.
- Optional Private Edge, identity, and observability extensions are configured per workspace. The core dashboard does not require them.
- Set \`LOCALLINK_ENABLE_PHASE2_ADVISOR=false\` in \`.env\` to opt out of Private Edge suggestions.
- Use \`locallink web --log-level debug\` (or \`LOCALLINK_LOG_LEVEL=debug\`) when you want stderr traces for startup, workspace parsing, and runtime probing.
- LocalLink will surface a blueprint compliance warning when a local PM2 or task-backed service does not declare a readable Dockerfile blueprint.
- Dashboard state is rehydrated from external runtime managers on each refresh/startup; services LocalLink cannot verify confidently are shown as \`Unknown\`.
- The Resource view highlights high CPU / RAM processes and lets you inspect or terminate them from the dashboard.
- Keep the service metadata up to date so the dashboard can explain dependencies and operational context to users and agents.
`;
}

export async function initializeWorkspace(root: string): Promise<InitWorkspaceResult> {
  const created: string[] = [];
  const skipped: string[] = [];
  const envTemplate = buildEnvTemplate(root);
  const readmePath = (await exists(path.join(root, 'README.md')))
    ? path.join(root, 'README.locallink.md')
    : path.join(root, 'README.md');

  const files = [
    {
      target: path.join(root, '.env'),
      content: envTemplate,
    },
    {
      target: path.join(root, '.env.example'),
      content: envTemplate,
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
