import fs from 'node:fs';

import fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';

import type { AppContext } from '../app-context';
import { TARGET_FILES } from '../shared/contracts';
import { AppError, isAppError } from '../shared/errors';
import { logDebug, logError } from '../shared/logger';

const writeConfigSchema = z
  .object({
    targetFile: z.enum(TARGET_FILES),
    content: z.string().optional(),
    patch: z.any().optional(),
  })
  .refine((value) => value.content !== undefined || value.patch !== undefined, {
    message: 'content or patch is required',
  });

const portSchema = z.object({
  startFrom: z.number().int().min(1024).max(65535).optional(),
  reserve: z.boolean().optional(),
  service: z.string().min(1).optional(),
});

const taskSchema = z.object({
  runtime: z.enum(['docker', 'pm2', 'taskfile']),
  serviceName: z.string().min(1),
  action: z.enum(['start', 'stop', 'restart', 'up']),
});

const processParamsSchema = z.object({
  pid: z.coerce.number().int().positive(),
});

const processTerminateSchema = z.object({
  signal: z.enum(['SIGTERM', 'SIGKILL']).optional(),
  identityToken: z.string().min(1),
  reason: z.string().max(500).optional(),
});

const preferencesSchema = z.object({
  dashboardEnabled: z.boolean().optional(),
  proxyEnabled: z.boolean().optional(),
  pocketIdEnabled: z.boolean().optional(),
  edgeEnabled: z.boolean().optional(),
});

const temporaryRuntimeSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  port: z.number().int().min(1024).max(65535),
  command: z.string().min(1),
});

const versionUpdateSchema = z.object({ from: z.string().min(1), to: z.string().min(1) });
const portReservationSchema = z.object({ service: z.string().min(1), port: z.number().int().min(1024).max(65535) });
const extensionCapabilitySchema = z.object({
  capability: z.literal('private-edge'),
  services: z.array(z.string().min(1)).max(100).optional(),
});

function toErrorPayload(error: unknown) {
  if (isAppError(error)) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      error: error.message,
      details: error.details,
    };
  }

  return {
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    error: error instanceof Error ? error.message : 'Unexpected error',
  };
}

export function createHttpServer(context: AppContext) {
  const app = fastify({
    logger: false,
  });

  app.addHook('onRequest', async (request) => {
    logDebug('HTTP request received.', {
      method: request.method,
      url: request.url,
    });
  });

  app.setErrorHandler((error, request, reply) => {
    const payload = toErrorPayload(error);
    logError('HTTP request failed.', {
      method: request.method,
      url: request.url,
      code: payload.code,
      statusCode: payload.statusCode,
      error: payload.error,
    });
    reply.status(payload.statusCode).send(payload);
  });

  void app.register(fastifyStatic, {
    root: context.paths.publicDir,
    prefix: '/',
  });
  if (fs.existsSync(context.paths.docsDir)) {
    void app.register(fastifyStatic, {
      root: context.paths.docsDir,
      prefix: '/docs/',
      decorateReply: false,
    });
  }

  app.get('/health', async () => {
    const workspace = await context.getWorkspaceIdentity();
    return {
      ok: true,
      workspace: {
        id: workspace.id,
        name: workspace.name,
      },
    };
  });

  app.get('/api/state', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return context.readState();
  });

  app.get('/api/workspace/settings', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return context.workspaceState.read();
  });

  app.get('/api/extensions', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return context.readExtensionLifecycle();
  });

  app.post('/api/extensions/plan', async (request, reply) => {
    const parsed = extensionCapabilitySchema.safeParse(request.body);
    if (!parsed.success) throw new AppError('INVALID_BODY', parsed.error.issues[0]?.message || 'Invalid body.', 400);
    reply.header('Cache-Control', 'no-store');
    return context.planExtension(parsed.data.capability, parsed.data.services);
  });

  app.post('/api/extensions/apply', async (request, reply) => {
    const parsed = extensionCapabilitySchema.safeParse(request.body);
    if (!parsed.success) throw new AppError('INVALID_BODY', parsed.error.issues[0]?.message || 'Invalid body.', 400);
    reply.header('Cache-Control', 'no-store');
    return context.applyExtension(parsed.data.capability, parsed.data.services);
  });

  app.patch('/api/workspace/settings', async (request, reply) => {
    const parsed = preferencesSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new AppError('INVALID_BODY', parsed.error.issues[0]?.message || 'Invalid body.', 400);
    reply.header('Cache-Control', 'no-store');
    return context.workspaceState.updatePreferences(parsed.data);
  });

  app.post('/api/workspace/runtimes', async (request, reply) => {
    const parsed = temporaryRuntimeSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError('INVALID_BODY', parsed.error.issues[0]?.message || 'Invalid body.', 400);
    const runtime = { id: `temp-${Date.now()}`, ...parsed.data, createdAt: new Date().toISOString(), status: 'planned' as const };
    reply.header('Cache-Control', 'no-store');
    return context.workspaceState.addTemporaryRuntime(runtime);
  });

  app.delete('/api/workspace/runtimes/:id', async (request, reply) => {
    const id = z.object({ id: z.string().min(1) }).parse(request.params).id;
    reply.header('Cache-Control', 'no-store');
    return context.workspaceState.removeTemporaryRuntime(id);
  });

  app.post('/api/workspace/updates', async (request, reply) => {
    const parsed = versionUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError('INVALID_BODY', parsed.error.issues[0]?.message || 'Invalid body.', 400);
    const update = { id: `update-${Date.now()}`, ...parsed.data, status: 'queued' as const, createdAt: new Date().toISOString() };
    reply.header('Cache-Control', 'no-store');
    return context.workspaceState.addVersionUpdate(update);
  });

  app.delete('/api/workspace/updates/:id', async (request, reply) => {
    const id = z.object({ id: z.string().min(1) }).parse(request.params).id;
    reply.header('Cache-Control', 'no-store');
    return context.workspaceState.cancelVersionUpdate(id);
  });

  app.post('/api/ports/reservations', async (request, reply) => {
    const parsed = portReservationSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError('INVALID_BODY', parsed.error.issues[0]?.message || 'Invalid body.', 400);
    reply.header('Cache-Control', 'no-store');
    return context.reservePort(parsed.data.service, parsed.data.port);
  });

  app.delete('/api/ports/reservations/:id', async (request, reply) => {
    const id = z.object({ id: z.string().min(1) }).parse(request.params).id;
    reply.header('Cache-Control', 'no-store');
    return context.releasePortReservation(id);
  });

  app.get('/api/configs', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return context.readInfraConfig();
  });

  app.post('/api/configs', async (request, reply) => {
    const parsed = writeConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('INVALID_BODY', parsed.error.issues[0]?.message || 'Invalid body.', 400);
    }

    reply.header('Cache-Control', 'no-store');
    return context.writeInfraConfig(parsed.data);
  });

  app.post('/api/ports/next', async (request, reply) => {
    const parsed = portSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new AppError('INVALID_BODY', parsed.error.issues[0]?.message || 'Invalid body.', 400);
    }

    reply.header('Cache-Control', 'no-store');
    return context.getAvailablePort(parsed.data.startFrom, parsed.data.reserve, parsed.data.service);
  });

  app.post('/api/tasks', async (request, reply) => {
    const parsed = taskSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('INVALID_BODY', parsed.error.issues[0]?.message || 'Invalid body.', 400);
    }

    reply.header('Cache-Control', 'no-store');
    return context.executeTask(parsed.data);
  });

  app.get('/api/processes/:pid', async (request, reply) => {
    const parsed = processParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new AppError('INVALID_PARAMS', parsed.error.issues[0]?.message || 'Invalid params.', 400);
    }

    reply.header('Cache-Control', 'no-store');
    return context.inspectProcess(parsed.data.pid);
  });

  app.get('/api/processes/:pid/termination-review', async (request, reply) => {
    const parsed = processParamsSchema.safeParse(request.params);
    if (!parsed.success) throw new AppError('INVALID_PARAMS', parsed.error.issues[0]?.message || 'Invalid params.', 400);
    reply.header('Cache-Control', 'no-store');
    return context.reviewProcessTermination(parsed.data.pid);
  });

  app.post('/api/processes/:pid/terminate', async (request, reply) => {
    const params = processParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new AppError('INVALID_PARAMS', params.error.issues[0]?.message || 'Invalid params.', 400);
    }

    const body = processTerminateSchema.safeParse(request.body ?? {});
    if (!body.success) {
      throw new AppError('INVALID_BODY', body.error.issues[0]?.message || 'Invalid body.', 400);
    }

    reply.header('Cache-Control', 'no-store');
    return context.terminateProcess(params.data.pid, body.data.signal, body.data.identityToken, body.data.reason);
  });

  app.get('/api/logs/stream', async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    await context.attachLiveLogs();
    for (const entry of context.logs.list().slice().reverse()) {
      reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    const unsubscribe = context.logs.subscribe((entry) => {
      reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`);
    });

    const heartbeat = setInterval(() => {
      reply.raw.write(': keepalive\n\n');
    }, 20_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      context.detachLiveLogs();
      reply.raw.end();
    };

    request.raw.on('close', cleanup);
  });

  app.get('/', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/dashboard', async (_request, reply) => reply.sendFile('dashboard.html'));
  app.get('/current', async (_request, reply) => reply.sendFile('dashboard.html'));
  app.get('/external', async (_request, reply) => reply.sendFile('dashboard.html'));
  app.get('/extensions', async (_request, reply) => reply.sendFile('dashboard.html'));
  app.get('/resources', async (_request, reply) => reply.sendFile('dashboard.html'));
  app.get('/template', async (_request, reply) => reply.sendFile('template.html'));
  app.get('/docs', async (_request, reply) => reply.redirect('/docs/'));

  return app;
}
