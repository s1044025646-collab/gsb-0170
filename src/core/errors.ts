export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNSUPPORTED_DATE_STRUCTURE'
  | 'NON_POSITIVE_FINAL_CASHFLOW'
  | 'NON_POSITIVE_FACTOR'
  | 'MATURITY_CONFLICT'
  | 'UNDERDETERMINED_CURVE'
  | 'EXTRAPOLATION_DENIED'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_REPLAY'
  | 'CONFLICT'
  | 'PAYMENT_TIME_INVALID';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;
  readonly status: number;

  constructor(code: ErrorCode, message: string, details?: unknown, status = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
    this.status = status;
  }
}
