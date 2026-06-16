import { AppError } from './errors';
import { CLI_LOG_LEVELS, type CliLogLevel, parseCliLogLevel } from './logger';

export interface ParsedCliOptions {
  positionals: string[];
  logLevel?: CliLogLevel;
}

export function parseCliOptions(argv: string[]): ParsedCliOptions {
  const positionals: string[] = [];
  let logLevel = parseCliLogLevel(process.env.LOCALLINK_LOG_LEVEL);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--log-level' || argument === '-l') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) {
        throw new AppError(
          'INVALID_LOG_LEVEL',
          `--log-level requires one of: ${CLI_LOG_LEVELS.join(', ')}.`,
          400,
        );
      }

      logLevel = parseCliLogLevel(value);
      if (!logLevel) {
        throw new AppError(
          'INVALID_LOG_LEVEL',
          `Unsupported log level "${value}". Use one of: ${CLI_LOG_LEVELS.join(', ')}.`,
          400,
        );
      }

      index += 1;
      continue;
    }

    if (argument.startsWith('--log-level=')) {
      const value = argument.slice('--log-level='.length);
      logLevel = parseCliLogLevel(value);
      if (!logLevel) {
        throw new AppError(
          'INVALID_LOG_LEVEL',
          `Unsupported log level "${value}". Use one of: ${CLI_LOG_LEVELS.join(', ')}.`,
          400,
        );
      }
      continue;
    }

    positionals.push(argument);
  }

  return {
    positionals,
    logLevel,
  };
}
