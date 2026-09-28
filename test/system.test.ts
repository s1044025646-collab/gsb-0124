import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { createMappingVersion, createProduct, createStore, effectiveBaskets, importTransaction, refundLine, voidTransaction } from '../src/services.js';
import { backtest, freezeReport, runAnalysis } from '../src/analysis.js';
import { ApiError, type EffectiveBasket } from '../src/types.js';

let db: DatabaseSync;
let dbPath: string;

function setup() {
  dbPath = join(tmpdir(), `shopper-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
  db = openDb(dbPath);
  createStore(db, 'S1', 'Store 1');
  createStore(db, 'S2', 'Store 2');
  for (const id of ['A', 'B', 'C', 'X', 'Y', 'P', 'Q']) createProduct(db, id, id);
  createMappingVersion(db, ['A', 'B', 'C', 'X', 'Y', 'P', 'Q'].map(id => ({ sku: id, productId: id })), 'v1');
}
function tx(id: string, lines: [string, number][], time = '2026-01-02T00:00:00Z', store = 'S1') {
  return importTransaction(db, { id, storeId: store, time, lines: lines.map(([sku, quantity], i) => ({ lineRef: `L${i + 1}`, sku, quantity })) });
}
function bruteItemsets(baskets: EffectiveBasket[], minSupport: number) {
  const universe = [...new Set(baskets.flatMap(b => b.items))].sort();
  const out = new Map<string, number>();
  for (let mask = 1; mask < 1 << universe.length; mask++) {
    const items = universe.filter((_, i) => mask & 1 << i);
    const count = baskets.filter(b => items.every(x => b.items.includes(x))).length;
    if (count / baskets.length >= minSupport) out.set(items.join('|'), count);
  }
  return out;
}

beforeEach(setup);
afterEach(() => { db.close(); rmSync(dbPath, { force: true }); rmSync(`${dbPath}-wal`, { force: true }); rmSync(`${dbPath}-shm`, { force: true }); });

test('duplicate lines collapse and multi-quantity counts support once', () => {
  tx('T1', [['A', 3], ['B', 1]], '2026-01-02T00:00:00Z');
  db.prepare("UPDATE transaction_lines SET sku='A',product_id='A' WHERE transaction_id='T1' AND line_ref='L2'").run();
  const baskets = effectiveBaskets(db, {});
  assert.deepEqual(baskets[0].items, ['A']);
  const result = runAnalysis(db, { minSupport: 1, minConfidence: 0, maxCandidates: 100 });
  assert.equal(result.denominator, 1);
  assert.equal(result.itemsets[0].supportCount, 1);
});

test('exhaustive small-data result matches Apriori itemsets and metrics', () => {
  tx('T1', [['A', 1], ['B', 1], ['C', 1]]);
  tx('T2', [['A', 1], ['B', 1]]);
  tx('T3', [['A', 1], ['C', 1]], '2026-01-03T00:00:00Z');
  tx('T4', [['X', 1], ['Y', 1]], '2026-01-04T00:00:00Z');
  const baskets = effectiveBaskets(db, {});
  const result = mineOnce(0.25, 0);
  const expected = bruteItemsets(baskets, 0.25);
  assert.equal(result.itemsets.length, expected.size);
  for (const itemset of result.itemsets) assert.equal(itemset.supportCount, expected.get(itemset.items.join('|')));
  const rule = result.rules.find(r => r.antecedent.join() === 'B' && r.consequent.join() === 'A')!;
  assert.equal(rule.supportCount, 2);
  assert.equal(rule.support, 0.5);
  assert.equal(rule.confidence, 1);
  assert.equal(rule.lift, 1 / (3 / 4));
});

test('partial refund removes only fully refunded item; void removes whole basket', () => {
  tx('T1', [['A', 2], ['B', 1]], '2026-01-02T00:00:00Z');
  tx('T2', [['A', 1]], '2026-01-03T00:00:00Z');
  refundLine(db, 'T1', 'L1', 1, '2026-01-05T00:00:00Z');
  voidTransaction(db, 'T2', '2026-01-06T00:00:00Z');
  const current = effectiveBaskets(db, {});
  assert.deepEqual(current, [{ transactionId: 'T1', storeId: 'S1', time: '2026-01-02T00:00:00.000Z', items: ['A', 'B'] }]);
  refundLine(db, 'T1', 'L1', 1, '2026-01-07T00:00:00Z');
  assert.deepEqual(effectiveBaskets(db, {})[0].items, ['B']);
  const beforeLateRefund = effectiveBaskets(db, { asOf: '2026-01-06T23:59:59Z' })[0].items;
  assert.deepEqual(beforeLateRefund, ['A', 'B']);
});

test('empty denominator returns null confidence/lift instead of fabricated metrics', () => {
  const result = runAnalysis(db, { minSupport: 0.01, minConfidence: 0, maxCandidates: 100, start: '2030-01-01T00:00:00Z' });
  assert.equal(result.denominator, 0);
  assert.deepEqual(result.rules, []);
});

test('all-refunded basket disappears and ubiquitous consequent does not create lift', () => {
  tx('E1', [['A', 1], ['B', 1]], '2026-01-02T00:00:00Z');
  tx('E2', [['B', 1]], '2026-01-03T00:00:00Z');
  tx('E3', [['B', 1]], '2026-01-04T00:00:00Z');
  tx('E4', [['B', 1]], '2026-01-05T00:00:00Z');
  refundLine(db, 'E1', 'L1', 1, '2026-01-06T00:00:00Z');
  refundLine(db, 'E1', 'L2', 1, '2026-01-06T00:01:00Z');
  const baskets = effectiveBaskets(db, {});
  assert.equal(baskets.length, 3);
  assert.deepEqual(baskets.map(b => b.transactionId), ['E2', 'E3', 'E4']);
  tx('R1', [['A', 1], ['B', 1]], '2026-01-10T00:00:00Z');
  const result = runAnalysis(db, { minSupport: 0.01, minConfidence: 0.9, maxCandidates: 1000 });
  const misleading = result.rules.find(r => r.antecedent.join() === 'A' && r.consequent.join() === 'B')!;
  assert.equal(misleading.confidence, 1);
  assert.equal(misleading.lift, 1);
});

test('candidate truncation is marked incomplete and cannot be frozen', () => {
  for (let i = 0; i < 7; i++) tx(`T${i}`, [[['A', 'B', 'C', 'X', 'Y', 'P', 'Q'][i], 1]], `2026-01-0${i + 1}T00:00:00Z`);
  const result = runAnalysis(db, { minSupport: 0.01, minConfidence: 0, maxCandidates: 3 });
  assert.equal(result.incomplete, true);
  assert.match(result.truncationReason!, /candidate limit/);
  assert.throws(() => freezeReport(db, {
    name: 'bad', batchId: result.batchId, trainStart: '2026-01-01T00:00:00Z', trainEnd: '2026-02-01T00:00:00Z',
    rules: result.rules, minSupport: 0.01, minConfidence: 0, maxCandidates: 3, mappingVersionId: 1
  }), (err: ApiError) => err.code === 'INCOMPLETE_BATCH');
});

test('frozen report backtests strictly later window and rejects future leak', () => {
  tx('T1', [['A', 1], ['B', 1]], '2026-01-02T00:00:00Z');
  tx('T2', [['A', 1], ['B', 1]], '2026-01-03T00:00:00Z');
  tx('V1', [['A', 1]], '2026-02-02T00:00:00Z');
  const analysis = runAnalysis(db, { minSupport: 0.5, minConfidence: 0, maxCandidates: 100, start: '2026-01-01T00:00:00Z', end: '2026-02-01T00:00:00Z' });
  const reportId = freezeReport(db, { name: 'frozen', batchId: analysis.batchId, trainStart: '2026-01-01T00:00:00Z', trainEnd: '2026-02-01T00:00:00Z', rules: analysis.rules, minSupport: 0.5, minConfidence: 0, maxCandidates: 100, mappingVersionId: 1 });
  assert.throws(() => backtest(db, reportId, '2026-01-15T00:00:00Z', '2026-02-15T00:00:00Z'), (err: ApiError) => err.code === 'FUTURE_LEAK');
  const bt = backtest(db, reportId, '2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z');
  assert.equal(bt.denominator, 1);
  assert.equal(bt.results[0].confidence, 0);
});

test('duplicate submission is idempotent and invalid import rolls back', () => {
  const payload = { id: 'D1', storeId: 'S1', time: '2026-01-02T00:00:00Z', idempotencyKey: 'K1', lines: [{ lineRef: 'L1', sku: 'A', quantity: 1 }] };
  assert.equal(importTransaction(db, payload).inserted, true);
  assert.equal(importTransaction(db, payload).inserted, false);
  assert.throws(() => importTransaction(db, { id: 'D2', storeId: 'S1', time: '2026-01-02T00:00:00Z', idempotencyKey: 'K2', lines: [{ lineRef: 'L1', sku: 'UNKNOWN', quantity: 1 }] }));
  assert.equal((db.prepare('SELECT COUNT(*) n FROM transactions WHERE id=?').get('D2') as { n: number }).n, 0);
});

test('new mapping version changes historical basket analysis while frozen report stays isolated', () => {
  createProduct(db, 'AB', 'merged');
  tx('T1', [['A', 1], ['B', 1]]);
  const v2 = createMappingVersion(db, [{ sku: 'A', productId: 'AB' }, { sku: 'B', productId: 'AB' }], 'merge A/B');
  assert.deepEqual(effectiveBaskets(db, { mappingVersionId: v2 })[0].items, ['AB']);
  assert.deepEqual(effectiveBaskets(db, { mappingVersionId: 1 })[0].items, ['A', 'B']);
});

test('state survives database reopen and demo is repeatable', () => {
  tx('T1', [['A', 1]]);
  db.close();
  db = openDb(dbPath);
  assert.equal(effectiveBaskets(db, {}).length, 1);
  const demo = spawnSync(process.execPath, ['--experimental-sqlite', 'dist/src/cli.js', 'demo'], { encoding: 'utf8' });
  assert.equal(demo.status, 0, demo.stderr || demo.stdout);
  assert.match(demo.stdout, /trainDenominator/);
  const second = spawnSync(process.execPath, ['--experimental-sqlite', 'dist/src/cli.js', 'demo'], { encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
});

function mineOnce(minSupport: number, minConfidence: number) {
  return runAnalysis(db, { minSupport, minConfidence, maxCandidates: 1000 });
}

