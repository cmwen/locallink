import type { LogEntry } from './contracts';

export const CLI_LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const;

export type CliLogLevel = (typeof CLI_LOG_LEVELS)[number];

const LOG_LEVEL_WEIGHT: Record<CliLogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

let currentLogLevel: CliLogLevel = 'silent';

export function parseCliLogLevel(input: string | undefined): CliLogLevel | undefined {
  if (!input) {
    return undefined;
  }

  const normalized = input.trim().toLowerCase();
  return CLI_LOG_LEVELS.find((level) => level === normalized);
}

export function configureLogger(level: string | undefined, fallback: CliLogLevel = 'info'): CliLogLevel {
  currentLogLevel = parseCliLogLevel(level) ?? fallback;
  return currentLogLevel;
}

export function getLoggerLevel(): CliLogLevel {
  return currentLogLevel;
}

function shouldLog(level: Exclude<CliLogLevel, 'silent'>): boolean {
  return LOG_LEVEL_WEIGHT[currentLogLevel] >= LOG_LEVEL_WEIGHT[level];
}

function formatDetails(details?: Record<string, unknown>): string {
  if (!details || Object.keys(details).length === 0) {
    return '';
  }

  return ` ${JSON.stringify(details)}`;
}

function writeLog(level: Exclude<CliLogLevel, 'silent'>, message: string, details?: Record<string, unknown>): void {
  if (!shouldLog(level)) {
    return;
  }

  process.stderr.write(
    `${new Date().toISOString()} [${level.toUpperCase()}] ${message}${formatDetails(details)}\n`,
  );
}

export function logDebug(message: string, details?: Record<string, unknown>): void {
  writeLog('debug', message, details);
}

export function logInfo(message: string, details?: Record<string, unknown>): void {
  writeLog('info', message, details);
}

export function logWarn(message: string, details?: Record<string, unknown>): void {
  writeLog('warn', message, details);
}

export function logError(message: string, details?: Record<string, unknown>): void {
  writeLog('error', message, details);
}

export function mirrorBrokerEntry(entry: Pick<LogEntry, 'stream' | 'level' | 'message'>): void {
  if (entry.level === 'error') {
    logError(`[${entry.stream}] ${entry.message}`);
    return;
  }
  if (entry.level === 'warn') {
    logWarn(`[${entry.stream}] ${entry.message}`);
    return;
  }

  logInfo(`[${entry.stream}] ${entry.message}`);
}
