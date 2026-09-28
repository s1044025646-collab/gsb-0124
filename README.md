# Shopping Basket Association Analysis

Windows-local TypeScript/Node.js backend for fictitious retail baskets. It provides an HTTP JSON API, CLI, deterministic synthetic transaction generator, SQLite persistence, frozen reports, later-period backtests, and automated tests. There is no web UI, coupon engine, payment integration, or real merchant connection.

## Requirements

- Windows PowerShell
- Node.js 25.x with the built-in `node:sqlite` module
- npm

All database and temporary files are written under this project's `data/` directory. The HTTP server binds only to `127.0.0.1` and uses an ephemeral port unless `PORT` is set.

## Install, Test, Demo

```powershell
npm install
npm test
npm run demo
```

`npm test` runs TypeScript compilation and the Node built-in test runner. The demo is deterministic and repeatable: it rebuilds `data/app.sqlite`, creates training and validation data, records a refund and void, freezes training rules, and evaluates them only in the later validation period.

## Start And Stop

```powershell
npm start
```

The startup line is JSON containing the selected local port, for example:

```json
{"listening":"127.0.0.1","port":53124,"db":"E:\\GSB\\0124\\A\\data\\app.sqlite"}
```

Stop that foreground process with `Ctrl+C`. If you start it yourself in PowerShell and capture the PID, stop only that PID:

```powershell
$p = Start-Process node -ArgumentList '--experimental-sqlite','dist/src/cli.js','serve' -PassThru
Stop-Process -Id $p.Id
```

## CLI Workflow

```powershell
npm run build
node --experimental-sqlite dist/src/cli.js init
node --experimental-sqlite dist/src/cli.js mapping --file examples/aliases.json --note "v1"
node --experimental-sqlite dist/src/cli.js import:transactions --file examples/transactions.json
node --experimental-sqlite dist/src/cli.js generate --count 200 --seed 42 --stores S1,S2
node --experimental-sqlite dist/src/cli.js mine --min-support 0.05 --min-confidence 0.5 --max-candidates 100000 --start 2026-01-01T00:00:00Z --end 2026-02-01T00:00:00Z
node --experimental-sqlite dist/src/cli.js explain --batch 1 --rule-index 0
node --experimental-sqlite dist/src/cli.js compare --stores S1,S2 --start 2026-01-01T00:00:00Z --end 2026-02-01T00:00:00Z
node --experimental-sqlite dist/src/cli.js freeze --name january --batch 1 --start 2026-01-01T00:00:00Z --end 2026-02-01T00:00:00Z
node --experimental-sqlite dist/src/cli.js backtest --report 1 --validation-start 2026-02-01T00:00:00Z --validation-end 2026-03-01T00:00:00Z
```

State-changing CLI commands print before/after counts for stores, products, transactions, effective baskets, refunds, and frozen reports. `SHOPPER_DB=data/custom.sqlite` selects a project-local database.

## Basket Semantics

- Each transaction contributes one set to a period denominator.
- Quantity and repeated identical SKU lines do not increase support; the item is either present or absent.
- A partial refund removes an item only when cumulative refunded quantity reaches purchased quantity.
- A fully voided transaction is removed from every current effective basket.
- `asOf` ignores later refunds and later voids, enabling late-arriving-event analysis.
- Refunds and voids after an analysis create a new analytical state; they never mutate a frozen report.
- New product-mapping versions re-interpret historical SKUs while old frozen reports retain their selected mapping version.
- Empty denominators return `null` confidence/lift and never fabricate metrics.
- Candidate generation is budgeted. If the cap is reached, `incomplete: true` and `truncationReason` are set and such a batch cannot be frozen as complete.

Support is `|A∪B transactions| / denominator`; confidence is `support(A∪B) / support(A)`; lift is `P(A∪B) / (P(A)P(B))`.

## API

JSON request and response bodies use explicit error codes: `INVALID_JSON`, `INVALID_MIN_SUPPORT`, `INVALID_MIN_CONFIDENCE`, `INVALID_MAX_CANDIDATES`, `UNMAPPED_SKU`, `UNKNOWN_STORE`, `REFUND_EXCEEDS_QTY`, `INCOMPLETE_BATCH`, `FUTURE_LEAK`, `NOT_FOUND`, and related validation/conflict codes.

- `GET /health`
- `POST /products`, `GET /products?limit=&cursor=`
- `POST /stores`, `GET /stores?limit=&cursor=`
- `POST /mappings`
- `POST /transactions` (idempotency key defaults to `tx:<transactionId>`)
- `GET /transactions?storeId=`
- `POST /refunds`, `POST /voids`
- `GET /baskets?storeId=&start=&end=&asOf=&mappingVersionId=`
- `POST /analyses`
- `POST /reports/{batchId}/freeze`
- `POST /reports/{reportId}/backtest`
- `POST /compare-stores`

Example:

```powershell
Invoke-RestMethod http://127.0.0.1:PORT/analyses -Method Post -ContentType 'application/json' -Body '{"minSupport":0.05,"minConfidence":0.5,"maxCandidates":100000,"start":"2026-01-01T00:00:00Z","end":"2026-02-01T00:00:00Z"}'
```

## Tests Cover

Duplicate/quantity-collapsed lines, exhaustive small-data verification, partial refunds, full voids, late events and `asOf`, empty baskets, time boundaries, very low frequency items, strong and misleading confidence, candidate limits, future-leak prevention, mapping changes, idempotent imports, rollback, store comparison inputs, repeatable demo, and persistence across reopening SQLite.

## Repeatable Migrations

`CREATE TABLE IF NOT EXISTS` and `INSERT OR IGNORE` make migration execution repeatable. Opening an existing database applies no destructive changes.
