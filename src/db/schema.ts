export const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS valuation_dates (
  id TEXT PRIMARY KEY,
  iso_date TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS instruments (
  isin TEXT NOT NULL,
  valuation_date_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (isin, valuation_date_id),
  FOREIGN KEY (valuation_date_id) REFERENCES valuation_dates(id)
);

CREATE TABLE IF NOT EXISTS cash_flows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  isin TEXT NOT NULL,
  valuation_date_id TEXT NOT NULL,
  pay_date TEXT NOT NULL,
  amount REAL NOT NULL,
  ordinal INTEGER NOT NULL,
  FOREIGN KEY (valuation_date_id) REFERENCES valuation_dates(id)
);
CREATE INDEX IF NOT EXISTS idx_cf_instrument ON cash_flows(isin, valuation_date_id, ordinal);

CREATE TABLE IF NOT EXISTS quote_versions (
  id TEXT PRIMARY KEY,
  valuation_date_id TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (valuation_date_id) REFERENCES valuation_dates(id)
);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_version_id TEXT NOT NULL,
  isin TEXT NOT NULL,
  clean_price REAL NOT NULL,
  accrued REAL NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (quote_version_id, isin),
  FOREIGN KEY (quote_version_id) REFERENCES quote_versions(id)
);

CREATE TABLE IF NOT EXISTS curves (
  id TEXT PRIMARY KEY,
  quote_version_id TEXT NOT NULL UNIQUE,
  valuation_date_id TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  error_payload_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (quote_version_id) REFERENCES quote_versions(id),
  FOREIGN KEY (valuation_date_id) REFERENCES valuation_dates(id)
);

CREATE TABLE IF NOT EXISTS curve_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  curve_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  node_date TEXT NOT NULL,
  t REAL NOT NULL,
  df REAL NOT NULL,
  zero_rate REAL,
  UNIQUE (curve_id, ordinal),
  FOREIGN KEY (curve_id) REFERENCES curves(id)
);

CREATE TABLE IF NOT EXISTS bootstrap_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  curve_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  isin TEXT NOT NULL,
  maturity_date TEXT NOT NULL,
  t REAL NOT NULL,
  dirty_price REAL NOT NULL,
  pv_known REAL NOT NULL,
  final_amount REAL NOT NULL,
  df REAL NOT NULL,
  repriced_dirty REAL NOT NULL,
  error REAL NOT NULL,
  UNIQUE (curve_id, ordinal),
  FOREIGN KEY (curve_id) REFERENCES curves(id)
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  curve_id TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  frozen_at TEXT NOT NULL,
  FOREIGN KEY (curve_id) REFERENCES curves(id)
);

CREATE TABLE IF NOT EXISTS valuations (
  id TEXT PRIMARY KEY,
  curve_id TEXT NOT NULL,
  label TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (curve_id) REFERENCES curves(id)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`
  }
];
