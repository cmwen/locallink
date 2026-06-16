import type { ServiceDefinition } from '../shared/contracts';

export interface Pm2Row {
  name?: string;
  monit?: {
    cpu?: number;
    memory?: number;
  };
  pm2_env?: {
    status?: string;
    pm_uptime?: number;
  };
}

export function selectPm2Row(definition: ServiceDefinition, rows: Pm2Row[]): Pm2Row | undefined {
  const candidateNames = [definition.runtimeName, definition.name].filter(
    (value, index, values): value is string => !!value && values.indexOf(value) === index,
  );

  for (const candidateName of candidateNames) {
    const row = rows.find((entry) => entry.name === candidateName);
    if (row) {
      return row;
    }
  }

  return undefined;
}
