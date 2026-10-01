import { randomBytes } from 'node:crypto';

/** Deterministic-ish id with injectable RNG/clock for reproducible tests. */
export function makeId(prefix: string, rand: () => number = Math.random, now: () => Date = () => new Date()): string {
  const buf = randomBytes(8);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = Math.floor(rand() * 256);
  }
  const ts = now().getTime().toString(36);
  return `${prefix}_${ts}_${buf.toString('hex')}`;
}
