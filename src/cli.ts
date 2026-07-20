#!/usr/bin/env node

import path from 'node:path';

import type { FastifyInstance } from 'fastify';

import { AppContext } from './app-context';
import { initializeWorkspace } from './init/scaffold';
import { startMcpServer } from './mcp/server';
import { parseCliOptions } from './shared/cli-options';
import { AppError, formatFatalError } from './shared/errors';
import { configureLogger, getLoggerLevel, logError, logInfo } from './shared/logger';
import { resolveProjectRoot } from './shared/paths';
import {
  formatActionableStartupDiagnosticsReport,
  formatStartupDiagnosticsReport,
} from './startup/diagnostics';

async function runServe(context: AppContext): Promise<FastifyInstance> {
  const server = context.createServer();
  const binding = await context.getBinding();
  try {
    await server.listen({
      host: binding.host,
      port: binding.port,
    });
  } catch (error) {
    throw new AppError(
      'WEB_SERVER_START_FAILED',
      `LocalLink could not start the dashboard on http://${binding.host}:${binding.port}: ${formatFatalError(
        error,
      )}. Check LOCALLINK_BIND_HOST and LOCALLINK_WEB_PORT in the workspace .env, or stop the process using that port.`,
      500,
    );
  }
  const runtime = await context.recordRuntimeBinding(binding);
  server.addHook('onClose', async () => context.clearRuntimeBinding(runtime.pid));
  context.logs.append(`Dashboard server for ${runtime.id} listening on ${runtime.url}.`, 'Runtime');
  logInfo('LocalLink dashboard server started.', {
    workspaceId: runtime.id,
    workspaceRoot: runtime.root,
    url: runtime.url,
    automaticPort: runtime.automatic,
  });
  return server;
}

function normalizeCommand(rawCommand: string | undefined): string {
  switch (rawCommand) {
    case undefined:
    case '':
    case 'start':
    case 'serve':
    case 'web':
      return 'web';
    case 'mcp':
    case 'snapshot':
    case 'extensions':
    case 'doctor':
    case 'init':
      return rawCommand;
    case 'help':
    case '-h':
    case '--help':
      return 'help';
    default:
      return rawCommand;
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      'LocalLink CLI',
      '',
      'Usage:',
      '  locallink [--log-level LEVEL] web       Start the local PWA web app',
      '  locallink [--log-level LEVEL] mcp       Start the MCP stdio server',
      '  locallink [--log-level LEVEL] doctor    Print startup diagnostics and install guidance',
      '  locallink [--log-level LEVEL] snapshot  Print the current dashboard state as JSON',
      '  locallink [--log-level LEVEL] extensions Print declared, installed, manual, and healthy extension states',
      '  locallink [--log-level LEVEL] init      Scaffold a starter LocalLink workspace here',
      '  locallink [--log-level LEVEL] init NAME Scaffold a starter LocalLink workspace in ./NAME',
      '',
      'Aliases:',
      '  locallink serve',
      '  locallink start',
      '',
      'Options:',
      '  -l, --log-level LEVEL  One of: silent, error, warn, info, debug',
      '                          Defaults to info. Can also be set via LOCALLINK_LOG_LEVEL.',
      '',
    ].join('\n'),
  );
}

function printStartupDiagnosticsIfNeeded(report: string, hasIssues: boolean): void {
  if (!hasIssues) {
    return;
  }

  process.stderr.write(report);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseCliOptions(argv);
  configureLogger(options.logLevel, 'info');
  const command = normalizeCommand(options.positionals[0]);
  const workspaceRoot = resolveProjectRoot();
  logInfo('LocalLink CLI command starting.', {
    command,
    workspaceRoot,
    logLevel: getLoggerLevel(),
  });

  if (command === 'help') {
    printHelp();
    return;
  }

  if (command === 'init') {
    const workspaceArg = options.positionals[1];
    const targetRoot = workspaceArg ? path.resolve(process.cwd(), workspaceArg) : workspaceRoot;
    const result = await initializeWorkspace(targetRoot);
    process.stdout.write(
      [
        `LocalLink initialized ${result.root}`,
        result.created.length > 0 ? `Created:\n- ${result.created.join('\n- ')}` : 'Created:\n- nothing (all starter files already existed)',
        result.skipped.length > 0 ? `Skipped:\n- ${result.skipped.join('\n- ')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n') + '\n',
    );
    return;
  }

  const context = new AppContext(workspaceRoot);
  await context.initialize();
  const diagnostics = await context.getStartupDiagnostics();
  const hasStartupIssues = diagnostics.status !== 'ok';
  const diagnosticsReport = formatStartupDiagnosticsReport(diagnostics);
  const actionableDiagnosticsReport = formatActionableStartupDiagnosticsReport(diagnostics);

  if (command === 'web') {
    printStartupDiagnosticsIfNeeded(actionableDiagnosticsReport, hasStartupIssues);
    await runServe(context);
    return;
  }

  if (command === 'mcp') {
    printStartupDiagnosticsIfNeeded(actionableDiagnosticsReport, hasStartupIssues);
    await startMcpServer(context);
    logInfo('LocalLink MCP server running on stdio.', { workspaceRoot });
    return;
  }

  if (command === 'doctor') {
    process.stdout.write(diagnosticsReport);
    if (diagnostics.status === 'error') {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'snapshot') {
    const snapshot = await context.readState();
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return;
  }

  if (command === 'extensions') {
    const workspace = await context.getWorkspaceIdentity();
    const extensions = await context.readExtensionLifecycle();
    process.stdout.write(`${JSON.stringify({ workspace, extensions }, null, 2)}\n`);
    return;
  }

  throw new AppError(
    'UNKNOWN_COMMAND',
    `Unsupported command "${command}". Use "web", "mcp", "doctor", "snapshot", or "extensions".`,
    400,
  );
}

if (require.main === module) {
  void main().catch((error) => {
    const message = formatFatalError(error);
    if (getLoggerLevel() === 'silent') {
      process.stderr.write(`${message}\n`);
    } else {
      logError(message);
    }
    process.exit(1);
  });
}
