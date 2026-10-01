import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_SQL } from './schema.js';

export type DB = DatabaseSync;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  migrate(db);
  return db;
}

// Migrations are idempotent: CREATE TABLE IF NOT EXISTS plus a recorded
// migration version, safe to run repeatedly against an existing database.
export function migrate(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)`,
  ).run(now);
}

export function currentProjectRoot(): string {
  // src/db/database.ts -> project root is two levels up
  const here = dirname(fileURLToPath(import.meta.url));
  return dirname(dirname(here));
}
