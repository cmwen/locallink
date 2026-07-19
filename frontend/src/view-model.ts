import type { ServiceRecord } from './types';

export type ServiceHealthFilter = 'all' | 'attention' | 'running' | 'stopped';

const DOCUMENTATION_ONLY_REASON = /^No service documentation/i;

function includesQuery(value: string | undefined, query: string): boolean {
  return Boolean(value?.toLowerCase().includes(query));
}

export function serviceNeedsAttention(service: ServiceRecord): boolean {
  const operationalReasons = (service.reviewReasons || []).filter((reason) => !DOCUMENTATION_ONLY_REASON.test(reason));
  return (
    service.status === 'degraded' ||
    service.status === 'unknown' ||
    service.compliance?.status === 'warn' ||
    operationalReasons.length > 0
  );
}

export function serviceMatchReason(service: ServiceRecord, rawQuery: string): string | null {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return 'All services';

  const fields: Array<[string, Array<string | undefined>]> = [
    ['name', [service.name]],
    ['runtime', [service.kind, service.group, service.runtime, service.runtimeName, service.taskName]],
    ['status', [service.status, service.statusLabel, service.compliance?.status, service.compliance?.summary]],
    ['port', [service.port, service.portEnv, ...(service.edgeUrls || [])]],
    ['description', [service.notes, service.detail, service.tags]],
    ['documentation', [service.docsUrl]],
    ['relationship', [...(service.dependsOn || []), ...(service.downstream || [])]],
    ['environment', service.envVars || []],
    ['configuration', [service.blueprint?.command, service.cwd, service.script]],
  ];

  for (const [reason, values] of fields) {
    if (values.some((value) => includesQuery(value, query))) return reason;
  }

  return null;
}

export function filterServices(
  services: ServiceRecord[],
  filter: ServiceHealthFilter,
  query: string,
): ServiceRecord[] {
  return services.filter((service) => {
    const healthMatches =
      filter === 'all' ||
      (filter === 'attention' && serviceNeedsAttention(service)) ||
      (filter === 'running' && service.status === 'running') ||
      (filter === 'stopped' && service.status === 'stopped');
    return healthMatches && serviceMatchReason(service, query) !== null;
  });
}

export function selectVisibleService(
  services: ServiceRecord[],
  selectedServiceId: string,
): ServiceRecord | undefined {
  return services.find((service) => service.id === selectedServiceId) || services[0];
}

export function matchesWorkspaceQuery(query: string, ...values: Array<string | undefined>): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return values.some((value) => includesQuery(value, normalized));
}
