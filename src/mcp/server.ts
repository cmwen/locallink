import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';

import type { AppContext } from '../app-context';
import { TARGET_FILES } from '../shared/contracts';

function textResponse(text: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text,
      },
    ],
  };
}

export async function startMcpServer(context: AppContext): Promise<McpServer> {
  const server = new McpServer(
    {
      name: 'locallink',
      version: '0.1.0',
    },
    {
      instructions:
        'LocalLink exposes local-only workspace blueprints, neutral service metadata, optional extension discovery, tool version management, trial provisioning, port allocation, and lifecycle controls for docker-compose, PM2, and taskfile-backed workflows.',
    },
  );

  const readWorkspaceBlueprint = async () => textResponse(JSON.stringify(await context.readInfraConfig(), null, 2));

  server.registerTool(
    'read_ai_manifest',
    {
      description: 'Return agent-facing LocalLink CLI and workspace guidance, including JSON commands, runtime state path, and current status.',
    },
    async () => textResponse(JSON.stringify(await context.readAiManifest(), null, 2)),
  );

  server.registerTool(
    'read_workspace_status',
    {
      description: 'Return assigned LocalLink API/dashboard ports, URLs, service counts, and next available port for this workspace.',
    },
    async () => textResponse(JSON.stringify(await context.readWorkspaceStatus(), null, 2)),
  );

  server.registerTool(
    'read_workspace_blueprint',
    {
      description: 'Return a structural view of .env, docker-compose.yml, locallink.services.yml, locallink.lock.json, locallink.extensions.yml, optional ecosystem.config.js, and mcp-registry.json.',
    },
    readWorkspaceBlueprint,
  );
  server.registerTool(
    'read_infra_config',
    {
      description: 'Backward-compatible alias for read_workspace_blueprint.',
    },
    readWorkspaceBlueprint,
  );

  const patchWorkspaceBlueprint = async ({
    target_file,
    content,
    patch,
  }: {
    target_file: (typeof TARGET_FILES)[number];
    content?: string;
    patch?: Record<string, unknown>;
  }) =>
    textResponse(
      JSON.stringify(
        await context.writeInfraConfig({
          targetFile: target_file,
          content,
          patch: patch as any,
        }),
        null,
        2,
      ),
    );

  server.registerTool(
    'patch_workspace_blueprint',
    {
      description: 'Safely update .env, .env.example, docker-compose.yml, locallink.services.yml, locallink.lock.json, locallink.extensions.yml, optional ecosystem.config.js, or mcp-registry.json with raw content or a structured patch.',
      inputSchema: z
        .object({
          target_file: z.enum(TARGET_FILES),
          content: z.string().optional(),
          patch_payload: z.record(z.string(), z.any()).optional(),
        })
        .refine((value) => value.content !== undefined || value.patch_payload !== undefined, {
          message: 'content or patch is required',
        }),
    },
    async ({ target_file, content, patch_payload }) =>
      patchWorkspaceBlueprint({
        target_file,
        content,
        patch: patch_payload,
      }),
  );
  server.registerTool(
    'write_infra_config',
    {
      description: 'Backward-compatible alias for patch_workspace_blueprint.',
      inputSchema: z
        .object({
          target_file: z.enum(TARGET_FILES),
          content: z.string().optional(),
          patch: z.record(z.string(), z.any()).optional(),
        })
        .refine((value) => value.content !== undefined || value.patch !== undefined, {
          message: 'content or patch is required',
        }),
    },
    async ({ target_file, content, patch }) =>
      patchWorkspaceBlueprint({
        target_file,
        content,
        patch,
      }),
  );

  const allocateSystemPort = async ({ start_from }: { start_from?: number }) =>
    textResponse(JSON.stringify(await context.getAvailablePort(start_from), null, 2));

  server.registerTool(
    'allocate_system_port',
    {
      description: 'Scan the local network stack and return the next sequentially free port.',
      inputSchema: z.object({
        preferred_start: z.number().int().min(1024).max(65535).optional(),
      }),
    },
    async ({ preferred_start }) =>
      allocateSystemPort({
        start_from: preferred_start,
      }),
  );
  server.registerTool(
    'get_available_port',
    {
      description: 'Backward-compatible alias for allocate_system_port.',
      inputSchema: z.object({
        start_from: z.number().int().min(1024).max(65535).optional(),
      }),
    },
    allocateSystemPort,
  );

  const orchestrateService = async ({
    runtime,
    service_name,
    action,
  }: {
    runtime: 'docker' | 'pm2' | 'taskfile';
    service_name: string;
    action: 'start' | 'stop' | 'restart' | 'up';
  }) =>
    textResponse(
      JSON.stringify(
        await context.executeTask({
          runtime,
          serviceName: service_name,
          action,
        }),
        null,
        2,
      ),
    );

  server.registerTool(
    'orchestrate_service',
    {
      description: 'Run docker-compose, PM2, or taskfile lifecycle commands for a declared service and return the output.',
      inputSchema: z.object({
        runtime: z.enum(['docker', 'pm2', 'taskfile']),
        service_name: z.string().min(1),
        action: z.enum(['start', 'stop', 'restart', 'up']),
      }),
    },
    orchestrateService,
  );

  server.registerTool(
    'read_tool_workspace',
    {
      description: 'Return version status, lock-state summary, and temporary trial services managed by LocalLink.',
    },
    async () => textResponse(JSON.stringify(await context.readToolWorkspace(), null, 2)),
  );

  server.registerTool(
    'read_extension_workspace',
    {
      description: 'Return optional extension status for dashboard, Caddy, Tailscale, OpenObserve OTEL, and custom workspace extensions without exposing secret values.',
    },
    async () => textResponse(JSON.stringify(await context.readExtensionWorkspace(), null, 2)),
  );

  server.registerTool(
    'check_tool_version',
    {
      description: 'Resolve the latest available version for a declared tool when LocalLink can inspect its source.',
      inputSchema: z.object({
        service_name: z.string().min(1),
      }),
    },
    async ({ service_name }) => textResponse(JSON.stringify(await context.checkToolVersion(service_name), null, 2)),
  );

  server.registerTool(
    'update_tool_version',
    {
      description: 'Plan or apply a version change for a declared service. Defaults to dry-run.',
      inputSchema: z.object({
        service_name: z.string().min(1),
        target_version: z.string().min(1),
        dry_run: z.boolean().optional(),
      }),
    },
    async ({ service_name, target_version, dry_run }) =>
      textResponse(
        JSON.stringify(
          await context.updateToolVersion(service_name, target_version, dry_run !== false),
          null,
          2,
        ),
      ),
  );

  const toolSourceSchema = z
    .object({
      type: z.enum(['docker-image', 'npm', 'git', 'local-binary', 'taskfile', 'manual']),
      ref: z.string().min(1),
    })
    .optional();

  server.registerTool(
    'plan_tool_trial',
    {
      description: 'Create a dry-run plan for a temporary tool service before provisioning it.',
      inputSchema: z.object({
        service_name: z.string().min(1),
        tool_source: toolSourceSchema,
        version: z.string().optional(),
        runtime: z.enum(['docker', 'pm2', 'taskfile']).optional(),
        port: z.string().optional(),
        ttl_hours: z.number().int().positive().optional(),
      }),
    },
    async ({ service_name, tool_source, version, runtime, port, ttl_hours }) =>
      textResponse(
        JSON.stringify(
          context.planToolTrial({
            serviceName: service_name,
            toolSource: tool_source,
            version,
            runtime,
            port,
            ttlHours: ttl_hours,
          }),
          null,
          2,
        ),
      ),
  );

  server.registerTool(
    'provision_tool_trial',
    {
      description: 'Provision a previously approved temporary tool trial under .locallink/trials.',
      inputSchema: z.object({
        approved_plan_id: z.string().min(1),
      }),
    },
    async ({ approved_plan_id }) =>
      textResponse(JSON.stringify(await context.provisionToolTrial(approved_plan_id), null, 2)),
  );

  server.registerTool(
    'promote_tool_trial',
    {
      description: 'Promote a temporary tool trial into persistent LocalLink service configuration.',
      inputSchema: z.object({
        trial_id: z.string().min(1),
        service_name: z.string().min(1).optional(),
      }),
    },
    async ({ trial_id, service_name }) =>
      textResponse(JSON.stringify(await context.promoteToolTrial(trial_id, service_name), null, 2)),
  );

  server.registerTool(
    'remove_tool_service',
    {
      description: 'Plan or perform removal of a trial or persistent service. Defaults to dry-run.',
      inputSchema: z.object({
        service_name: z.string().min(1),
        mode: z.enum(['trial', 'persistent']),
        dry_run: z.boolean().optional(),
      }),
    },
    async ({ service_name, mode, dry_run }) =>
      textResponse(
        JSON.stringify(
          await context.removeToolService(service_name, mode, dry_run !== false),
          null,
          2,
        ),
      ),
  );
  server.registerTool(
    'execute_task',
    {
      description: 'Backward-compatible alias for orchestrate_service.',
      inputSchema: z.object({
        runtime: z.enum(['docker', 'pm2', 'taskfile']),
        service_name: z.string().min(1),
        action: z.enum(['start', 'stop', 'restart', 'up']),
      }),
    },
    orchestrateService,
  );

  const verifyBlueprintCompliance = async ({ service_name }: { service_name: string }) =>
    textResponse(JSON.stringify(await context.verifyServiceCompliance(service_name), null, 2));

  server.registerTool(
    'verify_blueprint_compliance',
    {
      description: 'Check whether a declared local service has a readable Dockerfile blueprint.',
      inputSchema: z.object({
        service_name: z.string().min(1),
      }),
    },
    verifyBlueprintCompliance,
  );
  server.registerTool(
    'verify_lego_compliance',
    {
      description: 'Backward-compatible alias for verify_blueprint_compliance.',
      inputSchema: z.object({
        service_name: z.string().min(1),
      }),
    },
    verifyBlueprintCompliance,
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
