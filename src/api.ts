import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { createMappingVersion, createProduct, createStore, effectiveBaskets, importTransaction, listPaginated, refundLine, voidTransaction } from './services.js';
import { backtest, compareStores, freezeReport, runAnalysis } from './analysis.js';
import { ApiError } from './types.js';
import { latestMappingVersion } from './db.js';

export function createApi(db: DatabaseSync): Server {
  return createServer((req, res) => handle(req, res, db).catch(err => sendError(res, err)));
}

export async function startApi(db: DatabaseSync, preferredPort = 0): Promise<{ server: Server; port: number }> {
  const server = createApi(db);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(preferredPort, '127.0.0.1', resolve);
  });
  return { server, port: (server.address() as { port: number }).port };
}

async function handle(req: IncomingMessage, res: ServerResponse, db: DatabaseSync) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const route = `${req.method} ${url.pathname}`;
  const body = await readJson(req);
  const query = Object.fromEntries(url.searchParams);

  if (route === 'GET /health') return sendJson(res, { ok: true });
  if (route === 'POST /products') { createProduct(db, body.id, body.name); return sendJson(res, { id: body.id }, 201); }
  if (route === 'GET /products') return sendJson(res, listPaginated(db, 'SELECT id,name,created_at as createdAt FROM products', [], limit(query), query.cursor ?? null));
  if (route === 'POST /stores') { createStore(db, body.id, body.name); return sendJson(res, { id: body.id }, 201); }
  if (route === 'GET /stores') return sendJson(res, listPaginated(db, 'SELECT id,name,created_at as createdAt FROM stores', [], limit(query), query.cursor ?? null));
  if (route === 'POST /mappings') {
    const id = createMappingVersion(db, body.aliases ?? [], body.note ?? '');
    return sendJson(res, { mappingVersionId: id }, 201);
  }
  if (route === 'POST /transactions') {
    const result = importTransaction(db, body);
    return sendJson(res, result, result.inserted ? 201 : 200);
  }
  if (route === 'GET /transactions') {
    const params: any[] = [];
    let where = '';
    if (query.storeId) { where = 'store_id = ?'; params.push(query.storeId); }
    const rows = db.prepare(`SELECT id,store_id AS storeId,tx_time AS time,voided_at AS voidedAt FROM transactions ${where ? `WHERE ${where}` : ''} ORDER BY id`).all(...params);
    return sendJson(res, { data: rows.slice(0, limit(query)), nextCursor: null });
  }
  if (route === 'POST /refunds') {
    refundLine(db, body.transactionId, body.lineRef, body.quantity, body.time, body.reason ?? '');
    return sendJson(res, { ok: true }, 201);
  }
  if (route === 'POST /voids') { voidTransaction(db, body.transactionId, body.time); return sendJson(res, { ok: true }); }
  if (route === 'GET /baskets') return sendJson(res, effectiveBaskets(db, query));
  if (route === 'POST /analyses') {
    const result = runAnalysis(db, normalizeMine(body));
    return sendJson(res, result, 201);
  }
  if (route === 'GET /analyses') {
    const rows = db.prepare('SELECT id,created_at AS createdAt,parameters_json AS parameters,incomplete,truncation_reason AS truncationReason FROM analysis_batches ORDER BY id DESC LIMIT ?').all(limit(query));
    return sendJson(res, { data: rows.map(parseParameters), nextCursor: null });
  }
  if (route === 'GET /reports') {
    const rows = db.prepare('SELECT id,batch_id AS batchId,name,mapping_version_id AS mappingVersionId,train_start AS trainStart,train_end AS trainEnd,min_support AS minSupport,min_confidence AS minConfidence,max_candidates AS maxCandidates,selected_rules_json AS selectedRules,created_at AS createdAt FROM frozen_reports ORDER BY id DESC LIMIT ?').all(limit(query));
    return sendJson(res, { data: rows.map(parseRules), nextCursor: null });
  }
  if (route === 'GET /backtests') {
    const rows = db.prepare('SELECT id,report_id AS reportId,validation_start AS validationStart,validation_end AS validationEnd,as_of AS asOf,denominator,results_json AS results,created_at AS createdAt FROM backtests ORDER BY id DESC LIMIT ?').all(limit(query));
    return sendJson(res, { data: rows.map(parseResults), nextCursor: null });
  }
  if (route.startsWith('POST /reports/') && route.endsWith('/freeze')) {
    const reportId = freezeReport(db, {
      name: body.name,
      batchId: Number(url.pathname.split('/')[2]),
      trainStart: body.trainStart,
      trainEnd: body.trainEnd,
      rules: body.rules,
      minSupport: Number(body.minSupport),
      minConfidence: Number(body.minConfidence),
      maxCandidates: Number(body.maxCandidates),
      mappingVersionId: Number(body.mappingVersionId ?? latestMappingVersion(db))
    });
    return sendJson(res, { reportId }, 201);
  }
  if (route.startsWith('POST /reports/') && route.endsWith('/backtest')) {
    return sendJson(res, backtest(db, Number(url.pathname.split('/')[2]), body.validationStart, body.validationEnd, body.asOf), 201);
  }
  if (route === 'POST /compare-stores') {
    return sendJson(res, compareStores(db, normalizeMine(body), body.storeIds));
  }
  throw new ApiError(404, 'NOT_FOUND', `unknown route ${route}`);
}

function normalizeMine(body: any) {
  return {
    minSupport: Number(body.minSupport),
    minConfidence: Number(body.minConfidence),
    maxCandidates: Number(body.maxCandidates ?? 100000),
    storeId: body.storeId,
    start: body.start,
    end: body.end,
    asOf: body.asOf,
    mappingVersionId: body.mappingVersionId,
    includeSamples: body.includeSamples ?? true,
    sampleSize: body.sampleSize
  };
}

async function readJson(req: IncomingMessage): Promise<any> {
  if (req.method === 'GET') return {};
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    if (Buffer.concat(chunks).length > 2_000_000) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'request body exceeds 2MB');
  }
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON'); }
}

function limit(query: Record<string, string>): number {
  const value = Number(query.limit ?? 50);
  if (!Number.isInteger(value) || value < 1 || value > 200) throw new ApiError(400, 'INVALID_LIMIT', 'limit must be 1..200');
  return value;
}

function sendJson(res: ServerResponse, value: unknown, status = 200): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendError(res: ServerResponse, err: unknown): void {
  const api = err instanceof ApiError ? err : new ApiError(500, 'INTERNAL_ERROR', String((err as Error).message ?? err));
  sendJson(res, { error: { code: api.code, message: api.message } }, api.status);
}

function parseParameters(row: any) {
  return { ...row, parameters: JSON.parse(row.parameters) };
}
function parseRules(row: any) {
  return { ...row, selectedRules: JSON.parse(row.selectedRules) };
}
function parseResults(row: any) {
  return { ...row, results: JSON.parse(row.results) };
}


