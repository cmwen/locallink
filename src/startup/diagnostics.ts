import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';

import type { DiagnosticCheck, StartupDiagnostics } from '../shared/contracts';
import { probeExternalTool, type ExternalToolKey } from '../shared/runtime-tools';
import { runCommand, type CommandRunner } from '../shared/utils';

interface PackageManifest {
  dependencies?: Record<string, string>;
}

interface StartupDiagnosticsOptions {
  workspaceRoot: string;
  appRoot: string;
  publicDir: string;
  commandRunner?: CommandRunner;
  moduleResolver?: (specifier: string) => string;
  fileExists?: (filePath: string) => Promise<boolean>;
}

async function defaultFileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function buildSummary(checks: DiagnosticCheck[]): StartupDiagnostics['summary'] {
  const errors = checks.filter((check) => check.status === 'error').length;
  const warnings = checks.filter((check) => check.status === 'warn').length;

  if (errors === 0 && warnings === 0) {
    return 'All startup checks passed.';
  }

  const parts: string[] = [];
  if (errors > 0) {
    parts.push(`${errors} blocking issue${errors === 1 ? '' : 's'}`);
  }
  if (warnings > 0) {
    parts.push(`${warnings} runtime warning${warnings === 1 ? '' : 's'}`);
  }

  return `${parts.join(', ')} detected. Open the startup checks panel for install guidance.`;
}

function buildStatus(checks: DiagnosticCheck[]): StartupDiagnostics['status'] {
  if (checks.some((check) => check.status === 'error')) {
    return 'error';
  }
  if (checks.some((check) => check.status === 'warn')) {
    return 'warn';
  }
  return 'ok';
}

export function formatStartupDiagnosticsReport(diagnostics: StartupDiagnostics): string {
  const lines = [`LocalLink doctor: ${diagnostics.summary}`];

  for (const check of diagnostics.checks) {
    const icon = check.status === 'ok' ? 'OK' : check.status === 'warn' ? 'WARN' : 'ERROR';
    lines.push(`- [${icon}] ${check.label}: ${check.summary}`);
    lines.push(`  ${check.detail}`);
  }

  return `${lines.join('\n')}\n`;
}

export function formatActionableStartupDiagnosticsReport(diagnostics: StartupDiagnostics): string {
  const actionableChecks = diagnostics.checks.filter((check) => check.status !== 'ok');
  if (actionableChecks.length === 0) {
    return '';
  }

  const lines = [`LocalLink startup checks: ${diagnostics.summary}`];
  for (const check of actionableChecks) {
    lines.push(`- ${check.label}: ${check.detail}`);
  }

  return `${lines.join('\n')}\n`;
}

export class StartupDiagnosticsService {
  private readonly commandRunner: CommandRunner;

  private readonly fileExists: (filePath: string) => Promise<boolean>;

  private readonly moduleResolver: (specifier: string) => string;

  constructor(private readonly options: StartupDiagnosticsOptions) {
    this.commandRunner = options.commandRunner ?? runCommand;
    this.fileExists = options.fileExists ?? defaultFileExists;
    if (options.moduleResolver) {
      this.moduleResolver = options.moduleResolver;
    } else {
      this.moduleResolver = (specifier: string) => {
        const parts = specifier.split('/');
        const packagePath = specifier.startsWith('@')
          ? path.join(options.appRoot, 'node_modules', parts[0], parts[1], 'package.json')
          : path.join(options.appRoot, 'node_modules', parts[0], 'package.json');
        if (!syncFs.existsSync(packagePath)) {
          throw new Error(`Missing dependency: ${specifier}`);
        }
        return packagePath;
      };
    }
  }

  private async loadPackageManifest(): Promise<PackageManifest> {
    const packageJsonPath = path.join(this.options.appRoot, 'package.json');
    const raw = await fs.readFile(packageJsonPath, 'utf8');
    return JSON.parse(raw) as PackageManifest;
  }

  private async checkNodeDependencies(): Promise<DiagnosticCheck> {
    const manifest = await this.loadPackageManifest();
    const missing = Object.keys(manifest.dependencies ?? {}).filter((dependency) => {
      try {
        this.moduleResolver(dependency);
        return false;
      } catch {
        return true;
      }
    });

    if (missing.length > 0) {
      return {
        id: 'node-dependencies',
        label: 'Node dependencies',
        status: 'error',
        summary: `${missing.length} runtime package${missing.length === 1 ? '' : 's'} missing.`,
        detail: `Run \`pnpm install\` in ${this.options.appRoot} to install the missing dependencies: ${missing.join(
          ', ',
        )}.`,
      };
    }

    return {
      id: 'node-dependencies',
      label: 'Node dependencies',
      status: 'ok',
      summary: 'Runtime packages are installed.',
      detail: 'The packaged LocalLink runtime dependencies resolved successfully.',
    };
  }

  private async checkPwaAssets(): Promise<DiagnosticCheck> {
    const manifestPath = path.join(this.options.publicDir, 'manifest.webmanifest');
    const serviceWorkerPath = path.join(this.options.publicDir, 'sw.js');
    const [manifestExists, serviceWorkerExists] = await Promise.all([
      this.fileExists(manifestPath),
      this.fileExists(serviceWorkerPath),
    ]);

    if (!manifestExists || !serviceWorkerExists) {
      const missing = [
        !manifestExists ? 'manifest.webmanifest' : null,
        !serviceWorkerExists ? 'sw.js' : null,
      ].filter(Boolean);

      return {
        id: 'pwa-assets',
        label: 'PWA shell',
        status: 'error',
        summary: 'Required PWA assets are missing.',
        detail: `Missing ${missing.join(' and ')} under ${this.options.publicDir}. Rebuild with \`pnpm build\` before starting the web app.`,
      };
    }

    return {
      id: 'pwa-assets',
      label: 'PWA shell',
      status: 'ok',
      summary: 'Manifest and service worker are present.',
      detail: `The installable shell is ready from ${this.options.publicDir}.`,
    };
  }

  private async checkExternalTool(key: ExternalToolKey): Promise<DiagnosticCheck> {
    const probe = await probeExternalTool(key, this.commandRunner);

    if (probe.status === 'missing') {
      return {
        id: key,
        label: probe.spec.label,
        status: 'warn',
        summary: `${probe.spec.label} is not installed.`,
        detail: probe.detail,
      };
    }

    if (probe.status === 'degraded') {
      return {
        id: key,
        label: probe.spec.label,
        status: 'warn',
        summary: `${probe.spec.label} needs attention.`,
        detail: probe.detail,
      };
    }

    return {
      id: key,
      label: probe.spec.label,
      status: 'ok',
      summary: `${probe.spec.label} is available.`,
      detail: probe.detail,
    };
  }

  async inspect(): Promise<StartupDiagnostics> {
    const checks = await Promise.all([
      this.checkNodeDependencies(),
      this.checkPwaAssets(),
      this.checkExternalTool('pm2'),
      this.checkExternalTool('docker'),
      this.checkExternalTool('task'),
    ]);

    return {
      status: buildStatus(checks),
      summary: buildSummary(checks),
      checks,
    };
  }
}
