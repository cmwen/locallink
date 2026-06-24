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
});

const toolVersionCheckSchema = z.object({
  serviceName: z.string().min(1),
});

const toolVersionUpdateSchema = z.object({
  serviceName: z.string().min(1),
  targetVersion: z.string().min(1),
  dryRun: z.boolean().optional(),
});

const toolTrialPlanSchema = z.object({
  serviceName: z.string().min(1),
  toolSource: z
    .object({
      type: z.enum(['docker-image', 'npm', 'git', 'local-binary', 'taskfile', 'manual']),
      ref: z.string().min(1),
    })
    .optional(),
  version: z.string().optional(),
  runtime: z.enum(['docker', 'pm2', 'taskfile']).optional(),
  port: z.string().optional(),
  ttlHours: z.number().int().positive().optional(),
});

const toolTrialProvisionSchema = z.object({
  planId: z.string().min(1),
});

const toolTrialPromoteSchema = z.object({
  trialId: z.string().min(1),
  serviceName: z.string().min(1).optional(),
});

const toolRemoveSchema = z.object({
  serviceName: z.string().min(1),
  mode: z.enum(['trial', 'persistent']),
  dryRun: z.boolean().optional(),
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

export function createHttpServer(context: AppContext, options: { dashboardEnabled?: boolean } = {}) {
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

  if (options.dashboardEnabled) {
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
  } else if (fs.existsSync(context.paths.docsDir)) {
    void app.register(fastifyStatic, {
      root: context.paths.docsDir,
      prefix: '/docs/',
      decorateReply: false,
    });
  }

  app.get('/health', async () => ({ ok: true }));

  app.get('/api/state', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return context.readState();
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
    return context.getAvailablePort(parsed.data.startFrom);
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
    return context.terminateProcess(params.data.pid, body.data.signal);
  });

  app.get('/api/tools', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return context.readToolWorkspace();
  });

  app.get('/api/extensions', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return context.readExtensionWorkspace();
  });

  app.post('/api/tools/version/check', async (request, reply) => {
    const parsed = toolVersionCheckSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('INVALID_BODY', parsed.error.issues[0]?.message || 'Invalid body.', 400);
    }

    reply.header('Cache-Control', 'no-store');
    return context.checkToolVersion(parsed.data.serviceName);
  });

  app.post('/api/tools/version/update', async (request, reply) => {
    const parsed = toolVersionUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('INVALID_BODY', parsed.error.issues[0]?.message || 'Invalid body.', 400);
    }

    reply.header('Cache-Control', 'no-store');
    return context.updateToolVersion(parsed.data.serviceName, parsed.data.targetVersion, parsed.data.dryRun !== false);
  });

  app.post('/api/tools/trials/plan', async (request, reply) => {
    const parsed = toolTrialPlanSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('INVALID_BODY', parsed.error.issues[0]?.message || 'Invalid body.', 400);
    }

    reply.header('Cache-Control', 'no-store');
    return context.planToolTrial(parsed.data);
  });

  app.post('/api/tools/trials/provision', async (request, reply) => {
    const parsed = toolTrialProvisionSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('INVALID_BODY', parsed.error.issues[0]?.message || 'Invalid body.', 400);
    }

    reply.header('Cache-Control', 'no-store');
    return context.provisionToolTrial(parsed.data.planId);
  });

  app.post('/api/tools/trials/promote', async (request, reply) => {
    const parsed = toolTrialPromoteSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('INVALID_BODY', parsed.error.issues[0]?.message || 'Invalid body.', 400);
    }

    reply.header('Cache-Control', 'no-store');
    return context.promoteToolTrial(parsed.data.trialId, parsed.data.serviceName);
  });

  app.post('/api/tools/remove', async (request, reply) => {
    const parsed = toolRemoveSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('INVALID_BODY', parsed.error.issues[0]?.message || 'Invalid body.', 400);
    }

    reply.header('Cache-Control', 'no-store');
    return context.removeToolService(parsed.data.serviceName, parsed.data.mode, parsed.data.dryRun !== false);
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

  if (options.dashboardEnabled) {
    app.get('/', async (_request, reply) => reply.sendFile('index.html'));
    app.get('/dashboard', async (_request, reply) => reply.sendFile('dashboard.html'));
    app.get('/template', async (_request, reply) => reply.sendFile('template.html'));
    app.get('/docs', async (_request, reply) => reply.redirect('/docs/'));
  } else {
    app.get('/', async () => ({
      name: 'LocalLink API',
      dashboard: 'disabled',
      hint: 'Run `locallink dashboard` or enable the dashboard extension to serve the UI.',
    }));
    app.get('/dashboard', async (_request, reply) =>
      reply.status(404).send({
        code: 'DASHBOARD_DISABLED',
        error: 'Dashboard serving is disabled for the headless API surface.',
      }),
    );
    app.get('/docs', async (_request, reply) => reply.redirect('/docs/'));
  }

  return app;
}
