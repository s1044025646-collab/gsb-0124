import type { DatabaseSync } from 'node:sqlite';
import { effectiveBaskets } from './services.js';
import { mine } from './mining.js';
import { ApiError, type MineParams, type RuleResult } from './types.js';

export function runAnalysis(db: DatabaseSync, params: MineParams) {
  const baskets = effectiveBaskets(db, params);
  const result = mine(baskets, params);
  const info = db.prepare('INSERT INTO analysis_batches(parameters_json,incomplete,truncation_reason) VALUES(?,?,?)')
    .run(JSON.stringify({ ...params, sampleSize: params.sampleSize ?? 20 }), result.incomplete ? 1 : 0, result.truncationReason);
  return { batchId: Number(info.lastInsertRowid), ...result };
}

export function freezeReport(db: DatabaseSync, input: {
  name: string;
  batchId: number;
  trainStart: string;
  trainEnd: string;
  rules: RuleResult[];
  minSupport: number;
  minConfidence: number;
  maxCandidates: number;
  mappingVersionId: number;
}) {
  if (!input.name || !/^[A-Za-z0-9_.:-]{1,80}$/.test(input.name)) throw new ApiError(400, 'INVALID_REPORT_NAME', 'name allows 1..80 letters, numbers and _.:-');
  const batch = db.prepare('SELECT * FROM analysis_batches WHERE id=?').get(input.batchId) as { incomplete: number } | undefined;
  if (!batch) throw new ApiError(404, 'BATCH_NOT_FOUND', 'analysis batch not found');
  if (batch.incomplete) throw new ApiError(409, 'INCOMPLETE_BATCH', 'cannot freeze rules from a candidate-truncated batch as a complete discovery');
  if (!Array.isArray(input.rules) || input.rules.length === 0) throw new ApiError(400, 'NO_RULES', 'select at least one rule');
  for (const rule of input.rules) {
    const antecedent = new Set(rule.antecedent);
    if (rule.antecedent.length === 0 || rule.consequent.length === 0 || rule.consequent.some(x => antecedent.has(x))) throw new ApiError(400, 'INVALID_RULE', 'rule sides must be non-empty and disjoint');
  }
  try {
    const info = db.prepare(`INSERT INTO frozen_reports
      (batch_id,name,mapping_version_id,train_start,train_end,min_support,min_confidence,max_candidates,selected_rules_json)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(
      input.batchId, input.name, input.mappingVersionId, new Date(input.trainStart).toISOString(),
      new Date(input.trainEnd).toISOString(), input.minSupport, input.minConfidence, input.maxCandidates, JSON.stringify(input.rules)
    );
    return Number(info.lastInsertRowid);
  } catch (err) {
    if (String((err as { code?: string }).code).includes('SQLITE_CONSTRAINT_UNIQUE')) throw new ApiError(409, 'REPORT_EXISTS', 'frozen report name already exists');
    throw err;
  }
}

export function backtest(db: DatabaseSync, reportId: number, validationStart: string, validationEnd: string, asOf?: string) {
  const report = db.prepare('SELECT * FROM frozen_reports WHERE id=?').get(reportId) as FrozenReportRow | undefined;
  if (!report) throw new ApiError(404, 'REPORT_NOT_FOUND', 'frozen report not found');
  const start = new Date(validationStart);
  const end = new Date(validationEnd);
  if (Number.isNaN(+start) || Number.isNaN(+end) || start >= end) throw new ApiError(400, 'INVALID_VALIDATION_WINDOW', 'validation start must precede end');
  if (start < new Date(report.train_end)) throw new ApiError(400, 'FUTURE_LEAK', 'validation window cannot overlap training; start must be at or after training end');
  const rules = JSON.parse(report.selected_rules_json) as RuleResult[];
  const baskets = effectiveBaskets(db, { start: validationStart, end: validationEnd, asOf, mappingVersionId: report.mapping_version_id });
  const denominator = baskets.length;
  const results = rules.map(rule => evaluateRule(rule, baskets, denominator));
  const info = db.prepare(`INSERT INTO backtests(report_id,validation_start,validation_end,as_of,denominator,results_json)
    VALUES(?,?,?,?,?,?)`).run(reportId, start.toISOString(), end.toISOString(), asOf ? new Date(asOf).toISOString() : new Date().toISOString(), denominator, JSON.stringify(results));
  return { backtestId: Number(info.lastInsertRowid), reportId, denominator, results };
}

export function compareStores(db: DatabaseSync, params: MineParams, storeIds: string[]) {
  if (!Array.isArray(storeIds) || storeIds.length < 2) throw new ApiError(400, 'INVALID_STORES', 'provide at least two store IDs');
  return storeIds.map(storeId => {
    const baskets = effectiveBaskets(db, { ...params, storeId });
    return { storeId, ...mine(baskets, params) };
  });
}

export function evaluateRule(rule: RuleResult, baskets: { items: string[]; transactionId: string }[], denominator: number) {
  const antecedent = new Set(rule.antecedent);
  const consequent = new Set(rule.consequent);
  let antecedentCount = 0, bothCount = 0, consequentCount = 0;
  const samples: string[] = [];
  for (const basket of baskets) {
    const items = new Set(basket.items);
    const hasA = rule.antecedent.every(x => items.has(x));
    const hasB = rule.consequent.every(x => items.has(x));
    if (hasA) antecedentCount++;
    if (hasB) consequentCount++;
    if (hasA && hasB) {
      bothCount++;
      if (samples.length < 20) samples.push(basket.transactionId);
    }
  }
  return {
    antecedent: rule.antecedent,
    consequent: rule.consequent,
    supportCount: bothCount,
    support: denominator === 0 ? null : bothCount / denominator,
    confidence: antecedentCount === 0 ? null : bothCount / antecedentCount,
    lift: denominator === 0 || antecedentCount === 0 || consequentCount === 0 ? null :
      (bothCount / denominator) / ((antecedentCount / denominator) * (consequentCount / denominator)),
    antecedentCount,
    consequentCount,
    sampleTransactionIds: samples
  };
}

interface FrozenReportRow { id: number; train_end: string; selected_rules_json: string; mapping_version_id: number; }

