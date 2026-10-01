import { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db/db.js';
import { Env, defaultEnv } from './types.js';

export interface IdempotentResponse<T> {
  replayed: boolean;
  result: T;
}

/**
 * Run a mutating operation at most once per client-supplied key.
 * Repeated submissions replay the stored JSON response.
 */
export function idempotent<T>(
  db: DatabaseSync,
  key: string | undefined,
  fn: () => T,
  env: Env = defaultEnv
): IdempotentResponse<T> {
  if (!key) return { replayed: false, result: fn() };
  const stored = db.prepare('SELECT response_json FROM idempotency_keys WHERE key = ?').get(key) as
    | { response_json: string }
    | undefined;
  if (stored) {
    return { replayed: true, result: JSON.parse(stored.response_json) as T };
  }
  return withTransaction(db, () => {
    const result = fn();
    db.prepare('INSERT INTO idempotency_keys (key, response_json, created_at) VALUES (?, ?, ?)').run(
      key,
      JSON.stringify(result),
      env.now().toISOString()
    );
    return { replayed: false, result };
  });
}
