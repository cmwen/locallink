import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { parseDocument } from 'yaml';

import { parseJsonOutput, type CommandRunner } from '../shared/utils';

type ComposeService = {
  image?: unknown;
  labels?: unknown;
  environment?: unknown;
  volumes?: unknown;
  ports?: unknown;
};

type ComposeDocument = {
  services?: Record<string, ComposeService>;
};

type ComposePsRecord = {
  State?: string;
  Status?: string;
  Health?: string;
};

type CollectorConfig = {
  receivers?: Record<string, unknown>;
  exporters?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
  service?: {
    extensions?: unknown;
    pipelines?: Record<string, {
      receivers?: unknown;
      exporters?: unknown;
    }>;
  };
};

export type OtelCollectorConfigurationState = 'valid' | 'missing' | 'custom' | 'unreadable';

export interface OtelCollectorProbeResult {
  ok: boolean;
  status?: number;
}

export type OtelCollectorHttpProbe = (url: string) => Promise<OtelCollectorProbeResult>;

export interface OtelLogDeliveryInput {
  collectorHttpEndpoint: string;
  openObserveEndpoint: string;
  organization: string;
  stream: string;
  username: string;
  password: string;
  workspaceId: string;
}

export interface OtelLogDeliveryResult {
  ok: boolean;
  receiverAccepted: boolean;
  backendConfirmed: boolean;
  verifiedAt?: string;
  detail: string;
}

export type OtelLogDeliveryVerifier = (
  input: OtelLogDeliveryInput,
) => Promise<OtelLogDeliveryResult>;

export interface OtelCollectorRuntimeDetection {
  available: boolean;
  running: boolean;
  healthy: boolean;
  manageable: boolean;
  managedByLocalLink: boolean;
  configured: boolean;
  configurationState: OtelCollectorConfigurationState;
  credentialInjectionConfigured: boolean;
  loopbackOnly: boolean;
  source: 'docker-compose' | 'missing';
  detail: string;
  serviceName?: string;
  image?: string;
  configPath?: string;
  grpcPort?: string;
  httpPort?: string;
  healthPort?: string;
  grpcEndpoint?: string;
  httpEndpoint?: string;
  healthUrl?: string;
}

const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const CONFIG_TARGETS = new Set([
  '/etc/otelcol/config.yaml',
  '/etc/otelcol-contrib/config.yaml',
]);

function normalizeMap(value: unknown): Record<string, string> {
  if (Array.isArray(value)) {
    return Object.fromEntries(value.flatMap((entry) => {
      const [key, ...rest] = String(entry).split('=');
      return key ? [[key, rest.join('=')]] : [];
    }));
  }
  if (!value || typeof value !== 'object') return {};
  const node = value as { toJSON?: () => unknown };
  const plain = typeof node.toJSON === 'function' ? node.toJSON() : value;
  if (!plain || typeof plain !== 'object' || Array.isArray(plain)) return {};
  return Object.fromEntries(Object.entries(plain as Record<string, unknown>).map(([key, entry]) => [
    key,
    String(entry ?? ''),
  ]));
}

function normalizeList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function imageName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.split('@', 1)[0]?.split('/').at(-1)?.split(':', 1)[0]?.toLowerCase();
}

function isCollectorService(service: ComposeService): boolean {
  const labels = normalizeMap(service.labels);
  const name = imageName(service.image);
  return name === 'opentelemetry-collector'
    || name === 'opentelemetry-collector-contrib'
    || labels['locallink.provider']?.toLowerCase() === 'opentelemetry-collector';
}

async function readComposeDocument(workspaceRoot: string): Promise<ComposeDocument | undefined> {
  for (const fileName of COMPOSE_FILES) {
    try {
      const raw = await fs.readFile(path.join(workspaceRoot, fileName), 'utf8');
      const parsed = parseDocument(raw).toJS();
      if (parsed && typeof parsed === 'object') return parsed as ComposeDocument;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code !== 'ENOENT') return undefined;
    }
  }
  return undefined;
}

function interpolate(value: string | undefined, env: Record<string, string>): string | undefined {
  if (!value) return undefined;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, key: string, fallback: string) => (
    env[key] || fallback || ''
  ));
}

function splitPortSegments(value: string): string[] {
  const segments: string[] = [];
  let current = '';
  let braceDepth = 0;
  let bracketDepth = 0;
  for (const character of value) {
    if (character === '{') braceDepth += 1;
    if (character === '}') braceDepth = Math.max(0, braceDepth - 1);
    if (character === '[') bracketDepth += 1;
    if (character === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    if (character === ':' && braceDepth === 0 && bracketDepth === 0) {
      segments.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  segments.push(current);
  return segments;
}

function bindingForTarget(
  service: ComposeService,
  targetPort: string,
  fallback: string,
  env: Record<string, string>,
): { port: string; loopbackOnly: boolean } {
  if (!Array.isArray(service.ports)) return { port: fallback, loopbackOnly: false };
  for (const entry of service.ports) {
    if (entry && typeof entry === 'object') {
      const binding = entry as { host_ip?: unknown; published?: unknown; target?: unknown };
      if (String(binding.target ?? '') !== targetPort) continue;
      const hostIp = String(binding.host_ip ?? '');
      return {
        port: interpolate(String(binding.published ?? ''), env) || fallback,
        loopbackOnly: hostIp === '127.0.0.1' || hostIp === '::1',
      };
    }
    if (typeof entry !== 'string') continue;
    const parts = splitPortSegments(entry);
    const target = parts.at(-1)?.split('/')[0];
    if (target !== targetPort) continue;
    const host = parts.length >= 3 ? interpolate(parts.at(-3), env) : undefined;
    const published = parts.length >= 2 ? parts.at(-2) : parts[0];
    return {
      port: interpolate(published, env) || fallback,
      loopbackOnly: host === '127.0.0.1' || host === '[::1]' || host === '::1',
    };
  }
  return { port: fallback, loopbackOnly: false };
}

function volumeParts(volume: unknown): { source?: string; target?: string } {
  if (typeof volume === 'string') {
    const parts = volume.split(':');
    return parts.length >= 2 ? { source: parts[0], target: parts[1] } : {};
  }
  if (!volume || typeof volume !== 'object') return {};
  const value = volume as { source?: unknown; target?: unknown };
  return {
    source: typeof value.source === 'string' ? value.source : undefined,
    target: typeof value.target === 'string' ? value.target : undefined,
  };
}

function safeWorkspacePath(workspaceRoot: string, source: string): string | undefined {
  if (!source.startsWith('.') && !path.isAbsolute(source)) return undefined;
  const resolved = path.resolve(workspaceRoot, source);
  const relative = path.relative(path.resolve(workspaceRoot), resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return resolved;
}

function collectorConfigPath(workspaceRoot: string, service: ComposeService): string | undefined {
  if (!Array.isArray(service.volumes)) return undefined;
  for (const volume of service.volumes) {
    const parts = volumeParts(volume);
    if (!parts.source || !parts.target || !CONFIG_TARGETS.has(parts.target)) continue;
    const resolved = safeWorkspacePath(workspaceRoot, parts.source);
    if (resolved) return resolved;
  }
  return undefined;
}

function pipelineUses(
  pipeline: { receivers?: unknown; exporters?: unknown } | undefined,
  receiver: string,
  exporter: string,
): boolean {
  return normalizeList(pipeline?.receivers).includes(receiver)
    && normalizeList(pipeline?.exporters).includes(exporter);
}

async function readConfiguration(
  configPath: string | undefined,
  accessKey: string | undefined,
): Promise<{
  state: OtelCollectorConfigurationState;
  credentialInjectionConfigured: boolean;
}> {
  if (!configPath) return { state: 'missing', credentialInjectionConfigured: false };
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const config = parseDocument(raw).toJS() as CollectorConfig | undefined;
    if (!config || typeof config !== 'object') {
      return { state: 'unreadable', credentialInjectionConfigured: false };
    }
    const receiver = config.receivers?.otlp as {
      protocols?: Record<string, unknown>;
    } | undefined;
    const exporterName = Object.keys(config.exporters || {}).find((name) => name === 'otlp_http/openobserve');
    const pipelines = config.service?.pipelines || {};
    const signalsConfigured = Boolean(
      receiver?.protocols?.grpc
      && receiver.protocols.http
      && exporterName
      && pipelineUses(pipelines.traces, 'otlp', exporterName)
      && pipelineUses(pipelines.metrics, 'otlp', exporterName)
      && pipelineUses(pipelines.logs, 'otlp', exporterName),
    );
    const credentialReference = raw.includes('${env:OPENOBSERVE_ACCESS_KEY_B64}');
    const credentialEmbedded = Boolean(accessKey && raw.includes(accessKey));
    return {
      state: signalsConfigured && credentialReference && !credentialEmbedded ? 'valid' : 'custom',
      credentialInjectionConfigured: credentialReference && !credentialEmbedded,
    };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    return {
      state: code === 'ENOENT' ? 'missing' : 'unreadable',
      credentialInjectionConfigured: false,
    };
  }
}

function composeState(raw: string): { running: boolean; healthy: boolean } {
  const records = parseJsonOutput<ComposePsRecord>(raw);
  const running = records.some((record) => (
    record.State?.trim().toLowerCase() === 'running'
    || record.Status?.trim().toLowerCase().startsWith('up')
  ));
  const healthValues = records.map((record) => record.Health?.trim().toLowerCase()).filter(Boolean);
  return {
    running,
    healthy: running && healthValues.some((health) => health === 'healthy'),
  };
}

const defaultHttpProbe: OtelCollectorHttpProbe = async (url) => new Promise((resolve) => {
  const request = http.get(url, { timeout: 3_000 }, (response) => {
    response.resume();
    const status = response.statusCode;
    resolve({ ok: Boolean(status && status >= 200 && status < 300), status });
  });
  request.once('timeout', () => request.destroy(new Error('OpenTelemetry Collector probe timed out.')));
  request.once('error', () => resolve({ ok: false }));
});

export type OtelJsonPost = (
  url: string,
  payload: unknown,
  headers?: Record<string, string>,
) => Promise<{ ok: boolean; status?: number; body: string }>;

const postJson: OtelJsonPost = async (
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<{ ok: boolean; status?: number; body: string }> => new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const target = new URL(url);
    const request = http.request(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        ...headers,
      },
      timeout: 5_000,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer | string) => {
        if (size >= 1_000_000) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size <= 1_000_000) chunks.push(buffer);
      });
      response.on('end', () => {
        const status = response.statusCode;
        resolve({
          ok: Boolean(status && status >= 200 && status < 300),
          status,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    request.once('timeout', () => request.destroy(new Error('OTLP delivery verification timed out.')));
    request.once('error', () => resolve({ ok: false, body: '' }));
    request.end(body);
  });

export function createOtelLogDeliveryVerifier(jsonPost: OtelJsonPost): OtelLogDeliveryVerifier {
  return async (input) => {
    const canary = `locallink-collector-canary-${randomBytes(12).toString('hex')}`;
    const nowMilliseconds = Date.now();
    const nowNanoseconds = (BigInt(nowMilliseconds) * 1_000_000n).toString();
    const receiver = await jsonPost(
      `${input.collectorHttpEndpoint.replace(/\/$/, '')}/v1/logs`,
      {
        resourceLogs: [{
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'locallink-collector-verification' } },
              { key: 'locallink.workspace.id', value: { stringValue: input.workspaceId } },
            ],
          },
          scopeLogs: [{
            scope: { name: 'locallink.onboarding' },
            logRecords: [{
              timeUnixNano: nowNanoseconds,
              observedTimeUnixNano: nowNanoseconds,
              severityText: 'INFO',
              body: { stringValue: canary },
            }],
          }],
        }],
      },
    );
    if (!receiver.ok) {
      return {
        ok: false,
        receiverAccepted: false,
        backendConfirmed: false,
        detail: `The OTLP/HTTP receiver rejected the verification log${receiver.status ? ` with HTTP ${receiver.status}` : ''}.`,
      };
    }

    const streamIdentifier = input.stream.replace(/"/g, '""');
    const authorization = Buffer.from(`${input.username}:${input.password}`, 'utf8').toString('base64');
    const searchUrl = `${input.openObserveEndpoint.replace(/\/$/, '')}/api/${encodeURIComponent(input.organization)}/_search`;
    const searchPayload = {
      query: {
        sql: `SELECT * FROM "${streamIdentifier}" WHERE match_all('${canary}')`,
        start_time: (nowMilliseconds - 5 * 60_000) * 1_000,
        end_time: (nowMilliseconds + 5 * 60_000) * 1_000,
        from: 0,
        size: 10,
      },
    };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
      const search = await jsonPost(searchUrl, searchPayload, {
        Authorization: `Basic ${authorization}`,
      });
      if (search.ok && search.body.includes(canary)) {
        return {
          ok: true,
          receiverAccepted: true,
          backendConfirmed: true,
          verifiedAt: new Date().toISOString(),
          detail: 'A timestamped OTLP log was accepted by the collector and found in the configured OpenObserve stream.',
        };
      }
      if (search.status === 401 || search.status === 403) {
        return {
          ok: false,
          receiverAccepted: true,
          backendConfirmed: false,
          detail: 'The collector accepted the verification log, but OpenObserve rejected the verification query credentials.',
        };
      }
    }
    return {
      ok: false,
      receiverAccepted: true,
      backendConfirmed: false,
      detail: 'The collector accepted the verification log, but it was not found in OpenObserve before the verification timeout.',
    };
  };
}

export const verifyOtelLogDelivery = createOtelLogDeliveryVerifier(postJson);

export async function detectOtelCollectorRuntime(
  workspaceRoot: string,
  commandRunner: CommandRunner,
  env: Record<string, string> = {},
  httpProbe: OtelCollectorHttpProbe = defaultHttpProbe,
): Promise<OtelCollectorRuntimeDetection> {
  const compose = await readComposeDocument(workspaceRoot);
  const declared = Object.entries(compose?.services || {}).find(([, service]) => isCollectorService(service));
  if (!declared) {
    return {
      available: false,
      running: false,
      healthy: false,
      manageable: false,
      managedByLocalLink: false,
      configured: false,
      configurationState: 'missing',
      credentialInjectionConfigured: false,
      loopbackOnly: false,
      source: 'missing',
      detail: 'No OpenTelemetry Collector Docker Compose service is declared in this workspace.',
    };
  }

  const [serviceName, service] = declared;
  const labels = normalizeMap(service.labels);
  const environment = normalizeMap(service.environment);
  const grpc = bindingForTarget(service, '4317', env.OTEL_COLLECTOR_GRPC_PORT || '4317', env);
  const otlpHttp = bindingForTarget(service, '4318', env.OTEL_COLLECTOR_HTTP_PORT || '4318', env);
  const health = bindingForTarget(service, '13133', env.OTEL_COLLECTOR_HEALTH_PORT || '13133', env);
  const configPath = collectorConfigPath(workspaceRoot, service);
  const configuration = await readConfiguration(configPath, env.OPENOBSERVE_ACCESS_KEY_B64);
  const credentialEnvironment = interpolate(environment.OPENOBSERVE_ACCESS_KEY_B64, env);
  const credentialInjectionConfigured = configuration.credentialInjectionConfigured
    && Boolean(credentialEnvironment)
    && environment.OPENOBSERVE_ACCESS_KEY_B64?.includes('OPENOBSERVE_ACCESS_KEY_B64') === true;
  const managedByLocalLink = labels['locallink.managedBy'] === 'locallink';
  const psResult = await commandRunner(
    'docker',
    ['compose', '--profile', '*', 'ps', '--all', '--format', 'json', serviceName],
    { cwd: workspaceRoot, timeoutMs: 3_000 },
  );
  const state = psResult.ok ? composeState(psResult.stdout) : { running: false, healthy: false };
  const healthUrl = `http://127.0.0.1:${health.port}/`;
  const healthy = state.running && (state.healthy || (await httpProbe(healthUrl)).ok);
  const loopbackOnly = grpc.loopbackOnly && otlpHttp.loopbackOnly && health.loopbackOnly;
  const configured = configuration.state === 'valid' && credentialInjectionConfigured && loopbackOnly;
  const image = typeof service.image === 'string' ? service.image : undefined;

  return {
    available: true,
    running: state.running,
    healthy,
    manageable: true,
    managedByLocalLink,
    configured,
    configurationState: configuration.state,
    credentialInjectionConfigured,
    loopbackOnly,
    source: 'docker-compose',
    serviceName,
    image,
    configPath,
    grpcPort: grpc.port,
    httpPort: otlpHttp.port,
    healthPort: health.port,
    grpcEndpoint: `http://127.0.0.1:${grpc.port}`,
    httpEndpoint: `http://127.0.0.1:${otlpHttp.port}`,
    healthUrl,
    detail: [
      `Docker Compose service "${serviceName}" is declared${image ? ` with image ${image}` : ''}.`,
      state.running ? (healthy ? 'It is running and healthy.' : 'It is running but its health endpoint is failing.') : 'It is not running.',
      configuration.state === 'valid'
        ? 'Its logs, metrics, and traces pipelines use the workspace OTLP receiver and OpenObserve exporter.'
        : configuration.state === 'missing'
          ? 'Its workspace configuration file is missing.'
          : configuration.state === 'unreadable'
            ? 'Its workspace configuration file cannot be read.'
            : 'Its configuration is custom and has not been adopted by LocalLink.',
      credentialInjectionConfigured
        ? 'OpenObserve authorization is injected through the container environment.'
        : 'OpenObserve authorization injection is incomplete.',
      loopbackOnly
        ? `Its OTLP receivers are loopback-only on gRPC :${grpc.port} and HTTP :${otlpHttp.port}.`
        : 'One or more receiver or health ports are not explicitly loopback-only.',
    ].join(' '),
  };
}

export function otelCollectorStartCommand(
  runtime: Pick<OtelCollectorRuntimeDetection, 'source' | 'serviceName'>,
  forceRecreate = false,
): { command: string; args: string[] } | undefined {
  if (runtime.source !== 'docker-compose' || !runtime.serviceName) return undefined;
  return {
    command: 'docker',
    args: [
      'compose',
      '--profile',
      '*',
      'up',
      '-d',
      ...(forceRecreate ? ['--force-recreate'] : []),
      runtime.serviceName,
    ],
  };
}

export function otelCollectorStopCommand(
  runtime: Pick<OtelCollectorRuntimeDetection, 'source' | 'serviceName'>,
): { command: string; args: string[] } | undefined {
  if (runtime.source !== 'docker-compose' || !runtime.serviceName) return undefined;
  return {
    command: 'docker',
    args: ['compose', '--profile', '*', 'stop', runtime.serviceName],
  };
}
