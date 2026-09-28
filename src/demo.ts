import { rmSync } from 'node:fs';
import { openDb, latestMappingVersion } from './db.js';
import { createMappingVersion, createProduct, createStore, effectiveBaskets, importTransaction, refundLine, voidTransaction } from './services.js';
import { freezeReport, runAnalysis, backtest } from './analysis.js';
import { generateTransactions } from './generator.js';

export async function runDemo(dbPath: string): Promise<void> {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  const db = openDb(dbPath);
  try {
    for (const id of ['S1', 'S2']) createStore(db, id, id);
    for (const id of ['bread', 'butter', 'milk', 'eggs', 'cereal', 'coffee', 'tea', 'sugar', 'diaper', 'beer']) createProduct(db, id, id);
    createMappingVersion(db, ['bread', 'butter', 'milk', 'eggs', 'cereal', 'coffee', 'tea', 'sugar', 'diaper', 'beer'].map(id => ({ sku: id, productId: id })), 'demo v1');
    const train = generateTransactions({ prefix: 'TRAIN', count: 100, start: '2026-01-01T00:00:00Z', end: '2026-02-01T00:00:00Z', stores: ['S1', 'S2'], seed: 42 });
    const validation = generateTransactions({ prefix: 'VALID', count: 60, start: '2026-02-01T00:00:00Z', end: '2026-03-01T00:00:00Z', stores: ['S1', 'S2'], seed: 99 });
    train.forEach(tx => importTransaction(db, tx));
    validation.forEach(tx => importTransaction(db, tx));
    refundLine(db, train[0].id, train[0].lines[0].lineRef!, train[0].lines[0].quantity, '2026-01-15T00:00:00Z', 'full item refund leaves remaining basket');
    voidTransaction(db, train[1].id, '2026-01-16T00:00:00Z');
    const params = { minSupport: 0.05, minConfidence: 0.45, maxCandidates: 100000, start: '2026-01-01T00:00:00Z', end: '2026-02-01T00:00:00Z' };
    const analysis = runAnalysis(db, params);
    const reportId = freezeReport(db, {
      name: 'demo-frozen-2026-01',
      batchId: analysis.batchId,
      trainStart: params.start,
      trainEnd: params.end,
      rules: analysis.rules,
      minSupport: params.minSupport,
      minConfidence: params.minConfidence,
      maxCandidates: params.maxCandidates,
      mappingVersionId: latestMappingVersion(db)
    });
    const validationResult = backtest(db, reportId, '2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z');
    console.log(JSON.stringify({
      trainDenominator: analysis.denominator,
      incomplete: analysis.incomplete,
      topItemsets: analysis.itemsets.slice(0, 5),
      topRules: analysis.rules.slice(0, 5),
      frozenReportId: reportId,
      validationDenominator: validationResult.denominator,
      validation: validationResult.results.slice(0, 5),
      currentEffectiveBaskets: effectiveBaskets(db, {}).length
    }, null, 2));
  } finally {
    db.close();
  }
}

if (import.meta.dirname === process.cwd()) await runDemo(process.env.SHOPPER_DB ?? 'data/demo.sqlite');

