import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS stores(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS mapping_versions(id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS product_aliases(
    mapping_version_id INTEGER NOT NULL REFERENCES mapping_versions(id),
    sku TEXT NOT NULL,
    product_id TEXT NOT NULL REFERENCES products(id),
    PRIMARY KEY(mapping_version_id, sku)
  );
  CREATE TABLE IF NOT EXISTS transaction_imports(
    idempotency_key TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS transactions(
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id),
    tx_time TEXT NOT NULL,
    voided_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_transactions_time ON transactions(tx_time);
  CREATE INDEX IF NOT EXISTS idx_transactions_store_time ON transactions(store_id, tx_time);
  CREATE TABLE IF NOT EXISTS transaction_lines(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    line_ref TEXT NOT NULL,
    sku TEXT NOT NULL,
    product_id TEXT NOT NULL REFERENCES products(id),
    quantity INTEGER NOT NULL CHECK(quantity > 0)
  );
  CREATE TABLE IF NOT EXISTS refunds(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    line_ref TEXT NOT NULL,
    refunded_quantity INTEGER NOT NULL CHECK(refunded_quantity > 0),
    reason TEXT NOT NULL DEFAULT '',
    refund_time TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_refunds_time ON refunds(refund_time);
  CREATE TABLE IF NOT EXISTS analysis_batches(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    parameters_json TEXT NOT NULL,
    incomplete INTEGER NOT NULL,
    truncation_reason TEXT
  );
  CREATE TABLE IF NOT EXISTS frozen_reports(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL REFERENCES analysis_batches(id),
    name TEXT NOT NULL UNIQUE,
    mapping_version_id INTEGER NOT NULL,
    train_start TEXT NOT NULL,
    train_end TEXT NOT NULL,
    min_support REAL NOT NULL,
    min_confidence REAL NOT NULL,
    max_candidates INTEGER NOT NULL,
    selected_rules_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS backtests(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL REFERENCES frozen_reports(id),
    validation_start TEXT NOT NULL,
    validation_end TEXT NOT NULL,
    as_of TEXT NOT NULL,
    denominator INTEGER NOT NULL,
    results_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'));
  `);
}

export function latestMappingVersion(db: DatabaseSync): number {
  const row = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM mapping_versions').get() as { id: number };
  return row.id;
}
