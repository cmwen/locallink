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
        'LocalLink exposes local-only workspace blueprints, port allocation, and lifecycle controls for docker-compose, PM2, and taskfile-backed workflows.',
    },
  );

  const readWorkspaceBlueprint = async () => textResponse(JSON.stringify(await context.readInfraConfig(), null, 2));

  server.registerTool(
    'read_workspace_blueprint',
    {
      description: 'Return a structural view of workspace environment, service, extension, runtime, and MCP declarations.',
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
      description: 'Safely update a supported workspace environment, service, extension, runtime, or MCP declaration with raw content or a structured patch.',
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

  server.registerTool(
    'plan_extension_onboarding',
    {
      description: 'Preview workspace-owned extension changes and explicit user-owned onboarding checkpoints without mutating files.',
      inputSchema: z.object({
        capability: z.literal('private-edge'),
      }),
    },
    async ({ capability }) => textResponse(JSON.stringify(await context.planExtension(capability), null, 2)),
  );

  server.registerTool(
    'apply_extension_workspace_plan',
    {
      description: 'Apply only the workspace declaration and local environment portion of a previously reviewable extension plan.',
      inputSchema: z.object({
        capability: z.literal('private-edge'),
      }),
    },
    async ({ capability }) => textResponse(JSON.stringify(await context.applyExtension(capability), null, 2)),
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
