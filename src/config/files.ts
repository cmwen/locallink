import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

import { parse, print, types } from 'recast';
import { YAMLMap, parseDocument } from 'yaml';

import {
  TARGET_FILES,
  type ComposePatch,
  type EcosystemPatch,
  type EnvPatch,
  type EnvPatchValue,
  type InfraConfigFileView,
  type InfraConfigView,
  type ProjectModel,
  type ServiceDefinition,
  type ServiceGroup,
  type TargetFile,
  type WorkspaceExtension,
  type WriteInfraConfigInput,
  type WriteInfraConfigResult,
} from '../shared/contracts';
import { AppError } from '../shared/errors';
import { logDebug } from '../shared/logger';
import { getInfraFilePath } from '../shared/paths';
import { normalizeTags, slugify, titleCaseFromKey } from '../shared/utils';

const { builders: b, namedTypes: n, visit } = types;

type BabelParse = (source: string, options?: any) => any;

let babelParsePromise: Promise<BabelParse> | undefined;

function loadBabelParse(): Promise<BabelParse> {
  babelParsePromise ??= import('@babel/parser').then(({ parse: babelParse }) => babelParse as BabelParse);
  return babelParsePromise;
}

type EnvLine = {
  raw: string;
  key?: string;
  prefix?: string;
  separator?: string;
  comment?: string;
};

const ENV_LINE_PATTERN = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*?)(\s+#.*)?$/;

function kindLabelForGroup(group: ServiceGroup): string {
  switch (group) {
    case 'docker':
      return 'Docker';
    case 'pwa':
      return 'PWA / Dev Server';
    case 'windows':
      return 'Windows exe';
    case 'pm2':
    default:
      return 'PM2';
  }
}

function defaultNotes(group: ServiceGroup, name: string): { notes: string; detail: string } {
  switch (group) {
    case 'docker':
      return {
        notes: `Docker service for ${name}.`,
        detail: 'Managed through docker-compose.yml and surfaced in the LocalLink runtime snapshot.',
      };
    case 'pwa':
      return {
        notes: `Dashboard-facing service for ${name}.`,
        detail: 'Managed through locallink.services.yml and surfaced as an installable local app surface.',
      };
    case 'windows':
      return {
        notes: `Host-side Windows executable for ${name}.`,
        detail: 'Detected under WSL using an allowlisted Windows process name from locallink.services.yml.',
      };
    case 'pm2':
    default:
      return {
        notes: `PM2 app for ${name}.`,
        detail: 'Managed through locallink.services.yml and surfaced in the LocalLink runtime snapshot.',
      };
  }
}

function formatEnvValue(value: string): string {
  return /[\s#"'`]/.test(value) ? JSON.stringify(value) : value;
}

function parseEnvLines(content: string): EnvLine[] {
  return content.split(/\r?\n/).map((raw) => {
    const match = ENV_LINE_PATTERN.exec(raw);
    if (!match) {
      return { raw };
    }

    return {
      raw,
      key: match[2],
      prefix: match[1],
      separator: match[3],
      comment: match[5] ?? '',
    };
  });
}

function parseEnvMap(content: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const line of content.split(/\r?\n/)) {
    const match = ENV_LINE_PATTERN.exec(line);
    if (!match) {
      continue;
    }

    let value = match[4].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[match[2]] = value;
  }

  return values;
}

function mergeRuntimeEnv(values: Record<string, string>): Record<string, string> {
  const runtimeOverrides = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  return {
    ...values,
    ...runtimeOverrides,
  };
}

function applyEnvPatch(content: string, patch: EnvPatch): string {
  const lines = parseEnvLines(content);
  const setEntries = Object.entries(patch.set ?? {});
  const unsetKeys = new Set(patch.unset ?? []);

  const handledKeys = new Set<string>();
  const nextLines = lines
    .map((line) => {
      if (!line.key) {
        return line.raw;
      }

      if (unsetKeys.has(line.key)) {
        handledKeys.add(line.key);
        return null;
      }

      const newValue = patch.set?.[line.key];
      if (newValue === undefined) {
        return line.raw;
      }

      handledKeys.add(line.key);
      return `${line.prefix ?? ''}${line.key}${line.separator ?? '='}${formatEnvValue(newValue)}${line.comment ?? ''}`;
    })
    .filter((line): line is string => line !== null);

  for (const [key, value] of setEntries) {
    if (!handledKeys.has(key)) {
      nextLines.push(`${key}=${formatEnvValue(value)}`);
    }
  }

  return nextLines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/u, '') + '\n';
}

function parseComposePort(serviceConfig: any, env: Record<string, string>, fallbackPort?: string): string {
  if (fallbackPort && env[fallbackPort]) {
    return env[fallbackPort];
  }

  const ports = Array.isArray(serviceConfig?.ports) ? serviceConfig.ports : [];
  const firstPort = ports[0];
  if (typeof firstPort === 'string') {
    const candidate = firstPort.split(':')[0]?.trim();
    const envMatch = candidate?.match(/^\$\{([^}]+)\}$/);
    if (envMatch) {
      return env[envMatch[1]] ?? '—';
    }
    return candidate || '—';
  }

  if (firstPort && typeof firstPort === 'object') {
    if (typeof firstPort.published === 'number') {
      return String(firstPort.published);
    }
    if (typeof firstPort.published === 'string') {
      return firstPort.published;
    }
  }

  return '—';
}

function normalizeLabels(labels: unknown): Record<string, string> {
  if (!labels) {
    return {};
  }

  if (Array.isArray(labels)) {
    return Object.fromEntries(
      labels
        .filter((label): label is string => typeof label === 'string')
        .map((label) => {
          const [key, ...rest] = label.split('=');
          return [key, rest.join('=')];
        }),
    );
  }

  if (typeof labels === 'object') {
    return Object.fromEntries(
      Object.entries(labels as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
    );
  }

  return {};
}

function normalizeMetadataList(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof input === 'string') {
    return input
      .split(/[,;|]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function resolveEnvValue(input: unknown, env: Record<string, string>): string {
  const value = String(input ?? '');
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, key: string, fallback = '') => env[key] || fallback);
}

function isConfiguredEnvValue(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  return !/(?:example\.com|example-tailnet|change[-_]?me|<[^>]+>)/i.test(value);
}

function extensionDefaultDetail(kind: WorkspaceExtension['kind']): string {
  switch (kind) {
    case 'dashboard': return 'LocalLink control surface for services, connections, and resources.';
    case 'reverse-proxy': return 'Routes stable private origins to local application ports.';
    case 'network-edge': return 'Publishes selected services privately to an authenticated tailnet.';
    case 'identity-provider': return 'Provides application-level OIDC sign-in after the network gate.';
    case 'observability': return 'Collects runtime telemetry for the workspace.';
    default: return 'Optional workspace capability declared through LocalLink.';
  }
}

function buildExtensionDefinitions(raw: string, env: Record<string, string>): WorkspaceExtension[] {
  if (!raw.trim()) return [];

  const parsed = parseDocument(raw).toJS() as { extensions?: unknown };
  const extensions = Array.isArray(parsed?.extensions) ? parsed.extensions : [];
  return extensions
    .filter((extension): extension is Record<string, unknown> => !!extension && typeof extension === 'object')
    .map((extension) => {
      const id = typeof extension.id === 'string' ? extension.id : slugify(String(extension.name || 'extension'));
      const kind = (typeof extension.kind === 'string' ? extension.kind : 'custom') as WorkspaceExtension['kind'];
      const enabled = extension.enabled !== false;
      const requiredEnv = normalizeMetadataList(extension.requiredEnv);
      const missingEnv = requiredEnv.filter((key) => !isConfiguredEnvValue(env[key]));
      return {
        id,
        name: typeof extension.name === 'string' ? extension.name : titleCaseFromKey(id),
        kind,
        enabled,
        detail: typeof extension.detail === 'string' ? extension.detail : extensionDefaultDetail(kind),
        status: !enabled ? 'disabled' : missingEnv.length > 0 ? 'setup' : 'ready',
        command: typeof extension.command === 'string' ? extension.command : undefined,
        exposedPorts: normalizeMetadataList(extension.exposedPorts).map((value) => resolveEnvValue(value, env)),
        requiredEnv,
        missingEnv,
        dependsOn: normalizeMetadataList(extension.dependsOn),
        docsUrl: typeof extension.docsUrl === 'string' ? extension.docsUrl : undefined,
      };
    });
}

function buildComposeDefinitions(raw: string, env: Record<string, string>): ServiceDefinition[] {
  if (!raw.trim()) {
    return [];
  }

  const document = parseDocument(raw);
  const parsed = document.toJS() as { services?: Record<string, any> };
  const services = parsed?.services ?? {};

  return Object.entries(services).map(([serviceName, serviceConfig]) => {
    const labels = normalizeLabels(serviceConfig?.labels);
    const group = (labels['locallink.group'] as ServiceGroup) || 'docker';
    const defaults = defaultNotes(group, titleCaseFromKey(serviceName));
    const portEnv = labels['locallink.portEnv'];
    const name = labels['locallink.name'] || titleCaseFromKey(serviceName);

    return {
      id: slugify(name),
      name,
      kind: kindLabelForGroup(group),
      group,
      runtime: (labels['locallink.runtime'] as ServiceDefinition['runtime']) || 'docker',
      runtimeName: serviceName,
      portEnv,
      port: parseComposePort(serviceConfig, env, portEnv),
      notes: labels['locallink.notes'] || defaults.notes,
      detail: labels['locallink.detail'] || defaults.detail,
      tags: normalizeTags(labels['locallink.tags'] || ['docker']).join(' · ') || 'docker',
      dependsOn: normalizeMetadataList(labels['locallink.dependsOn']),
      downstream: normalizeMetadataList(labels['locallink.downstream']),
      envVars: normalizeMetadataList(labels['locallink.envVars']),
      docsUrl: typeof labels['locallink.docsUrl'] === 'string' ? labels['locallink.docsUrl'] : undefined,
    };
  });
}

function runEcosystemModule(filePath: string, raw: string, env: Record<string, string>): any {
  const module = { exports: {} as any };
  const sandbox = {
    module,
    exports: module.exports,
    require: createRequire(filePath),
    process: { env: { ...process.env, ...env } },
    __dirname: path.dirname(filePath),
    __filename: filePath,
  };

  try {
    const context = vm.createContext(sandbox);
    const script = new vm.Script(raw, { filename: filePath });
    script.runInContext(context, { timeout: 250 });
  } catch (error) {
    const message =
      error && typeof error === 'object' && 'message' in error
        ? String((error as { message?: unknown }).message)
        : String(error);
    throw new AppError(
      'INVALID_ECOSYSTEM_CONFIG',
      `LocalLink could not load ${filePath}: ${message}`,
      400,
      { filePath },
    );
  }

  const exported = sandbox.module.exports ?? sandbox.exports;
  if (!exported || typeof exported !== 'object') {
    throw new AppError(
      'INVALID_ECOSYSTEM_CONFIG',
      'ecosystem.config.js must export an object with an apps array.',
      400,
    );
  }

  return exported;
}

function buildEcosystemDefinitions(
  filePath: string,
  raw: string,
  env: Record<string, string>,
): ServiceDefinition[] {
  if (!raw.trim()) {
    return [];
  }

  const ecosystem = runEcosystemModule(filePath, raw, env);
  const apps = Array.isArray(ecosystem.apps) ? ecosystem.apps : [];

  return apps.map((app: any) => {
    const metadata = app.locallink && typeof app.locallink === 'object' ? app.locallink : {};
    const group = (metadata.group as ServiceGroup) || 'pm2';
    const displayName = typeof metadata.name === 'string' ? metadata.name : app.name;
    const defaults = defaultNotes(group, displayName);
    const resolvedCwd = typeof app.cwd === 'string' ? path.resolve(path.dirname(filePath), app.cwd) : path.dirname(filePath);
    const portEnv = typeof metadata.portEnv === 'string' ? metadata.portEnv : undefined;
    const runtime =
      (metadata.runtime as ServiceDefinition['runtime']) || (group === 'windows' ? 'taskfile' : 'pm2');
    const taskName = typeof metadata.taskName === 'string' ? metadata.taskName : undefined;
    const runtimeName =
      typeof metadata.runtimeName === 'string'
        ? metadata.runtimeName
        : runtime === 'taskfile'
          ? taskName || (typeof app.name === 'string' ? app.name : undefined)
          : typeof app.name === 'string'
            ? app.name
            : undefined;
    const resolvedPort =
      metadata.port ??
      (portEnv ? env[portEnv] : undefined) ??
      app.env?.PORT ??
      app.env?.LOCALLINK_WEB_PORT ??
      app.env?.LOCALLINK_MCP_PORT;

    return {
      id: slugify(displayName),
      name: displayName,
      kind: typeof metadata.kind === 'string' ? metadata.kind : kindLabelForGroup(group),
      group,
      definitionSource: 'ecosystem',
      runtime,
      runtimeName,
      taskName,
      cwd: resolvedCwd,
      script: typeof app.script === 'string' ? app.script : undefined,
      args: typeof app.args === 'string' || Array.isArray(app.args) ? app.args : undefined,
      dockerfilePath:
        typeof metadata.dockerfile === 'string'
          ? path.resolve(resolvedCwd, metadata.dockerfile)
          : runtime === 'pm2'
            ? resolveDefaultDockerfileBlueprint(resolvedCwd)
            : undefined,
      windowsProcessName:
        typeof metadata.windowsProcessName === 'string' ? metadata.windowsProcessName : undefined,
      portEnv,
      port: resolvedPort ? String(resolvedPort) : '—',
      notes: typeof metadata.notes === 'string' ? metadata.notes : defaults.notes,
      detail: typeof metadata.detail === 'string' ? metadata.detail : defaults.detail,
      tags: normalizeTags(metadata.tags || [group]).join(' · ') || group,
      dependsOn: normalizeMetadataList(metadata.dependsOn),
      downstream: normalizeMetadataList(metadata.downstream),
      envVars: normalizeMetadataList(metadata.envVars),
      docsUrl: typeof metadata.docsUrl === 'string' ? metadata.docsUrl : undefined,
    };
  });
}

function resolveDefaultDockerfileBlueprint(cwd: string): string {
  const candidates = [
    path.join(cwd, 'Dockerfile.locallink'),
    path.join(cwd, '.locallink', 'Dockerfile'),
    path.join(cwd, 'Dockerfile'),
  ];

  return candidates.find((candidate) => fsSync.existsSync(candidate)) ?? candidates[candidates.length - 1];
}

function buildServiceRegistryDefinitions(
  filePath: string,
  raw: string,
  env: Record<string, string>,
): ServiceDefinition[] {
  if (!raw.trim()) {
    return [];
  }

  const document = parseDocument(raw);
  const parsed = document.toJS() as { services?: unknown };
  const services = Array.isArray(parsed?.services) ? parsed.services : [];
  const baseDir = path.dirname(filePath);

  return services
    .filter((service): service is Record<string, unknown> => !!service && typeof service === 'object')
    .map((service) => {
      const displayName = typeof service.name === 'string' ? service.name : 'Unnamed Service';
      const group = (service.group as ServiceGroup) || 'pm2';
      const runtime =
        (service.runtime as ServiceDefinition['runtime']) || (group === 'windows' ? 'taskfile' : 'pm2');
      const taskName = typeof service.taskName === 'string' ? service.taskName : undefined;
      const runtimeName =
        typeof service.runtimeName === 'string'
          ? service.runtimeName
          : runtime === 'taskfile'
            ? taskName || displayName
            : slugify(displayName);
      const resolvedCwd = typeof service.cwd === 'string' ? path.resolve(baseDir, service.cwd) : baseDir;
      const portEnv = typeof service.portEnv === 'string' ? service.portEnv : undefined;
      const blueprint =
        typeof service.blueprint === 'string'
          ? service.blueprint
          : typeof service.dockerfile === 'string'
            ? service.dockerfile
            : undefined;
      const defaults = defaultNotes(group, displayName);

      return {
        id: slugify(displayName),
        name: displayName,
        kind: typeof service.kind === 'string' ? service.kind : kindLabelForGroup(group),
        group,
        definitionSource: 'services',
        runtime,
        runtimeName,
        taskName,
        cwd: resolvedCwd,
        script: typeof service.script === 'string' ? service.script : undefined,
        args:
          typeof service.args === 'string' || Array.isArray(service.args)
            ? (service.args as string | string[])
            : undefined,
        dockerfilePath: blueprint
          ? path.resolve(resolvedCwd, blueprint)
          : runtime === 'pm2'
            ? resolveDefaultDockerfileBlueprint(resolvedCwd)
            : undefined,
        windowsProcessName:
          typeof service.windowsProcessName === 'string' ? service.windowsProcessName : undefined,
        portEnv,
        port: service.port !== undefined ? String(service.port) : portEnv ? env[portEnv] || '—' : '—',
        notes: typeof service.notes === 'string' ? service.notes : defaults.notes,
        detail: typeof service.detail === 'string' ? service.detail : defaults.detail,
        tags: normalizeTags(service.tags || [group]).join(' · ') || group,
        dependsOn: normalizeMetadataList(service.dependsOn),
        downstream: normalizeMetadataList(service.downstream),
        envVars: normalizeMetadataList(service.envVars),
        docsUrl: typeof service.docsUrl === 'string' ? service.docsUrl : undefined,
      };
    });
}

function ensureComposeDocument(content: string) {
  return parseDocument(content.trim() ? content : 'services: {}\n');
}

function applyComposePatch(content: string, patch: ComposePatch): string {
  const document = ensureComposeDocument(content);
  let servicesNode = document.get('services', true) as YAMLMap<unknown, unknown> | undefined;

  if (!servicesNode || !(servicesNode instanceof YAMLMap)) {
    servicesNode = document.createNode({}) as YAMLMap<unknown, unknown>;
    document.set('services', servicesNode);
  }

  let serviceNode = servicesNode.get(patch.serviceName, true) as YAMLMap<unknown, unknown> | undefined;
  if (!serviceNode || !(serviceNode instanceof YAMLMap)) {
    serviceNode = document.createNode({}) as YAMLMap<unknown, unknown>;
    servicesNode.set(patch.serviceName, serviceNode);
  }

  const updates = patch.updates;
  if (updates.image) {
    serviceNode.set('image', updates.image);
  }
  if (updates.restart) {
    serviceNode.set('restart', updates.restart);
  }
  if (updates.ports) {
    serviceNode.set('ports', document.createNode(updates.ports));
  }
  if (updates.environment) {
    serviceNode.set('environment', document.createNode(updates.environment));
  }
  if (updates.labels) {
    const existingLabels = normalizeLabels(serviceNode.get('labels') as unknown);
    serviceNode.set('labels', document.createNode({ ...existingLabels, ...updates.labels }));
  }

  return String(document);
}

function propertyKeyEquals(property: any, key: string): boolean {
  if (n.Identifier.check(property.key)) {
    return property.key.name === key;
  }
  if (n.StringLiteral.check(property.key)) {
    return property.key.value === key;
  }
  return false;
}

function getObjectProperty(objectExpression: any, key: string) {
  return objectExpression.properties.find(
    (property: any) => n.ObjectProperty.check(property) && propertyKeyEquals(property, key),
  );
}

function upsertObjectProperty(objectExpression: any, key: string, value: any): void {
  const property = getObjectProperty(objectExpression, key);
  if (property) {
    property.value = value;
    return;
  }

  objectExpression.properties.push(b.objectProperty(b.identifier(key), value));
}

function removeObjectProperty(objectExpression: any, key: string): void {
  objectExpression.properties = objectExpression.properties.filter(
    (property: any) => !(n.ObjectProperty.check(property) && propertyKeyEquals(property, key)),
  );
}

function toExpression(value: unknown): any {
  if (value === null) {
    return b.nullLiteral();
  }
  if (typeof value === 'string') {
    return b.stringLiteral(value);
  }
  if (typeof value === 'number') {
    return b.numericLiteral(value);
  }
  if (typeof value === 'boolean') {
    return b.booleanLiteral(value);
  }
  if (Array.isArray(value)) {
    return b.arrayExpression(value.map((item) => toExpression(item)));
  }
  if (typeof value === 'object' && value) {
    return b.objectExpression(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) =>
        b.objectProperty(b.identifier(key), toExpression(entry)),
      ),
    );
  }

  return b.stringLiteral(String(value));
}

function toEnvExpression(value: EnvPatchValue): any {
  if (value === null) {
    return null;
  }
  if (typeof value === 'object' && 'sourceEnv' in value) {
    return b.memberExpression(
      b.memberExpression(b.identifier('process'), b.identifier('env')),
      b.identifier(value.sourceEnv),
    );
  }

  return b.stringLiteral(String(value));
}

function findModuleExportsObject(ast: any): any {
  let result: any;

  visit(ast, {
    visitAssignmentExpression(path) {
      const { node } = path;
      if (
        n.MemberExpression.check(node.left) &&
        n.Identifier.check(node.left.object) &&
        node.left.object.name === 'module' &&
        n.Identifier.check(node.left.property) &&
        node.left.property.name === 'exports' &&
        n.ObjectExpression.check(node.right)
      ) {
        result = node.right;
        return false;
      }

      this.traverse(path);
      return undefined;
    },
  });

  if (!result) {
    throw new AppError(
      'INVALID_ECOSYSTEM_CONFIG',
      'ecosystem.config.js must use module.exports = { apps: [...] } for MVP patch support.',
      400,
    );
  }

  return result;
}

function ensureAppsArray(rootObject: any): any {
  const property = getObjectProperty(rootObject, 'apps');
  if (property && n.ArrayExpression.check(property.value)) {
    return property.value;
  }

  const arrayExpression = b.arrayExpression([]);
  upsertObjectProperty(rootObject, 'apps', arrayExpression);
  return arrayExpression;
}

function findOrCreateAppObject(appsArray: any, appName: string): any {
  const existing = appsArray.elements.find((element: any) => {
    if (!n.ObjectExpression.check(element)) {
      return false;
    }
    const nameProperty = getObjectProperty(element, 'name');
    const locallinkProperty = getObjectProperty(element, 'locallink');
    const locallinkObject =
      locallinkProperty && n.ObjectExpression.check(locallinkProperty.value) ? locallinkProperty.value : undefined;
    const displayNameProperty = locallinkObject ? getObjectProperty(locallinkObject, 'name') : undefined;

    return (
      (!!nameProperty && n.StringLiteral.check(nameProperty.value) && nameProperty.value.value === appName) ||
      (!!displayNameProperty &&
        n.StringLiteral.check(displayNameProperty.value) &&
        displayNameProperty.value.value === appName)
    );
  });

  if (existing) {
    return existing;
  }

  const created = b.objectExpression([b.objectProperty(b.identifier('name'), b.stringLiteral(appName))]);
  appsArray.elements.push(created);
  return created;
}

function ensureNestedObjectProperty(parent: any, key: string): any {
  const property = getObjectProperty(parent, key);
  if (property && n.ObjectExpression.check(property.value)) {
    return property.value;
  }

  const objectExpression = b.objectExpression([]);
  upsertObjectProperty(parent, key, objectExpression);
  return objectExpression;
}

async function applyEcosystemPatch(content: string, patch: EcosystemPatch): Promise<string> {
  const source = content.trim() ? content : 'module.exports = { apps: [] };\n';
  const babelParse = await loadBabelParse();
  const ast = parse(source, {
    parser: {
      parse(value: string) {
        return babelParse(value, { sourceType: 'script', plugins: [] });
      },
    },
  });
  const rootObject = findModuleExportsObject(ast);
  const appsArray = ensureAppsArray(rootObject);
  const appObject = findOrCreateAppObject(appsArray, patch.appName);

  const updates = patch.updates;
  if (updates.script) {
    upsertObjectProperty(appObject, 'script', b.stringLiteral(updates.script));
  }
  if (updates.cwd) {
    upsertObjectProperty(appObject, 'cwd', b.stringLiteral(updates.cwd));
  }
  if (updates.args !== undefined) {
    upsertObjectProperty(appObject, 'args', toExpression(updates.args));
  }
  if (updates.env) {
    const envObject = ensureNestedObjectProperty(appObject, 'env');
    for (const [key, value] of Object.entries(updates.env)) {
      if (value === null) {
        removeObjectProperty(envObject, key);
        continue;
      }

      upsertObjectProperty(envObject, key, toEnvExpression(value));
    }
  }
  if (updates.locallink) {
    const locallinkObject = ensureNestedObjectProperty(appObject, 'locallink');
    for (const [key, value] of Object.entries(updates.locallink)) {
      upsertObjectProperty(locallinkObject, key, toExpression(value));
    }
  }

  return print(ast).code;
}

async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function initialContentForTarget(targetFile: TargetFile): string {
  switch (targetFile) {
    case '.env':
    case '.env.example':
      return '';
    case 'docker-compose.yml':
      return 'services: {}\n';
    case 'locallink.services.yml':
      return 'services: []\n';
    case 'locallink.extensions.yml':
      return 'extensions: []\n';
    case 'ecosystem.config.js':
      return 'module.exports = {\n  apps: [],\n};\n';
    case 'mcp-registry.json':
      return '{\n  "servers": [],\n  "volumes": []\n}\n';
    default:
      return '';
  }
}

export class ConfigRepository {
  constructor(private readonly root: string) {}

  getFilePath(targetFile: TargetFile): string {
    return getInfraFilePath(this.root, targetFile);
  }

  async hydrateProcessEnv(): Promise<void> {
    const envContent = await readFileOrEmpty(this.getFilePath('.env'));
    for (const [key, value] of Object.entries(parseEnvMap(envContent))) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }

  async loadProjectModel(): Promise<ProjectModel> {
    const envContent = await readFileOrEmpty(this.getFilePath('.env'));
    const env = mergeRuntimeEnv(parseEnvMap(envContent));
    const composeContent = await readFileOrEmpty(this.getFilePath('docker-compose.yml'));
    const servicesContent = await readFileOrEmpty(this.getFilePath('locallink.services.yml'));
    const extensionsContent = await readFileOrEmpty(this.getFilePath('locallink.extensions.yml'));
    const ecosystemPath = this.getFilePath('ecosystem.config.js');
    const ecosystemContent = await readFileOrEmpty(ecosystemPath);
    const serviceDefinitions = buildServiceRegistryDefinitions(
      this.getFilePath('locallink.services.yml'),
      servicesContent,
      env,
    );
    const ecosystemDefinitions = buildEcosystemDefinitions(ecosystemPath, ecosystemContent, env);
    const composeDefinitions = buildComposeDefinitions(composeContent, env);
    const extensions = buildExtensionDefinitions(extensionsContent, env);

    logDebug('Loaded workspace model.', {
      root: this.root,
      envCount: Object.keys(env).length,
      serviceRegistryServices: serviceDefinitions.length,
      ecosystemServices: ecosystemDefinitions.length,
      composeServices: composeDefinitions.length,
      extensions: extensions.length,
      totalServices: ecosystemDefinitions.length + composeDefinitions.length,
    });

    return {
      env,
      definitions: [...serviceDefinitions, ...ecosystemDefinitions, ...composeDefinitions],
      extensions,
    };
  }

  async readInfraConfig(): Promise<InfraConfigView> {
    const files = await Promise.all(
      TARGET_FILES.map(async (targetFile): Promise<InfraConfigFileView> => {
        const filePath = this.getFilePath(targetFile);
        const content = await readFileOrEmpty(filePath);
        return {
          targetFile,
          path: filePath,
          exists: await fileExists(filePath),
          content,
        };
      }),
    );

    const model = await this.loadProjectModel();
    return {
      root: this.root,
      files,
      services: model.definitions,
    };
  }

  async writeInfraConfig(input: WriteInfraConfigInput): Promise<WriteInfraConfigResult> {
    const filePath = this.getFilePath(input.targetFile);
    const currentContent = await readFileOrEmpty(filePath);
    const existingContent = currentContent || initialContentForTarget(input.targetFile);

    if (!input.content && !input.patch) {
      throw new AppError(
        'INVALID_WRITE_REQUEST',
        'write_infra_config requires either content or patch.',
        400,
      );
    }

    let nextContent = input.content ?? existingContent;
    if (input.patch) {
      switch (input.patch.kind) {
        case 'env':
          nextContent = applyEnvPatch(existingContent, input.patch);
          break;
        case 'compose':
          nextContent = applyComposePatch(existingContent, input.patch);
          break;
        case 'ecosystem':
          nextContent = await applyEcosystemPatch(existingContent, input.patch);
          break;
        default:
          throw new AppError('UNSUPPORTED_PATCH', `Unsupported patch kind.`, 400);
      }
    }

    await fs.writeFile(filePath, nextContent, 'utf8');
    return {
      targetFile: input.targetFile,
      path: filePath,
      content: nextContent,
    };
  }
}
