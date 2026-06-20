const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function normalizeLoopbackBindHost(host?: string): string {
  const normalized = host?.trim().toLowerCase();
  if (normalized && LOOPBACK_HOSTS.has(normalized)) {
    return normalized;
  }

  return '127.0.0.1';
}

export function isLoopbackBindHost(host?: string): boolean {
  return normalizeLoopbackBindHost(host) === host?.trim().toLowerCase();
}
