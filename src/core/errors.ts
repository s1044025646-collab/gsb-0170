export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_DATE'
  | 'PAYMENT_BEFORE_VALUE_DATE'
  | 'ZERO_TIME_CASHFLOW'
  | 'NON_POSITIVE_FINAL_CASHFLOW'
  | 'NO_CASHFLOWS'
  | 'UNSUPPORTED_DATE_STRUCTURE'
  | 'EARLY_PAYMENT_NOT_ON_NODE'
  | 'NON_POSITIVE_DISCOUNT_FACTOR'
  | 'UNDERDETERMINED_CURVE'
  | 'CONFLICTING_QUOTES'
  | 'NO_QUOTES'
  | 'EXTRAPOLATION_REJECTED'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'VERSION_FROZEN'
  | 'YTM_NO_CONVERGENCE';

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}
