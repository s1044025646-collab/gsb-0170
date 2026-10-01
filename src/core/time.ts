// Time conventions used everywhere in this project:
//  - day count: ACT/365F (actual calendar days divided by 365)
//  - compounding: continuous compounding
//  - time unit: year fractions measured from the valuation date

export const DAY_COUNT_DENOMINATOR = 365;
export const MS_PER_DAY = 86_400_000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDate(input: string): Date {
  if (typeof input !== 'string' || !DATE_RE.test(input)) {
    throw new Error(`invalid ISO date: ${String(input)}`);
  }
  const [y, m, d] = input.split('-').map((p) => Number(p));
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m! - 1 ||
    date.getUTCDate() !== d
  ) {
    throw new Error(`invalid calendar date: ${input}`);
  }
  return date;
}

export function toISO(date: Date): string {
  const y = date.getUTCFullYear().toString().padStart(4, '0');
  const m = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = date.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function assertISODate(input: unknown, field: string): Date {
  if (typeof input !== 'string' || !DATE_RE.test(input)) {
    const err = new Error(`${field} must be an ISO date YYYY-MM-DD`);
    err.name = 'ValidationError';
    throw err;
  }
  try {
    return parseDate(input);
  } catch {
    const err = new Error(`${field} is not a valid calendar date`);
    err.name = 'ValidationError';
    throw err;
  }
}

// ACT/365F year fraction between two UTC dates.
export function yearFraction(from: Date, to: Date): number {
  const days = Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
  return days / DAY_COUNT_DENOMINATOR;
}
