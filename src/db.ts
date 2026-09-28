import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

// Idempotent migrations tracked in user_version / schema_migrations.
const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: '001_init',
    sql: `
CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- A merge version snapshots the product->group mapping effective from valid_from.
CREATE TABLE IF NOT EXISTS merge_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  valid_from INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS product_groups (
  merge_version_id INTEGER NOT NULL REFERENCES merge_versions(id) ON DELETE CASCADE,
  group_code TEXT NOT NULL,
  group_name TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  PRIMARY KEY (merge_version_id, product_id)
);
-- txn: a single receipt / shopping trip. voided = full cancellation (whole order).
CREATE TABLE IF NOT EXISTS txn (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ext_id TEXT NOT NULL UNIQUE,       -- client-supplied idempotency key
  store_id INTEGER NOT NULL REFERENCES stores(id),
  txn_time INTEGER NOT NULL,
  voided INTEGER NOT NULL DEFAULT 0,
  voided_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_txn_store_time ON txn(store_id, txn_time);
-- line items; qty may be >1 but the item counts once for support.
CREATE TABLE IF NOT EXISTS txn_line (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id INTEGER NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_price INTEGER NOT NULL DEFAULT 0,
  UNIQUE (txn_id, product_id)
);
-- refunds: line-level. partial when refunded_qty < qty; a line is basket-removed
-- only when refunded_qty >= qty. full order reversal is txn.voided.
CREATE TABLE IF NOT EXISTS refund (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_line_id INTEGER NOT NULL REFERENCES txn_line(id) ON DELETE CASCADE,
  refunded_qty INTEGER NOT NULL CHECK (refunded_qty > 0),
  refund_time INTEGER NOT NULL,
  ext_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS analysis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,        -- exclusive
  store_id INTEGER REFERENCES stores(id),  -- null = all stores
  merge_version_id INTEGER NOT NULL REFERENCES merge_versions(id),
  min_support REAL NOT NULL,
  min_confidence REAL NOT NULL,
  max_candidates INTEGER NOT NULL,
  max_itemset_size INTEGER NOT NULL,
  denominator INTEGER NOT NULL DEFAULT 0, -- #eligible baskets
  complete INTEGER NOT NULL DEFAULT 1,   -- 0 = candidate cap hit, truncated
  cap_reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS itemset (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_id INTEGER NOT NULL REFERENCES analysis(id) ON DELETE CASCADE,
  items TEXT NOT NULL,                 -- JSON sorted array of item keys
  size INTEGER NOT NULL,
  support_count INTEGER NOT NULL,
  support REAL NOT NULL,
  sample_txn_ids TEXT NOT NULL         -- JSON array (traceable, capped)
);
CREATE TABLE IF NOT EXISTS rule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_id INTEGER NOT NULL REFERENCES analysis(id) ON DELETE CASCADE,
  antecedent TEXT NOT NULL,           -- JSON array
  consequent TEXT NOT NULL,           -- JSON array
  support_count INTEGER NOT NULL,     -- txns containing antecedent ∪ consequent
  support REAL NOT NULL,
  confidence REAL NOT NULL,
  lift REAL NOT NULL,
  antecedent_count INTEGER NOT NULL,
  sample_txn_ids TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rule_analysis ON rule(analysis_id);
-- frozen rule selection from a training analysis, backtested on a later period.
CREATE TABLE IF NOT EXISTS freeze (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  training_analysis_id INTEGER NOT NULL REFERENCES analysis(id),
  validation_start INTEGER NOT NULL,
  validation_end INTEGER NOT NULL,    -- exclusive
  merge_version_id INTEGER NOT NULL REFERENCES merge_versions(id),
  store_id INTEGER REFERENCES stores(id),
  created_at INTEGER NOT NULL,
  UNIQUE (training_analysis_id, validation_start, validation_end)
);
CREATE TABLE IF NOT EXISTS freeze_rule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  freeze_id INTEGER NOT NULL REFERENCES freeze(id) ON DELETE CASCADE,
  rule_id INTEGER NOT NULL REFERENCES rule(id),
  train_support REAL NOT NULL,
  train_confidence REAL NOT NULL,
  train_lift REAL NOT NULL,
  val_denominator INTEGER NOT NULL,
  val_antecedent_count INTEGER NOT NULL,
  val_support_count INTEGER NOT NULL,
  val_support REAL,
  val_confidence REAL,               -- null when antecedent never occurs
  val_lift REAL,
  val_sample_txn_ids TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency (
  ext_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`
  }
];

export function migrate(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);`
  );
  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map(
      (r) => r.name
    )
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    const tx = db.exec.bind(db);
    db.exec('BEGIN');
    try {
      tx(m.sql);
      db.prepare('INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)').run(
        m.name,
        Date.now()
      );
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
