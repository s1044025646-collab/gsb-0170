import { AppError } from './errors.js';

/**
 * All times in this project use a single convention:
 *  - dates are calendar dates in ISO form (YYYY-MM-DD)
 *  - year fractions use ACT/365 Fixed: t = actualDays / 365
 *  - rates are continuous-compounded annualised rates unless explicitly stated
 */
export const DAY_COUNT = 'ACT/365F';
export const DAYS_PER_YEAR = 365;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseIsoDate(value: string): Date {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    throw new AppError('VALIDATION_ERROR', `invalid ISO date: ${String(value)}`);
  }
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new AppError('VALIDATION_ERROR', `non-existent calendar date: ${value}`);
  }
  return dt;
}

export function toIso(dt: Date): string {
  const y = dt.getUTCFullYear().toString().padStart(4, '0');
  const m = (dt.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = dt.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** Year fraction under ACT/365F. Negative (pre-valuation) payments are rejected. */
export function yearFraction(valuationDate: Date, payDate: Date): number {
  const days = daysBetween(valuationDate, payDate);
  if (days < 0) {
    throw new AppError(
      'PAYMENT_TIME_INVALID',
      `payment at ${toIso(payDate)} precedes valuation date ${toIso(valuationDate)}`
    );
  }
  return days / DAYS_PER_YEAR;
}

export function assertFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AppError('VALIDATION_ERROR', `${name} must be a finite number`);
  }
  return value;
}

export function assertPositive(value: number, name: string): void {
  if (value <= 0) {
    throw new AppError('VALIDATION_ERROR', `${name} must be > 0, got ${value}`);
  }
}
