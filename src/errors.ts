export interface AppErrorOptions {
  statusCode?: number;
  retryable?: boolean;
  details?: unknown;
}

export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(code: string, message: string, opts: AppErrorOptions = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = opts.statusCode ?? 500;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
  }
}

export interface ProviderErrorOptions {
  code?: string;
  retryable?: boolean;
  details?: unknown;
}

export class ProviderError extends AppError {
  constructor(message: string, opts: ProviderErrorOptions = {}) {
    super(opts.code ?? "PROVIDER_ERROR", message, {
      statusCode: 502,
      retryable: opts.retryable ?? false,
      details: opts.details,
    });
    this.name = "ProviderError";
  }
}
