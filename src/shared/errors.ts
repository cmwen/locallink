export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 500,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function formatFatalError(error: unknown): string {
  if (error && typeof error === 'object') {
    const name = 'name' in error && typeof error.name === 'string' ? error.name : '';
    const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
    if (message) {
      return name && name !== 'Error' && name !== 'AppError' ? `${name}: ${message}` : message;
    }
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  return `Unexpected fatal error: ${String(error)}`;
}
