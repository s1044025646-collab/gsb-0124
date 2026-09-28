import type { DatabaseSync } from 'node:sqlite';
import { ApiError, type EffectiveBasket, type TransactionInput } from './types.js';
import { latestMappingVersion } from './db.js';

type Row = Record<string, unknown>;

export function createProduct(db: DatabaseSync, id: string, name: string): void {
  assertId(id, 'productId');
  assertNonEmpty(name, 'name');
  try {
    db.prepare('INSERT INTO products(id,name) VALUES(?,?)').run(id, name);
  } catch (err) {
    if (isUnique(err)) throw new ApiError(409, 'PRODUCT_EXISTS', `product ${id} already exists`);
    throw err;
  }
}

export function createStore(db: DatabaseSync, id: string, name: string): void {
  assertId(id, 'storeId');
  assertNonEmpty(name, 'name');
  try {
    db.prepare('INSERT INTO stores(id,name) VALUES(?,?)').run(id, name);
  } catch (err) {
    if (isUnique(err)) throw new ApiError(409, 'STORE_EXISTS', `store ${id} already exists`);
    throw err;
  }
}

export interface AliasInput { sku: string; productId: string; }

export function createMappingVersion(db: DatabaseSync, aliases: AliasInput[], note: string): number {
  if (!Array.isArray(aliases) || aliases.length === 0) throw new ApiError(400, 'INVALID_ALIASES', 'aliases must be a non-empty array');
  for (const alias of aliases) {
    assertId(alias.sku, 'sku');
    assertId(alias.productId, 'productId');
  }
  const tx = db.prepare('BEGIN IMMEDIATE');
  try {
    tx.run();
    const info = db.prepare('INSERT INTO mapping_versions(note) VALUES(?)').run(note || '');
    const version = Number(info.lastInsertRowid);
    const insert = db.prepare('INSERT INTO product_aliases(mapping_version_id,sku,product_id) VALUES(?,?,?)');
    for (const alias of aliases) insert.run(version, alias.sku, alias.productId);
    db.prepare('COMMIT').run();
    return version;
  } catch (err) {
    db.prepare('ROLLBACK').run();
    if (isForeignKey(err)) throw new ApiError(400, 'UNKNOWN_PRODUCT', 'all productId values must exist');
    throw err;
  }
}

export function importTransaction(db: DatabaseSync, input: TransactionInput): { inserted: boolean } {
  validateTransaction(input);
  const key = input.idempotencyKey ?? `tx:${input.id}`;
  const existing = db.prepare('SELECT 1 FROM transaction_imports WHERE idempotency_key=?').get(key);
  if (existing) return { inserted: false };
  const mappingVersion = latestMappingVersion(db);
  const aliasSql = 'SELECT product_id FROM product_aliases WHERE mapping_version_id=? AND sku=?';
  const begin = db.prepare('BEGIN IMMEDIATE');
  try {
    begin.run();
    if (db.prepare('SELECT 1 FROM transaction_imports WHERE idempotency_key=?').get(key)) {
      db.prepare('ROLLBACK').run();
      return { inserted: false };
    }
    if (!db.prepare('SELECT 1 FROM stores WHERE id=?').get(input.storeId)) throw new ApiError(400, 'UNKNOWN_STORE', `unknown store ${input.storeId}`);
    db.prepare('INSERT INTO transactions(id,store_id,tx_time) VALUES(?,?,?)').run(input.id, input.storeId, new Date(input.time).toISOString());
    const lineStmt = db.prepare('INSERT INTO transaction_lines(transaction_id,line_ref,sku,product_id,quantity) VALUES(?,?,?,?,?)');
    const refs = new Set<string>();
    input.lines.forEach((line, index) => {
      const lineRef = line.lineRef || `L${index + 1}`;
      if (refs.has(lineRef)) throw new ApiError(400, 'DUPLICATE_LINE_REF', `duplicate lineRef ${lineRef}`);
      refs.add(lineRef);
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) throw new ApiError(400, 'INVALID_QUANTITY', 'quantity must be a positive integer');
      const mapped = db.prepare(aliasSql).get(mappingVersion, line.sku) as { product_id: string } | undefined;
      if (!mapped) throw new ApiError(400, 'UNMAPPED_SKU', `SKU ${line.sku} is absent from mapping version ${mappingVersion}`);
      lineStmt.run(input.id, lineRef, line.sku, mapped.product_id, line.quantity);
    });
    db.prepare('INSERT INTO transaction_imports(idempotency_key,transaction_id) VALUES(?,?)').run(key, input.id);
    db.prepare('COMMIT').run();
    return { inserted: true };
  } catch (err) {
    if (db.prepare('SELECT 1 FROM transactions WHERE id=?').get(input.id)) db.prepare('ROLLBACK').run();
    else { try { db.prepare('ROLLBACK').run(); } catch { /* already rolled back */ } }
    if (isUnique(err)) throw new ApiError(409, 'TRANSACTION_EXISTS', `transaction ${input.id} already exists`);
    throw err;
  }
}

export function refundLine(db: DatabaseSync, transactionId: string, lineRef: string, quantity: number, time: string, reason = ''): void {
  assertId(transactionId, 'transactionId');
  assertId(lineRef, 'lineRef');
  if (!Number.isInteger(quantity) || quantity <= 0) throw new ApiError(400, 'INVALID_REFUND_QTY', 'refund quantity must be positive integer');
  const ts = new Date(time).toISOString();
  const begin = db.prepare('BEGIN IMMEDIATE');
  try {
    begin.run();
    const line = db.prepare('SELECT quantity, t.voided_at AS voided FROM transaction_lines l JOIN transactions t ON t.id=l.transaction_id WHERE l.transaction_id=? AND line_ref=?').get(transactionId, lineRef) as { quantity: number; voided: string | null } | undefined;
    if (!line) throw new ApiError(404, 'LINE_NOT_FOUND', 'transaction line not found');
    if (line.voided) throw new ApiError(409, 'TRANSACTION_VOIDED', 'voided transactions cannot receive refunds');
    const prior = db.prepare('SELECT COALESCE(SUM(refunded_quantity),0) AS qty FROM refunds WHERE transaction_id=? AND line_ref=?').get(transactionId, lineRef) as { qty: number };
    if (prior.qty + quantity > line.quantity) throw new ApiError(400, 'REFUND_EXCEEDS_QTY', 'cumulative refund exceeds purchased quantity');
    db.prepare('INSERT INTO refunds(transaction_id,line_ref,refunded_quantity,reason,refund_time) VALUES(?,?,?,?,?)').run(transactionId, lineRef, quantity, reason, ts);
    db.prepare('COMMIT').run();
  } catch (err) {
    db.prepare('ROLLBACK').run();
    throw err;
  }
}

export function voidTransaction(db: DatabaseSync, transactionId: string, time: string): void {
  const info = db.prepare('UPDATE transactions SET voided_at=? WHERE id=? AND voided_at IS NULL').run(new Date(time).toISOString(), transactionId);
  if (info.changes === 0) {
    if (!db.prepare('SELECT 1 FROM transactions WHERE id=?').get(transactionId)) throw new ApiError(404, 'TRANSACTION_NOT_FOUND', 'transaction not found');
  }
}

export interface BasketQuery { storeId?: string; start?: string; end?: string; asOf?: string; mappingVersionId?: number; }

export function effectiveBaskets(db: DatabaseSync, q: BasketQuery): EffectiveBasket[] {
  const mappingVersion = q.mappingVersionId ?? latestMappingVersion(db);
  if (!mappingVersion) throw new ApiError(400, 'NO_MAPPING_VERSION', 'create a product mapping version before analysis');
  const where: string[] = ['t.voided_at IS NULL'];
  const params: any[] = [mappingVersion];
  if (q.storeId) { where.push('t.store_id=?'); params.push(q.storeId); }
  if (q.start) { where.push('t.tx_time >= ?'); params.push(new Date(q.start).toISOString()); }
  if (q.end) { where.push('t.tx_time < ?'); params.push(new Date(q.end).toISOString()); }
  if (q.asOf) {
    where.push('(t.voided_at IS NULL OR t.voided_at > ?)');
    where.push('(r.id IS NULL OR r.refund_time <= ?)');
    params.push(new Date(q.asOf).toISOString(), new Date(q.asOf).toISOString());
  }
  const rows = db.prepare(`
    SELECT t.id AS transactionId,t.store_id AS storeId,t.tx_time AS time,l.line_ref AS lineRef,
           COALESCE(pa.product_id,l.product_id) AS productId,l.quantity AS qty,COALESCE(SUM(r.refunded_quantity),0) AS refunded
    FROM transactions t
    JOIN transaction_lines l ON l.transaction_id=t.id
    JOIN product_aliases pa ON pa.mapping_version_id=? AND pa.sku=l.sku
    LEFT JOIN refunds r ON r.transaction_id=l.transaction_id AND r.line_ref=l.line_ref
    WHERE ${where.join(' AND ')}
    GROUP BY t.id,l.id
    ORDER BY t.id,l.id
  `).all(...params) as Row[];
  const byTx = new Map<string, EffectiveBasket>();
  for (const row of rows) {
    if (Number(row.refunded) >= Number(row.qty)) continue;
    const key = String(row.transactionId);
    let basket = byTx.get(key);
    if (!basket) {
      basket = { transactionId: key, storeId: String(row.storeId), time: String(row.time), items: [] };
      byTx.set(key, basket);
    }
    if (!basket.items.includes(String(row.productId))) basket.items.push(String(row.productId));
  }
  return [...byTx.values()].map(b => ({ ...b, items: b.items.sort() })).sort((a, b) => a.transactionId.localeCompare(b.transactionId));
}

export function listPaginated<T>(db: DatabaseSync, sql: string, params: any[], limit: number, cursor: string | null): { data: T[]; nextCursor: string | null } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError(400, 'INVALID_LIMIT', 'limit must be 1..200');
  let after = '';
  if (cursor) {
    try { after = Buffer.from(cursor, 'base64url').toString('utf8'); } catch { throw new ApiError(400, 'INVALID_CURSOR', 'cursor is not valid'); }
  }
  const data = db.prepare(`${sql}${sql.includes(' WHERE ') ? ' AND' : ' WHERE'} id > ? ORDER BY id LIMIT ?`).all(...params, after, limit + 1) as T[];
  const next = data.length > limit ? Buffer.from(String((data[limit - 1] as unknown as { id: unknown }).id)).toString('base64url') : null;
  return { data: data.slice(0, limit) as T[], nextCursor: next };
}

function validateTransaction(input: TransactionInput): void {
  assertId(input?.id, 'id');
  assertId(input?.storeId, 'storeId');
  if (!input.time || Number.isNaN(Date.parse(input.time))) throw new ApiError(400, 'INVALID_TIME', 'time must be ISO-8601');
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new ApiError(400, 'EMPTY_LINES', 'transaction requires at least one line');
}

function assertId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 100) throw new ApiError(400, 'INVALID_ID', `${field} must be a non-empty string up to 100 chars`);
}
function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') throw new ApiError(400, 'INVALID_VALUE', `${field} must be non-empty`);
}
function isUnique(err: unknown): boolean { return String((err as { code?: string }).code).includes('SQLITE_CONSTRAINT_UNIQUE'); }
function isForeignKey(err: unknown): boolean { return String((err as { code?: string }).code).includes('SQLITE_CONSTRAINT_FOREIGNKEY'); }

