export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- A quote version is an immutable batch of quotes used for one bootstrap run.
CREATE TABLE IF NOT EXISTS quote_versions (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  value_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  idempotency_key TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_quote_versions_idem
  ON quote_versions(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS instruments (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS instrument_quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_version_id TEXT NOT NULL REFERENCES quote_versions(id) ON DELETE CASCADE,
  instrument_id TEXT NOT NULL,
  clean_price REAL NOT NULL,
  accrued_interest REAL NOT NULL,
  created_at TEXT NOT NULL,
  idempotency_key TEXT,
  UNIQUE(quote_version_id, instrument_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_instrument_quotes_idem
  ON instrument_quotes(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS cashflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument_id TEXT NOT NULL,
  quote_version_id TEXT NOT NULL,
  pay_date TEXT NOT NULL,
  amount REAL NOT NULL,
  ordinal INTEGER NOT NULL,
  UNIQUE(quote_version_id, instrument_id, ordinal),
  FOREIGN KEY(quote_version_id) REFERENCES quote_versions(id) ON DELETE CASCADE
);

-- Immutable curve versions. Rebuilding creates a new row; old curves survive.
CREATE TABLE IF NOT EXISTS curve_versions (
  id TEXT PRIMARY KEY,
  quote_version_id TEXT NOT NULL REFERENCES quote_versions(id),
  value_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('built', 'frozen', 'failed')),
  created_at TEXT NOT NULL,
  frozen_at TEXT,
  build_error_code TEXT,
  build_error_message TEXT,
  idempotency_key TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_curve_versions_idem
  ON curve_versions(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS curve_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  curve_version_id TEXT NOT NULL REFERENCES curve_versions(id) ON DELETE CASCADE,
  pay_date TEXT NOT NULL,
  year_fraction REAL NOT NULL,
  discount_factor REAL NOT NULL,
  zero_rate REAL NOT NULL,
  ordinal INTEGER NOT NULL,
  UNIQUE(curve_version_id, ordinal)
);

-- Frozen report rows keep the ORIGINAL quotes together with repricing errors.
CREATE TABLE IF NOT EXISTS curve_residuals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  curve_version_id TEXT NOT NULL REFERENCES curve_versions(id) ON DELETE CASCADE,
  instrument_id TEXT NOT NULL,
  maturity_date TEXT NOT NULL,
  quoted_clean_price REAL NOT NULL,
  quoted_accrued_interest REAL NOT NULL,
  quoted_dirty_price REAL NOT NULL,
  model_dirty_price REAL NOT NULL,
  error REAL NOT NULL,
  ordinal INTEGER NOT NULL,
  UNIQUE(curve_version_id, ordinal)
);
`;
