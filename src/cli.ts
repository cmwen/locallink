#!/usr/bin/env node

import path from 'node:path';

import type { FastifyInstance } from 'fastify';

import {
  installBundledAgentSkill,
  type AgentSkillTarget,
} from './agents/skill-installer';
import { AppContext } from './app-context';
import { initializeWorkspace } from './init/scaffold';
import { startMcpServer } from './mcp/server';
import { formatWorkspaceOnboardingReport } from './onboarding/report';
import { parseCliOptions } from './shared/cli-options';
import { AppError, formatFatalError } from './shared/errors';
import { configureLogger, getLoggerLevel, logError, logInfo } from './shared/logger';
import { resolvePaths, resolveProjectRoot } from './shared/paths';
import {
  formatActionableStartupDiagnosticsReport,
  formatStartupDiagnosticsReport,
} from './startup/diagnostics';

async function runServe(context: AppContext): Promise<FastifyInstance> {
  const server = context.createServer();
  const binding = await context.getBinding();
  let runtime: Awaited<ReturnType<AppContext['recordRuntimeBinding']>> | undefined;
  let shuttingDown = false;
  const removeSignalHandlers = () => {
    process.removeListener('SIGINT', handleSigint);
    process.removeListener('SIGTERM', handleSigterm);
  };
  const shutdown = (signal: 'SIGINT' | 'SIGTERM') => {
    if (shuttingDown) return;
    shuttingDown = true;
    logInfo('LocalLink dashboard shutdown requested.', {
      workspaceRoot: context.paths.root,
      signal,
    });
    void server.close().catch((error) => {
      logError('LocalLink dashboard shutdown failed.', {
        workspaceRoot: context.paths.root,
        signal,
        error: formatFatalError(error),
      });
      process.exitCode = 1;
    });
  };
  const handleSigint = () => shutdown('SIGINT');
  const handleSigterm = () => shutdown('SIGTERM');
  server.addHook('onClose', async () => {
    removeSignalHandlers();
    context.stopAutomaticExtensionReload();
    await context.stopLocalDiscovery();
    if (runtime) await context.clearRuntimeBinding(runtime.pid);
  });
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
  try {
    runtime = await context.recordRuntimeBinding(binding);
  } catch (error) {
    await server.close();
    throw error;
  }
  process.once('SIGINT', handleSigint);
  process.once('SIGTERM', handleSigterm);
  context.logs.append(`Dashboard server for ${runtime.id} listening on ${runtime.url}.`, 'Runtime');
  logInfo('LocalLink dashboard server started.', {
    workspaceId: runtime.id,
    workspaceRoot: runtime.root,
    url: runtime.url,
    automaticPort: runtime.automatic,
  });
  context.startAutomaticExtensionReload();
  await context.startLocalDiscovery();
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
    case 'extension':
    case 'oidc':
    case 'doctor':
    case 'onboard':
    case 'init':
    case 'skill':
    case 'service':
    case 'access':
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
      '  locallink [--log-level LEVEL] onboard   Print automatic and manual foundation onboarding steps',
      '  locallink [--log-level LEVEL] snapshot  Print the current dashboard state as JSON',
      '  locallink [--log-level LEVEL] extensions Print declared, installed, manual, and healthy extension states',
      '  locallink [--log-level LEVEL] extensions reload [SERVICE...] Alias for reloading the selected Private Edge services',
      '  locallink [--log-level LEVEL] service contract SERVICE Print a secret-free application integration contract',
      '  locallink [--log-level LEVEL] service access SERVICE   Plan Tailscale, custom-domain, and LAN mDNS profiles',
      '  locallink [--log-level LEVEL] access apply             Apply all ready Caddy-backed access profiles',
      '  locallink [--log-level LEVEL] oidc check SERVICE Print canonical OIDC issuer, public callback, and proxy guidance',
      '  locallink [--log-level LEVEL] extension plan private-edge [SERVICE...]  Preview changes and select services',
      '  locallink [--log-level LEVEL] extension apply private-edge [SERVICE...] Apply workspace declarations and selection',
      '  locallink [--log-level LEVEL] extension plan identity  Preview Pocket ID installation and manual checkpoints',
      '  locallink [--log-level LEVEL] extension apply identity Install/configure Pocket ID and select its Private Edge route',
      '  locallink [--log-level LEVEL] extension plan observability Preview OpenObserve, collector, credentials, storage, and edge publishing',
      '  locallink [--log-level LEVEL] extension apply observability Install/adopt OpenObserve and its workspace OTLP collector safely',
      '  locallink [--log-level LEVEL] extension reload private-edge [SERVICE...] Refresh the selected edge services and reload Caddy/Tailscale',
      '  locallink [--log-level LEVEL] extension apply-routes private-edge TOKEN Apply a freshly confirmed host route plan',
      '  locallink [--log-level LEVEL] extension reconcile-routes private-edge TOKEN Remove stale owned routes safely',
      '  locallink skill inject [--force] Inject the LocalLink agent skill into this workspace',
      '  locallink skill install [--target codex|agents|workspace] [--force] Install or update the skill at an explicit target',
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
      '  --target TARGET        skill install destination: codex (default), agents, or workspace',
      '                          skill inject always uses the current workspace',
      '  --force                Back up and replace an unowned skill at the selected destination',
      '',
    ].join('\n'),
  );
}

function parseAgentSkillTarget(value: string | undefined): AgentSkillTarget {
  if (!value) return 'codex';
  if (value === 'codex' || value === 'agents' || value === 'workspace') return value;
  throw new AppError(
    'INVALID_SKILL_TARGET',
    `Unsupported agent skill target "${value}". Use one of: codex, agents, workspace.`,
    400,
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

  if (command === 'skill') {
    const action = options.positionals[1];
    if ((action !== 'inject' && action !== 'install') || options.positionals.length > 2) {
      throw new AppError(
        'INVALID_SKILL_COMMAND',
        'Use "locallink skill inject [--force]" or "locallink skill install [--target codex|agents|workspace] [--force]".',
        400,
      );
    }
    if (action === 'inject' && options.target && options.target !== 'workspace') {
      throw new AppError(
        'INVALID_SKILL_TARGET',
        '"locallink skill inject" always targets the current workspace. Remove --target or use --target workspace.',
        400,
      );
    }
    const paths = resolvePaths(workspaceRoot);
    const result = await installBundledAgentSkill({
      appRoot: paths.appRoot,
      workspaceRoot,
      target: action === 'inject' ? 'workspace' : parseAgentSkillTarget(options.target),
      force: options.force,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (options.target || options.force) {
    throw new AppError(
      'MISPLACED_SKILL_OPTION',
      '--target and --force are supported only by "locallink skill inject" and "locallink skill install".',
      400,
    );
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
    process.stdout.write('\n');
    process.stdout.write(formatWorkspaceOnboardingReport(await context.readOnboardingReport()));
    if (diagnostics.status === 'error') {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'onboard') {
    process.stdout.write(formatWorkspaceOnboardingReport(await context.readOnboardingReport()));
    return;
  }

  if (command === 'snapshot') {
    const snapshot = await context.readState();
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return;
  }

  if (command === 'extensions') {
    if (options.positionals[1] === 'reload') {
      const services = options.positionals.slice(2);
      const result = await context.reloadExtension('private-edge', services.length > 0 ? services : undefined);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    const workspace = await context.getWorkspaceIdentity();
    const extensions = await context.readExtensionLifecycle();
    process.stdout.write(`${JSON.stringify({ workspace, extensions }, null, 2)}\n`);
    return;
  }

  if (command === 'service') {
    const action = options.positionals[1];
    const selector = options.positionals[2];
    if ((action !== 'contract' && action !== 'access') || !selector || options.positionals.length > 3) {
      throw new AppError(
        'INVALID_SERVICE_COMMAND',
        'Use "locallink service contract SERVICE" or "locallink service access SERVICE".',
        400,
      );
    }
    const contract = action === 'access'
      ? await context.readAccessProfilePlan(selector)
      : await context.readApplicationContract(selector);
    process.stdout.write(`${JSON.stringify(contract, null, 2)}\n`);
    return;
  }

  if (command === 'oidc') {
    const action = options.positionals[1];
    const selector = options.positionals[2];
    if (action !== 'check' || !selector || options.positionals.length > 3) {
      throw new AppError('INVALID_OIDC_COMMAND', 'Use "locallink oidc check SERVICE".', 400);
    }
    const check = await context.readOidcCheck(selector);
    process.stdout.write(`${JSON.stringify(check, null, 2)}\n`);
    return;
  }

  if (command === 'access') {
    if (options.positionals[1] !== 'apply' || options.positionals.length > 2) {
      throw new AppError('INVALID_ACCESS_COMMAND', 'Use "locallink access apply".', 400);
    }
    process.stdout.write(`${JSON.stringify(await context.applyAccessProfileCaddy(), null, 2)}\n`);
    return;
  }

  if (command === 'extension') {
    const action = options.positionals[1];
    const capability = options.positionals[2];
    const serviceArgs = options.positionals.slice(3);
    const services = serviceArgs.length > 0 ? serviceArgs : undefined;
    if (!capability || (action !== 'plan' && action !== 'apply' && action !== 'reload' && action !== 'apply-routes' && action !== 'reconcile-routes')) {
      throw new AppError(
        'INVALID_EXTENSION_COMMAND',
        'Use "locallink extension plan|apply|reload private-edge [SERVICE...]", "locallink extension plan|apply identity", "locallink extension plan|apply observability", "locallink extension apply-routes private-edge TOKEN", or "locallink extension reconcile-routes private-edge TOKEN".',
        400,
      );
    }
    if (action === 'reload') {
      if (capability !== 'private-edge') {
        throw new AppError('INVALID_EXTENSION_COMMAND', 'Extension reload currently supports only private-edge.', 400);
      }
      const result = await context.reloadExtension(capability, services);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    if (action === 'apply-routes') {
      const confirmationToken = options.positionals[3];
      if (!confirmationToken) {
        throw new AppError('MISSING_ROUTE_CONFIRMATION', 'apply-routes requires the confirmation token from a fresh Private Edge plan.', 400);
      }
      const result = await context.applyExtensionRoutes(capability, confirmationToken);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    if (action === 'reconcile-routes') {
      const confirmationToken = options.positionals[3];
      if (!confirmationToken) {
        throw new AppError('MISSING_RECONCILIATION_CONFIRMATION', 'reconcile-routes requires the confirmation token from a fresh Private Edge plan.', 400);
      }
      const result = await context.reconcileExtensionRoutes(capability, confirmationToken);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    const result = action === 'plan'
      ? await context.planExtension(capability, services)
      : await context.applyExtension(capability, services);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  throw new AppError(
    'UNKNOWN_COMMAND',
    `Unsupported command "${command}". Use "web", "mcp", "doctor", "onboard", "snapshot", "extensions", "extension", "service", "oidc", "skill", or "init".`,
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
