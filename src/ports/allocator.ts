import net from 'node:net';

import type { ServiceDefinition } from '../shared/contracts';

export interface PortScanResult {
  startFrom: number;
  nextFree: number;
  busy: number[];
}

async function canBind(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();

    server.once('error', () => {
      resolve(false);
    });

    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

export class PortAllocator {
  async isPortAvailable(port: number): Promise<boolean> {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return false;
    }

    const loopbackFree = await canBind('127.0.0.1', port);
    if (!loopbackFree) {
      return false;
    }

    return canBind('0.0.0.0', port);
  }

  async findNextAvailablePort(startFrom = 5000, maxAttempts = 2000): Promise<PortScanResult> {
    let port = Math.max(1024, Math.floor(startFrom));
    const busy: number[] = [];
    const lastPort = Math.min(65535, port + maxAttempts - 1);

    while (port <= lastPort) {
      // eslint-disable-next-line no-await-in-loop
      const available = await this.isPortAvailable(port);
      if (available) {
        return { startFrom: Math.max(1024, Math.floor(startFrom)), nextFree: port, busy };
      }

      busy.push(port);
      port += 1;
    }

    throw new Error(
      `No available port found from ${Math.max(1024, Math.floor(startFrom))} to ${lastPort}. Check LOCALLINK_DEFAULT_PORT_START or stop a process using those ports.`,
    );
  }

  buildRecentEntries(definitions: ServiceDefinition[], scan: PortScanResult, includeSuggestion = true) {
    const configured = definitions
      .map((definition) => ({ service: definition.name, port: definition.port }))
      .filter((entry): entry is { service: string; port: string } => !!entry.port && entry.port !== '—')
      .map((entry) => {
        const port = Number(entry.port);
        const busy = Number.isFinite(port) && scan.busy.includes(port);
        return {
          service: entry.service,
          port: entry.port,
          status: busy ? 'occupied' : 'configured',
        };
      });

    if (includeSuggestion) {
      configured.push({
        service: 'next open port',
        port: String(scan.nextFree),
        status: 'suggested',
      });
    }

    return configured;
  }
}
