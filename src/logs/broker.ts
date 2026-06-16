import type { LogEntry, LogLevel } from '../shared/contracts';

const MAX_LOG_ENTRIES = 250;

type LogListener = (entry: LogEntry) => void;

export class LogBroker {
  constructor(private readonly sink?: (entry: LogEntry) => void) {}

  private readonly listeners = new Set<LogListener>();

  private readonly entries: LogEntry[] = [];

  append(message: string, stream = 'Runtime', level: LogLevel = 'info'): LogEntry {
    const timestamp = new Date();
    const entry: LogEntry = {
      timestamp: timestamp.toISOString(),
      time: timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      stream,
      level,
      message,
    };

    this.entries.unshift(entry);
    if (this.entries.length > MAX_LOG_ENTRIES) {
      this.entries.length = MAX_LOG_ENTRIES;
    }

    for (const listener of this.listeners) {
      listener(entry);
    }

    this.sink?.(entry);

    return entry;
  }

  seed(entries: Array<{ message: string; stream?: string; level?: LogLevel }>): void {
    if (this.entries.length > 0) {
      return;
    }

    for (const entry of entries.reverse()) {
      this.append(entry.message, entry.stream, entry.level);
    }
  }

  list(limit = 200): LogEntry[] {
    return this.entries.slice(0, limit);
  }

  subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
