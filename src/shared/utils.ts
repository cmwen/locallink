import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  captureOutput?: boolean;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface CommandResult {
  ok: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

export interface StreamingCommandHandle {
  child: ChildProcessWithoutNullStreams;
  done: Promise<CommandResult>;
  stop: () => void;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function titleCaseFromKey(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

export function normalizeTags(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof input === 'string') {
    return input
      .split(/[,·]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

export function formatMemory(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return '0 MB';
  }

  const bytes = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(bytes)) {
    return String(value);
  }

  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export function formatDurationFromTimestamp(timestamp?: number | string | null): string {
  if (!timestamp) {
    return '—';
  }

  const startedAt = typeof timestamp === 'string' ? Number(timestamp) : timestamp;
  if (!Number.isFinite(startedAt)) {
    return '—';
  }

  const minutes = Math.max(0, Math.floor((Date.now() - startedAt) / 60000));
  return formatDurationFromMinutes(minutes);
}

export function formatDurationFromSeconds(seconds?: number | string | null): string {
  if (seconds === null || seconds === undefined || seconds === '') {
    return '—';
  }

  const numericSeconds = typeof seconds === 'string' ? Number(seconds) : seconds;
  if (!Number.isFinite(numericSeconds)) {
    return '—';
  }

  const minutes = Math.max(0, Math.floor(numericSeconds / 60));
  return formatDurationFromMinutes(minutes);
}

function formatDurationFromMinutes(minutes: number): string {
  if (minutes < 1) {
    return '<1m';
  }

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours < 24) {
    return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const hourRemainder = hours % 24;
  return hourRemainder ? `${days}d ${hourRemainder}h` : `${days}d`;
}

export function parseJsonOutput<T>(input: string): T[] {
  const trimmed = input.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed as T[];
    }

    return [parsed as T];
  } catch {
    return trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as T];
        } catch {
          return [];
        }
      });
  }
}

function attachLineReader(stream: NodeJS.ReadableStream, onLine?: (line: string) => void): void {
  if (!onLine) {
    return;
  }

  const rl = createInterface({ input: stream });
  rl.on('line', (line) => {
    const trimmed = line.trimEnd();
    if (trimmed) {
      onLine(trimmed);
    }
  });
}

export function startStreamingCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
): StreamingCommandHandle {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  const captureOutput = options.captureOutput ?? true;
  let timedOut = false;
  let settled = false;
  let timeout: NodeJS.Timeout | undefined;

  attachLineReader(child.stdout, (line) => {
    if (captureOutput) {
      stdout += `${line}\n`;
    }
    options.onStdoutLine?.(line);
  });
  attachLineReader(child.stderr, (line) => {
    if (captureOutput) {
      stderr += `${line}\n`;
    }
    options.onStderrLine?.(line);
  });

  const done = new Promise<CommandResult>((resolve) => {
    const finish = (result: CommandResult) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve(result);
    };

    if (options.timeoutMs) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, options.timeoutMs);
    }

    child.on('error', (error) => {
      if (captureOutput) {
        stderr += `${error.message}\n`;
      }
      options.onStderrLine?.(error.message);
      finish({
        ok: false,
        code: null,
        signal: null,
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        timedOut,
        error: error.message,
      });
    });

    child.on('close', (code, signal) => {
      finish({
        ok: !timedOut && code === 0,
        code,
        signal,
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        timedOut,
      });
    });
  });

  return {
    child,
    done,
    stop: () => {
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    },
  };
}

export async function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const handle = startStreamingCommand(command, args, options);
  return handle.done;
}

export function isCommandMissingResult(result: Pick<CommandResult, 'code' | 'error' | 'stderr'>): boolean {
  const text = `${result.error ?? ''}\n${result.stderr ?? ''}`;
  return result.code === null && /enoent|command not found|not found/i.test(text);
}

export function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const next = line[index + 1];

    if (character === '"' && next === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (character === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (character === ',' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }

    current += character;
  }

  values.push(current);
  return values.map((value) => value.trim());
}
