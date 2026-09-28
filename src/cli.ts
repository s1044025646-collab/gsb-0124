#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb, latestMappingVersion } from './db.js';
import { createProduct, createStore, effectiveBaskets, importTransaction, createMappingVersion } from './services.js';
import { compareStores, freezeReport, backtest, runAnalysis } from './analysis.js';
import { generateTransactions } from './generator.js';
import { startApi } from './api.js';
import { runDemo } from './demo.js';

const args = process.argv.slice(2);
const command = args.shift();
const dbPath = process.env.SHOPPER_DB ?? resolve('data/app.sqlite');
const db = openDb(dbPath);
let cliOwnsDb = true;

main().catch(err => {
  console.error(JSON.stringify({ error: { code: err.code ?? 'CLI_ERROR', message: err.message } }));
  process.exitCode = 1;
}).finally(() => {
  if (command !== 'serve' && cliOwnsDb) db.close();
});

async function main() {
  switch (command) {
    case 'init': init(); break;
    case 'import:transactions': await importTransactions(); break;
    case 'generate': generate(); break;
    case 'mapping': mapping(); break;
    case 'mine': mineCli(); break;
    case 'explain': explain(); break;
    case 'compare': compare(); break;
    case 'freeze': freeze(); break;
    case 'backtest': backtestCli(); break;
    case 'serve': await serve(); break;
    case 'demo':
      db.close();
      cliOwnsDb = false;
      await runDemo(dbPath);
      break;
    default: console.log('commands: init, generate, mapping, import:transactions, mine, explain, compare, freeze, backtest, serve, demo');
  }
}

function option(name: string): string | undefined {
  const index = args.findIndex(x => x === `--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}
function count(sql: string) {
  return Number((db.prepare(sql).get() as { n: number }).n);
}
function status(label: string) {
  console.log(`[${label}] stores=${count('SELECT COUNT(*) n FROM stores')} products=${count('SELECT COUNT(*) n FROM products')} tx=${count('SELECT COUNT(*) n FROM transactions')} effective=${effectiveBaskets(db, {}).length} refunds=${count('SELECT COUNT(*) n FROM refunds')} reports=${count('SELECT COUNT(*) n FROM frozen_reports')}`);
}
function init() {
  status('before');
  for (const id of ['S1', 'S2']) createStore(db, id, id === 'S1' ? 'Downtown' : 'Riverside');
  for (const id of ['bread', 'butter', 'milk', 'cereal', 'coffee', 'tea', 'sugar', 'diaper', 'beer']) createProduct(db, id, id[0].toUpperCase() + id.slice(1));
  status('after');
}
function mapping() {
  const file = option('file');
  const aliases = file ? JSON.parse(readFileSync(file, 'utf8')) : JSON.parse(option('aliases') ?? '[]');
  const before = latestMappingVersion(db);
  const id = createMappingVersion(db, aliases, option('note') ?? 'CLI mapping');
  console.log(`mapping version: ${before} -> ${id}`);
}
function generate() {
  status('before');
  const txs = generateTransactions({
    count: Number(option('count') ?? 80),
    start: option('start') ?? '2026-01-01T00:00:00Z',
    end: option('end') ?? '2026-02-01T00:00:00Z',
    stores: (option('stores') ?? 'S1,S2').split(','),
    seed: Number(option('seed') ?? 42)
  });
  let inserted = 0;
  for (const tx of txs) if (importTransaction(db, tx).inserted) inserted++;
  console.log(`generated=${txs.length} inserted=${inserted}`);
  status('after');
}
async function importTransactions() {
  const file = option('file');
  if (!file) throw new Error('--file is required');
  const rows = JSON.parse(readFileSync(file, 'utf8'));
  status('before');
  let inserted = 0;
  for (const row of rows) if (importTransaction(db, row).inserted) inserted++;
  console.log(`submitted=${rows.length} inserted=${inserted} duplicate=${rows.length - inserted}`);
  status('after');
}
function mineParams() {
  return {
    minSupport: Number(option('min-support') ?? 0.05),
    minConfidence: Number(option('min-confidence') ?? 0.5),
    maxCandidates: Number(option('max-candidates') ?? 100000),
    storeId: option('store'),
    start: option('start'),
    end: option('end'),
    asOf: option('as-of')
  };
}
function mineCli() {
  const result = runAnalysis(db, mineParams());
  console.log(JSON.stringify({
    batchId: result.batchId,
    denominator: result.denominator,
    incomplete: result.truncationReason ? true : result.incomplete,
    truncationReason: result.truncationReason,
    itemsets: result.itemsets.slice(0, Number(option('limit') ?? 20)),
    rules: result.rules.slice(0, Number(option('limit') ?? 20))
  }, null, 2));
}
function explain() {
  const batch = db.prepare('SELECT parameters_json FROM analysis_batches WHERE id=?').get(Number(option('batch'))) as { parameters_json: string } | undefined;
  if (!batch) throw new Error('batch not found');
  const result = runAnalysis(db, JSON.parse(batch.parameters_json));
  const rule = result.rules[Number(option('rule-index') ?? 0)];
  if (!rule) throw new Error('no rule at index');
  const matching = result.baskets.filter(b => [...rule.antecedent, ...rule.consequent].every(x => b.items.includes(x)));
  console.log(JSON.stringify({ ...rule, denominator: result.denominator, samples: matching.map(b => ({ transactionId: b.transactionId, items: b.items })) }, null, 2));
}
function compare() {
  const stores = (option('stores') ?? 'S1,S2').split(',');
  console.log(JSON.stringify(compareStores(db, mineParams(), stores).map(x => ({
    storeId: x.storeId, denominator: x.denominator, incomplete: x.incomplete,
    rules: x.rules.slice(0, 5)
  })), null, 2));
}
function freeze() {
  const result = runAnalysis(db, mineParams());
  const batchId = Number(option('batch') ?? result.batchId);
  const id = freezeReport(db, {
    name: option('name') ?? `report-${Date.now()}`,
    batchId,
    trainStart: option('start')!,
    trainEnd: option('end')!,
    rules: result.rules,
    ...mineParams(),
    mappingVersionId: latestMappingVersion(db)
  });
  console.log(`frozen report ${id} from ${result.rules.length} rules; incomplete=${result.incomplete}`);
}
function backtestCli() {
  console.log(JSON.stringify(backtest(db, Number(option('report')!), option('validation-start')!, option('validation-end')!, option('as-of')), null, 2));
}
async function serve() {
  const { server, port } = await startApi(db, Number(process.env.PORT ?? 0));
  console.log(JSON.stringify({ listening: '127.0.0.1', port, db: dbPath }));
  const shutdown = () => { server.close(() => { db.close(); process.exit(0); }); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

