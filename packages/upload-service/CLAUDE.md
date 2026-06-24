# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is the **AR.IO Bundler Upload Service**, a microservice that accepts incoming
data uploads — single-request or multipart — and bundles [ANS-104](https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-104.md)
data items for reliable delivery to Arweave. It integrates with the sibling
`payment-service` for credit management and blockchain/x402 payments.

Data items can be signed by clients with Arweave, Ethereum, or Solana keys, or
(for unsigned/x402 uploads) signed by the bundler's own server wallet.

> This service is a de-AWS fork of ArDrive's Turbo Upload Service. The original
> design ran on AWS (SQS queues, Lambda/ECS workers, DynamoDB offsets, S3). **That
> is no longer the architecture.** The current stack is BullMQ workers (Redis),
> PM2 processes, PostgreSQL (including data-item offsets), and S3-compatible
> MinIO. Comments mentioning SQS/Lambda/DynamoDB in the source are legacy markers,
> not live behavior.

## Common Commands

Run from `packages/upload-service/` (or via `yarn workspace @ar-io-bundler/upload-service <script>` from the repo root).

```bash
# Setup
yarn                            # Install dependencies (Node 22 required)
yarn build                      # Clean and compile TypeScript to lib/

# Database (Knex, two reader/writer connections)
yarn db:up                      # Start PostgreSQL in Docker and run migrations
yarn db:down                    # Stop and remove the database container/volume
yarn db:migrate:latest          # Run all migrations
yarn db:migrate:rollback        # Roll back the last migration
yarn db:migrate:new MIGRATION_NAME  # Generate a new migration file
yarn db:migrate:list            # List applied migrations

# Development
yarn start:watch                # Hot reload via nodemon (loads .env)
yarn start                      # Run the compiled service (lib/index.js)

# Testing (Mocha + nyc)
yarn test:unit                  # Unit tests (src/**/*.test.ts)
yarn test:integration:local     # Integration tests (brings up infra, runs under .env.test)
yarn test:integration:local -g "Router"  # Targeted integration tests
yarn test:e2e:local             # End-to-end tests (tests/e2e-*.test.ts) against local infra
yarn test:docker                # Full suite in an isolated container

# Code Quality
yarn lint:check / yarn lint:fix
yarn format:check / yarn format:fix
yarn typecheck
```

> Note: `yarn db:migrate:new` chains `&& yarn prettier:fix`, but the package's
> Prettier script is named `format:fix`, so the final step errors. The migration
> file is still generated; just run `yarn format:fix` yourself afterward.

## Architecture Patterns

### Dependency Injection via the Architecture object

The service injects dependencies through a centralized `Architecture` interface
(`src/arch/architecture.ts`). The concrete `defaultArchitecture` is built in the
same file and used by the API and workers.

```typescript
interface Architecture {
  objectStore: ObjectStore;               // S3 client → MinIO (getS3ObjectStore())
  database: Database;                      // PostgresDatabase (reader/writer knex)
  dataItemOffsetsDB: DataItemOffsetsDB;    // offsets live in PostgreSQL
  cacheService: CacheService;              // Redis via getElasticacheService()
  paymentService: PaymentService;          // TurboPaymentService → payment-service
  x402Service: X402Service;
  logger: winston.Logger;
  arweaveGateway: ArweaveGateway;          // reads/verification via ARWEAVE_GATEWAY
  getArweaveWallet: () => Promise<JWKInterface>;       // bundle signing
  getRawDataItemWallet: () => Promise<JWKInterface>;   // signs unsigned/raw uploads
  tracer?: Tracer;                         // OpenTelemetry (optional)
}
```

### Object storage

`src/arch/objectStore.ts` defines the `ObjectStore` interface (put/get/head/move/
delete + multipart). Two implementations exist:
- `S3ObjectStore` (`src/arch/s3ObjectStore.ts`) — uses `@aws-sdk/client-s3`
  pointed at **MinIO** via `S3_ENDPOINT` (with `S3_FORCE_PATH_STYLE`). This is
  what `defaultArchitecture.objectStore` always wires (`getS3ObjectStore()`).
- `FileSystemObjectStore` (`src/arch/fileSystemObjectStore.ts`) — a filesystem
  implementation; `deleteObject` is an unimplemented stub here, so the tiered
  cleanup system relies on the S3 path.

Local/dev uses the S3 path against MinIO, **not** `FileSystemObjectStore`.

### Database management with Knex

Knex.js handles migrations and queries, with separate reader/writer connections
(`src/arch/db/knexConfig.ts`). Pool sizing is tunable via `DB_POOL_MIN`/
`DB_POOL_MAX` (defaults 5/50). The database name comes from `UPLOAD_DB_DATABASE`
(default `upload_service`).

**Migration workflow:**
1. Add migration logic to `src/arch/db/migrator.ts` (NOT in the generated file).
2. Generate the migration file: `yarn db:migrate:new MIGRATION_NAME`.
3. Update the generated file in `src/migrations/` to call your migrator function.
4. Apply it: `yarn db:migrate:latest`.

Never write SQL directly in the generated migration files.

### Router and routes

Koa with a router (`src/router.ts`) delegating to handlers in `src/routes/`. Routes
are served at both the root and a `/v1` prefix.

- `dataItemPost.ts` — single ANS-104 data-item uploads (`POST /tx`, `POST /tx/:token`),
  plus the signed x402 upload routes (`POST /x402/upload/signed`, `/x402/data-item/signed`)
- `rawDataPost.ts` — **unsigned/raw** x402 uploads (`POST /x402/upload/unsigned`):
  the bundler signs the ANS-104 item with its own wallet
- `multiPartUploads.ts` — multipart flow (create / get / status / post-chunk /
  finalize), served under `/chunks/:token/...`
- `x402Pricing.ts` — x402 price quotes (`GET /price/x402/data-item/:token/:byteCount`,
  `GET /price/x402/data/:token/:byteCount`)
- `status.ts` — data-item status (`GET /tx/:id/status`)
- `offsets.ts` — data-item offsets (`GET /tx/:id/offsets`)
- `info.ts` — service info (`GET /` and `GET /info`); also `/health`,
  `/bundler_metrics`, `/openapi.json`, `/api-docs`
- `swagger.ts` — OpenAPI document

### Asynchronous job pipeline (BullMQ)

The fulfillment pipeline runs as BullMQ workers (Redis), defined in
`src/workers/allWorkers.ts` and managed by PM2 (the `upload-workers` process, fork
mode, single instance). Queue names are the `jobLabels` in `src/constants.ts`.
Jobs are enqueued via `enqueue()` / `enqueueBatch()` in `src/arch/queues.ts`.

**14 queues** (the `allWorkers` array is the source of truth):

| Queue (`jobLabel`) | Handler (`src/jobs/`) | Concurrency |
|--------------------|-----------------------|-------------|
| `new-data-item`    | `newDataItemBatchInsert.ts` | 5 |
| `plan-bundle`      | `plan.ts`             | `PLAN_WORKER_CONCURRENCY` (**1**, overlap guard) |
| `prepare-bundle`   | `prepare.ts`          | `PREPARE_WORKER_CONCURRENCY` (3) |
| `post-bundle`      | `post.ts`             | `POST_WORKER_CONCURRENCY` (2) |
| `seed-bundle`      | `seed.ts`             | 2 |
| `verify-bundle`    | `verify.ts`           | `VERIFY_WORKER_CONCURRENCY` (3) |
| `optical-post`     | `optical-post.ts`     | 5 |
| `put-offsets`      | `putOffsets.ts`       | 5 |
| `unbundle-bdi`     | `unbundle-bdi.ts`     | 2 |
| `finalize-upload`  | `multiPartUploads.ts` (`finalizeMultipartUpload`) | 3 |
| `cleanup-fs`       | `cleanup-fs.ts`       | 1 |
| `redrive-posted`   | `redrive-posted.ts`   | 1 |
| `refund-balance`   | `allWorkers.ts` (`TurboPaymentService.refundBalanceForData`) | 3 |
| `broadcast-chunks` | `broadcast-chunks.ts` | `BROADCAST_CHUNKS_WORKER_CONCURRENCY` (10) |

**Core bundle flow:** `new-data-item → plan-bundle → prepare-bundle → post-bundle
→ seed-bundle → verify-bundle`. `optical-post`, `put-offsets`, `finalize-upload`,
`unbundle-bdi`, `cleanup-fs`, `redrive-posted`, `refund-balance`, and
`broadcast-chunks` run alongside.

- `plan.ts` groups pending data items into bundle plans by size/feature type.
- `prepare.ts` assembles the ANS-104 bundle from object storage.
- `post.ts` posts the bundle to Arweave; `seed.ts` prepares + stages the bundle's
  chunks and enqueues a `broadcast-chunks` job per chunk; `verify.ts` confirms.
- `broadcast-chunks.ts` POSTs one staged chunk to one of `AR_IO_NODE_URLS`
  (shuffled, per-node retry + failover via `broadcastChunkToArioNode`), then
  best-effort deletes the staged bytes. Unset `AR_IO_NODE_URLS` → single
  `ARWEAVE_UPLOAD_NODE`. Metric `chunk_seed_post_total{endpoint,result}`.
- `optical-post.ts` posts data-item headers to the AR.IO Gateway optical bridge
  for optimistic caching (`OPTICAL_BRIDGE_URL`).
- `putOffsets.ts` writes data-item offsets to PostgreSQL (for retrieval).
- `unbundle-bdi.ts` unbundles nested bundle data items (BDIs). Its optical fan-out
  for a BDI's children is enqueued in batches (`enqueueBatch`/BullMQ `addBulk`,
  `BDI_OPTICAL_FAN_OUT_BATCH_SIZE` default 50) so a large BDI can't flood the
  optical queue with one job per child.
- `cleanup-fs.ts` runs the tiered-retention cleanup (see below).

### Optimistic surfaces (gateway warming) — enable-matrix

Three INDEPENDENT, strictly **best-effort** pushes warm the AR.IO gateway *before*
a bundle mines. Each is separately gated, fired detached, and emits its own
metric. **None may ever block or fail the upload or the on-chain bundle post**,
and the default-off ones leave behavior unchanged until flipped on.

| # | What | Where | Gate (default) | Detached | Metric |
|---|------|-------|----------------|----------|--------|
| 1 | Data-item headers | `optical-post.ts` (enqueued from `prepare`/`unbundle-bdi`) | `OPTICAL_BRIDGING_ENABLED` != "false" (**ON**) | worker; throws→BullMQ retry w/ backoff, honors 429/5xx | `*_optical_failure_count`, circuit-breaker gauges |
| 2 | Bundle-tx header | `ArweaveGateway.postBundleTxToOptimisticTxQueue` (fired from `post.ts`) | `OPTIMISTIC_TX_BRIDGE_ENABLED` == "true" (**OFF**) | `void`, single attempt, no retry | `optimistic_tx_post_total{result=indexed\|error\|disabled\|skipped}` + `optimistic_tx_post_duration_seconds` |
| 3 | Bundle chunks (cache) | `ArweaveInterface.pushChunksToGatewayCache` (fired from `seed.ts`) | `CHUNK_CACHE_BRIDGE_ENABLED` == "true" (**OFF**) | `void`, swallows errors | `chunk_cache_bridge_total{result=cached\|error\|disabled}` |

Design decisions:
- **Seeding is separate from surface 3.** Seeding broadcasts each chunk to real
  AR.IO chunk-distributor nodes (`AR_IO_NODE_URLS`, via the `broadcast-chunks`
  queue; unset → the single `ARWEAVE_UPLOAD_NODE`) so on-chain landing never
  depends on the read gateway supporting `/chunk` or being healthy. Surface 3 is
  an *additional* best-effort push to the read gateway's `/chunk` cache
  (`ARWEAVE_GATEWAY`); it never affects seeding.
- **Surface 2 URL hardening.** The endpoint is read from explicit
  `OPTIMISTIC_TX_BRIDGE_URL` first, falling back to deriving it from
  `OPTICAL_BRIDGE_URL` (`…/queue-data-item` → `…/queue-optimistic-tx`). If neither
  yields a usable endpoint the surface logs and increments
  `result=skipped` instead of silently no-op'ing. Surfaces 2 and 3 require
  `AR_IO_ADMIN_KEY` where they hit the admin API.
- **`post.ts` keeps the critical path lean.** Both `postBundleTxToOptimisticTxQueue`
  (surface 2) and the non-essential admin `queue-bundle` push
  (`postBundleTxToAdminQueue`) are fired `void`-detached — neither is inside the
  awaited `Promise.all` with `postBundleTx`, so a slow/retrying gateway can't add
  latency to the on-chain post.

**Internal job schedulers (no cron needed):** at startup the worker process
(`src/workers/allWorkers.ts`) registers three BullMQ job schedulers via
`upsertRepeatable()` (`src/arch/queues.ts`):
- `plan-bundle` — `PLAN_SCHEDULE_CRON` (default `*/5 * * * *`)
- `cleanup-fs` — `CLEANUP_SCHEDULE_CRON` (default `0 2 * * *`)
- `redrive-posted` — `POSTED_REDRIVE_SCHEDULE_CRON` (default `*/10 * * * *`)

**`posted_bundle` recovery (`redrive-posted.ts`):** the bundle pipeline's one
dead-end was `posted_bundle` — a bundle whose tx header posted but whose
`seed-bundle` job then exhausted its retries had no re-driver (unlike
`seeded_bundle`, which `verify` re-scans every tick). The `redrive-posted`
scheduler re-enqueues seeding for `posted_bundle` rows older than
`POSTED_STALE_THRESHOLD_MS` (default 30 min, past the seed job's own backoff);
after `MAX_SEED_REDRIVES` (default 5) it demotes the bundle to `failed_bundle`
(items repacked to `new_data_item`) and emits `posted_bundle_failed_to_seed_total`
so the stall is loud, not silent. Attempt counts live in the `posted_bundle_redrive`
table.

This replaced the external `cron-trigger-*.sh` crons, which were a silent-failure
footgun (a cron never registered, or one that couldn't find `node` on cron's
minimal PATH, meant nothing bundled). BullMQ dedupes each schedule by id in the
shared queue Redis, so exactly one job fires per interval — no leader election
needed even if the worker ever runs multi-instance/multi-box. Set a pattern to
`""` to disable that schedule.

- **Overlap guard:** `planBundleHandler` is a self-draining loop that can run up
  to ~14 min (`plan.ts`). A fixed wall-clock tick can fire while a prior drain is
  still active, so the `plan-bundle` worker runs at concurrency 1 (`PLAN_WORKER_CONCURRENCY`
  default 1) — a queued tick waits its turn instead of scanning in parallel.
- **Teardown:** schedulers persist in Redis. To stop one, set its
  `*_SCHEDULE_CRON` to `""` and restart, or call
  `getQueue(label).removeJobScheduler(id)` — reverting the code alone leaves the
  schedule firing.
- `cron-trigger-plan.sh` / `cron-trigger-cleanup.sh` (and their `trigger-*.js`)
  remain as **manual** on-demand triggers; they no longer belong in crontab.

### Tiered data cleanup

Once data is permanent on Arweave, local copies can age out:

```
Data Age                                  Filesystem    MinIO/S3
0 .. FILESYSTEM_CLEANUP_DAYS (7)          Keep          Keep
FILESYSTEM_CLEANUP_DAYS .. MINIO_CLEANUP_DAYS (90)  DELETE   Keep
beyond MINIO_CLEANUP_DAYS (90)            DELETE        DELETE
```

Configure with `FILESYSTEM_CLEANUP_DAYS` and `MINIO_CLEANUP_DAYS`. The `cleanup-fs`
job performs the deletions and is enqueued by the internal `CLEANUP_SCHEDULE_CRON`
scheduler (default daily 02:00); `cron-trigger-cleanup.sh` triggers it manually.

### Payment service integration

`PaymentService` (`src/arch/payment.ts`) talks to the payment-service for:
- **x402**: `getX402PriceQuote()` (returns 402 + payment requirements),
  `verifyAndSettleX402Payment()`, `finalizeX402Payment()` (fraud detection
  comparing declared vs actual byte count)
- Balance checks/reservations and credit adjustments (traditional flow)
- Free-upload allowlist validation
- JWT signing for inter-service auth (`PRIVATE_ROUTE_SECRET`)

A circuit breaker (opossum) guards these calls.

### x402 uploads

Two paths, both using Coinbase's x402 (HTTP 402 + USDC over EIP-3009/EIP-712):

1. **Signed** (`dataItemPost.ts`): the client builds and signs its own ANS-104
   data item, then pays with an `X-PAYMENT` header.
2. **Unsigned / raw** (`rawDataPost.ts`, `POST /x402/upload/unsigned`): the client
   POSTs raw bytes, the bundler returns a 402 USDC quote, the client pays via an
   EIP-712 `transferWithAuthorization` signature, and the **bundler signs the
   ANS-104 item with its own server wallet** (`getRawDataItemWallet()` /
   `RAW_DATA_ITEM_JWK_FILE`), stores it at S3 key `raw-data-item/{id}`, optical-
   bridges it, and returns a signed receipt. ERC-1271 smart-contract-wallet
   signatures are supported for verification.

Pricing uses per-byte cost plus `X402_FEE_PERCENT` (with a minimum floor); x402
payments are tracked in the `x402_payments` table.

**Key headers:** `X-Payment-Required: x402-1` (on 402 responses), `X-PAYMENT`
(client sends the payment authorization), `X-Payment-Response` (server returns the
base64-JSON confirmation).

## Testing Strategy

- **Unit tests**: `src/**/*.test.ts` — isolated logic with mocked dependencies.
- **Integration tests**: `tests/**/*.test.ts` — real PostgreSQL + ArLocal in
  Docker. `yarn test:integration:local` brings up infra and runs under `.env.test`.
- **End-to-end**: `tests/e2e-*.test.ts` (e.g. `e2e-aws-free.int.test.ts`) via
  `yarn test:e2e:local`.
- Use `-g "pattern"` to target a suite. `yarn test:docker` runs everything in a
  clean container.

## Key Environment Variables

See the repo-root `.env.sample` for the full list. Commonly relevant here:
- `UPLOAD_SERVICE_PORT` (default 3001)
- `UPLOAD_DB_DATABASE` (default `upload_service`), `DB_HOST`, `DB_PORT`,
  `DB_USER`, `DB_PASSWORD`, `DB_WRITER_ENDPOINT`, `DB_READER_ENDPOINT`,
  `DB_POOL_MIN`/`DB_POOL_MAX`
- `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `DATA_ITEM_BUCKET`
  (MinIO/S3)
- `REDIS_HOST` / `REDIS_PORT_QUEUES` (BullMQ), `ELASTICACHE_HOST` /
  `ELASTICACHE_PORT` (cache)
- `TURBO_JWK_FILE` (bundle-signing wallet, absolute path),
  `RAW_DATA_ITEM_JWK_FILE` (unsigned-upload signing wallet)
- `PAYMENT_SERVICE_BASE_URL` (no protocol prefix), `PRIVATE_ROUTE_SECRET`
- `ARWEAVE_GATEWAY`, `OPTICAL_BRIDGING_ENABLED`, `OPTICAL_BRIDGE_URL`,
  `AR_IO_ADMIN_KEY`
- `X402_FEE_PERCENT`, `MAX_DATA_ITEM_SIZE` (default 10 GiB),
  `FILESYSTEM_CLEANUP_DAYS`, `MINIO_CLEANUP_DAYS`

## Development Workflow

1. Make changes.
2. `yarn typecheck` to catch type errors.
3. `yarn lint:fix` and `yarn format:fix` before committing.
4. Run relevant tests (`yarn test:unit` / `yarn test:integration:local`).
5. For schema changes, follow the migration workflow above.
