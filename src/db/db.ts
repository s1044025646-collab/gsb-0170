import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './schema.js';

export interface DbContext {
  db: DatabaseSync;
  close: () => void;
}

/**
 * Open (creating if needed) the SQLite file and run pending migrations.
 * Migrations are tracked in schema_migrations and are idempotent / repeatable.
 */
export function openDatabase(path: string, now: () => Date = () => new Date()): DbContext {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  migrate(db, now);
  return {
    db,
    close: () => db.close()
  };
}

export function migrate(db: DatabaseSync, now: () => Date = () => new Date()): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);`
  );
  const appliedRows = db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[];
  const applied = new Set(appliedRows.map((r) => r.id));
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    const tx = db.prepare(
      `INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)`
    );
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      tx.run(migration.id, now().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  // Nested calls use SAVEPOINTs so an idempotency wrapper and a service can
  // both participate in one atomic transaction.
  const depth = transactionDepth.get(db) ?? 0;
  transactionDepth.set(db, depth + 1);
  const name = `sp_${depth}`;
  if (depth === 0) db.exec('BEGIN');
  else db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    if (depth === 0) db.exec('COMMIT');
    else db.exec(`RELEASE SAVEPOINT ${name}`);
    transactionDepth.set(db, depth);
    return result;
  } catch (err) {
    if (depth === 0) db.exec('ROLLBACK');
    else db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    transactionDepth.set(db, depth);
    throw err;
  }
}

const transactionDepth = new WeakMap<DatabaseSync, number>();

export interface PageParams {
  limit?: number;
  offset?: number;
}

export function normalisePage(params: PageParams): { limit: number; offset: number } {
  let limit = params.limit ?? 50;
  let offset = params.offset ?? 0;
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  if (limit > 200) limit = 200;
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  return { limit: Math.floor(limit), offset: Math.floor(offset) };
}

export interface Page<T> {
  items: T[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

export function makePage<T>(items: T[], limit: number, offset: number, total: number): Page<T> {
  return { items, limit, offset, hasMore: offset + items.length < total };
}
