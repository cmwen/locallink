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

async function runServe(context: AppContext, surface: 'api' | 'dashboard'): Promise<FastifyInstance> {
  const dashboardEnabled = surface === 'dashboard';
  const server = context.createServer({ dashboardEnabled });
  const binding = await context.getBinding(surface);
  try {
    await server.listen({
      host: binding.host,
      port: binding.port,
    });
  } catch (error) {
    throw new AppError(
      'WEB_SERVER_START_FAILED',
      `LocalLink could not start the ${dashboardEnabled ? 'dashboard' : 'API'} on http://${binding.host}:${binding.port}: ${formatFatalError(
        error,
      )}. Check LOCALLINK_BIND_HOST and the configured LocalLink port in the workspace .env, or stop the process using that port.`,
      500,
    );
  }
  context.logs.append(
    `${dashboardEnabled ? 'Dashboard' : 'Headless API'} server listening on http://${binding.host}:${binding.port}.`,
    'Runtime',
  );
  return server;
}

function normalizeCommand(rawCommand: string | undefined): string {
  switch (rawCommand) {
    case undefined:
    case '':
    case 'api':
      return 'api';
    case 'dashboard':
    case 'start':
    case 'serve':
    case 'web':
      return 'dashboard';
    case 'mcp':
    case 'snapshot':
    case 'doctor':
    case 'init':
    case 'up':
    case 'down':
    case 'status':
    case 'ai':
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
      '  locallink [--log-level LEVEL] api       Start the headless local API control plane',
      '  locallink [--log-level LEVEL] dashboard Start the optional local dashboard UI + API',
      '  locallink [--log-level LEVEL] up        Start the configured workspace services',
      '  locallink [--log-level LEVEL] down      Stop workspace services started by LocalLink',
      '  locallink [--log-level LEVEL] status    Print assigned ports and service counts',
      '  locallink [--log-level LEVEL] ai        Print machine-readable CLI guidance for agents',
      '  locallink [--log-level LEVEL] mcp       Start the MCP stdio server',
      '  locallink [--log-level LEVEL] doctor    Print startup diagnostics and install guidance',
      '  locallink [--log-level LEVEL] snapshot  Print the current dashboard state as JSON',
      '  locallink [--log-level LEVEL] init      Scaffold a starter LocalLink workspace here',
      '  locallink [--log-level LEVEL] init NAME Scaffold a starter LocalLink workspace in ./NAME',
      '',
      'Aliases:',
      '  locallink web       Alias for dashboard',
      '  locallink serve     Alias for dashboard',
      '  locallink start     Alias for dashboard',
      '',
      'Options:',
      '  -l, --log-level LEVEL  One of: silent, error, warn, info, debug',
      '                          Defaults to info. Can also be set via LOCALLINK_LOG_LEVEL.',
      '  -w, --workspace PATH   Run against a specific LocalLink system workspace.',
      '                          Defaults to LOCALLINK_WORKSPACE or the current directory.',
      '  --json                 Prefer machine-readable JSON output for supported commands.',
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
  configureLogger(options.logLevel, options.json ? 'silent' : 'info');
  const command = normalizeCommand(options.positionals[0]);
  const workspaceRoot = resolveProjectRoot(options.workspaceRoot);
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

  if (command === 'api' || command === 'dashboard') {
    printStartupDiagnosticsIfNeeded(actionableDiagnosticsReport, hasStartupIssues);
    await runServe(context, command);
    return;
  }

  if (command === 'up' || command === 'down') {
    printStartupDiagnosticsIfNeeded(actionableDiagnosticsReport, hasStartupIssues);
    const result = await context.executeWorkspaceLifecycle(command);
    process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatWorkspaceLifecycleResult(result));
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'status') {
    const status = await context.readWorkspaceStatus();
    process.stdout.write(options.json ? `${JSON.stringify(status, null, 2)}\n` : formatWorkspaceStatus(status));
    return;
  }

  if (command === 'ai') {
    const manifest = await context.readAiManifest();
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }

  if (command === 'mcp') {
    printStartupDiagnosticsIfNeeded(actionableDiagnosticsReport, hasStartupIssues);
    await startMcpServer(context);
    logInfo('LocalLink MCP server running on stdio.', { workspaceRoot });
    return;
  }

  if (command === 'doctor') {
    process.stdout.write(options.json ? `${JSON.stringify(diagnostics, null, 2)}\n` : diagnosticsReport);
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

  throw new AppError(
    'UNKNOWN_COMMAND',
    `Unsupported command "${command}". Use "api", "dashboard", "up", "down", "status", "ai", "mcp", "doctor", or "snapshot".`,
    400,
  );
}

function formatWorkspaceLifecycleResult(result: Awaited<ReturnType<AppContext['executeWorkspaceLifecycle']>>): string {
  const lines = [
    `Workspace ${result.action} ${result.ok ? 'completed' : 'completed with failures'}: ${result.workspaceRoot}`,
    ...result.steps.map((step) => {
      const prefix = step.skipped ? 'SKIP' : step.ok ? 'OK' : 'FAIL';
      const command = step.command ? ` (${step.command})` : '';
      return `- ${prefix} ${step.name}: ${step.detail}${command}`;
    }),
  ];
  return `${lines.join('\n')}\n`;
}

function formatWorkspaceStatus(status: Awaited<ReturnType<AppContext['readWorkspaceStatus']>>): string {
  return [
    `Workspace: ${status.workspaceRoot}`,
    `System: ${status.systemId}`,
    status.api?.url ? `API: ${status.api.url}` : 'API: not assigned',
    status.dashboard?.url ? `Dashboard: ${status.dashboard.url}` : 'Dashboard: not assigned',
    `Services: ${status.services.running} running, ${status.services.stopped} stopped, ${status.services.unknown} unknown, ${status.services.total} total`,
    `Next free port: ${status.ports.nextFree}`,
    '',
  ].join('\n');
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
