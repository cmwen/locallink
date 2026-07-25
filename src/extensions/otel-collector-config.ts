import fs from 'node:fs/promises';
import path from 'node:path';

import { stringify } from 'yaml';

export const OTEL_COLLECTOR_CONFIG_RELATIVE_PATH = '.locallink/otel-collector.yaml';
export const OTEL_COLLECTOR_VERIFICATION_RELATIVE_PATH = '.locallink/otel-collector-verification.json';

export interface OtelCollectorVerificationRecord {
  version: 1;
  verifiedAt: string;
  receiverHttpEndpoint: string;
  backendOtlpBaseUrl: string;
  organization: string;
  stream: string;
}

export function buildOtelCollectorConfig(openObserveServiceName: string): string {
  return stringify({
    extensions: {
      health_check: {
        endpoint: '0.0.0.0:13133',
      },
    },
    receivers: {
      otlp: {
        protocols: {
          grpc: {
            endpoint: '0.0.0.0:4317',
          },
          http: {
            endpoint: '0.0.0.0:4318',
          },
        },
      },
    },
    processors: {
      memory_limiter: {
        check_interval: '1s',
        limit_mib: 256,
        spike_limit_mib: 64,
      },
      batch: {},
    },
    exporters: {
      'otlp_http/openobserve': {
        endpoint: `http://${openObserveServiceName}:5080/api/\${env:OPENOBSERVE_ORGANIZATION}`,
        headers: {
          Authorization: 'Basic ${env:OPENOBSERVE_ACCESS_KEY_B64}',
          'stream-name': '${env:OPENOBSERVE_STREAM}',
        },
      },
    },
    service: {
      extensions: ['health_check'],
      pipelines: {
        traces: {
          receivers: ['otlp'],
          processors: ['memory_limiter', 'batch'],
          exporters: ['otlp_http/openobserve'],
        },
        metrics: {
          receivers: ['otlp'],
          processors: ['memory_limiter', 'batch'],
          exporters: ['otlp_http/openobserve'],
        },
        logs: {
          receivers: ['otlp'],
          processors: ['memory_limiter', 'batch'],
          exporters: ['otlp_http/openobserve'],
        },
      },
    },
  });
}

export async function writeOtelCollectorConfig(
  workspaceRoot: string,
  openObserveServiceName: string,
): Promise<{ path: string; changed: boolean }> {
  const configPath = path.join(workspaceRoot, OTEL_COLLECTOR_CONFIG_RELATIVE_PATH);
  const content = buildOtelCollectorConfig(openObserveServiceName);
  let current = '';
  try {
    current = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code !== 'ENOENT') throw error;
  }
  if (current === content) {
    await fs.chmod(configPath, 0o644);
    return { path: configPath, changed: false };
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.tmp-${process.pid}`;
  await fs.writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o644 });
  await fs.rename(temporaryPath, configPath);
  await fs.chmod(configPath, 0o644);
  return { path: configPath, changed: true };
}

export async function readOtelCollectorVerification(
  workspaceRoot: string,
  expected: Omit<OtelCollectorVerificationRecord, 'version' | 'verifiedAt'>,
): Promise<OtelCollectorVerificationRecord | undefined> {
  try {
    const raw = await fs.readFile(
      path.join(workspaceRoot, OTEL_COLLECTOR_VERIFICATION_RELATIVE_PATH),
      'utf8',
    );
    const record = JSON.parse(raw) as Partial<OtelCollectorVerificationRecord>;
    if (
      record.version !== 1
      || typeof record.verifiedAt !== 'string'
      || record.receiverHttpEndpoint !== expected.receiverHttpEndpoint
      || record.backendOtlpBaseUrl !== expected.backendOtlpBaseUrl
      || record.organization !== expected.organization
      || record.stream !== expected.stream
    ) return undefined;
    return record as OtelCollectorVerificationRecord;
  } catch {
    return undefined;
  }
}

export async function writeOtelCollectorVerification(
  workspaceRoot: string,
  record: OtelCollectorVerificationRecord,
): Promise<void> {
  const filePath = path.join(workspaceRoot, OTEL_COLLECTOR_VERIFICATION_RELATIVE_PATH);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o644,
  });
  await fs.rename(temporaryPath, filePath);
  await fs.chmod(filePath, 0o644);
}
