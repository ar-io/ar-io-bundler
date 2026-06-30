# AR.IO Bundler Architecture

**Version:** 1.2.0
**Last Updated:** 2026-06

> ⚠️ **Partial / older snapshot.** This document was last *fully* verified at
> version 1.0.0 (2025-10) and has since received only targeted corrections. Some
> sections (especially the API reference and the AWS-migration appendix) lag the
> codebase. For authoritative, current information defer to:
> - **CLAUDE.md** (architecture overview, kept in sync with code)
> - **docs/api/README.md** (authoritative REST API reference)
> - **docs/operations/HETZNER_DEPLOYMENT_RUNBOOK.md** (authoritative deployment runbook)
> - the source code itself (the ultimate source of truth)

## Table of Contents

1. [System Overview](#system-overview)
2. [Architecture Principles](#architecture-principles)
3. [Infrastructure Components](#infrastructure-components)
4. [Service Architecture](#service-architecture)
5. [Database Schema](#database-schema)
6. [Queue System](#queue-system)
7. [Storage Layer](#storage-layer)
8. [Data Flows](#data-flows)
9. [API Reference](#api-reference)
10. [Security](#security)
11. [Observability](#observability)
12. [Configuration](#configuration)
13. [Development](#development)
14. [Deployment](#deployment)
15. [Migration from AWS](#migration-from-aws)

---

## System Overview

The AR.IO Bundler is a complete ANS-104 data bundling platform for Arweave with AR.IO Gateway integration. It provides a comprehensive solution for accepting, bundling, and posting data items to the Arweave network while managing payments via instant USDC stablecoin transactions (x402 protocol), traditional cryptocurrency, and credit card payments.

### Core Functionality

- **Data Upload**: Accept single and multipart data item uploads (single-item default cap 4 GiB; up to 10 GiB per item via multipart)
- **Payment Processing**:
  - **x402 Protocol (Primary)**: Instant USDC payments via Coinbase's HTTP 402 standard (EIP-3009, EIP-712)
  - **Cryptocurrency**: Traditional on-chain payments (Arweave, Ethereum, Solana, MATIC, KYVE, Base-ETH)
  - **Stripe**: Credit card and fiat currency payments
- **Bundle Management**: Automatically bundle data items using ANS-104 standard
- **Arweave Posting**: Post bundles to Arweave network with verification
- **AR.IO Integration**: Optimistic caching via optical bridging to AR.IO Gateway
- **ArNS Purchases**: Enable Arweave Name System name purchases

### Technology Stack

- **Language**: TypeScript 5 / Node.js 22 (required)
- **Package Manager**: Yarn 3.6.0 (workspaces)
- **Database**: PostgreSQL 16.1
- **Cache**: Redis 7.2 (2 instances - cache + queues)
- **Object Storage**: MinIO (S3-compatible)
- **Job Queue**: BullMQ (Redis-based)
- **Process Manager**: PM2
- **Web Framework**: Koa 3.0
- **Migration Tool**: Knex.js
- **Observability**: Winston (logging), OpenTelemetry (optional), Prometheus (metrics)
- **Containerization**: Docker Compose

### Relationship to upstream (intentional divergences)

This is a fork of ArDrive's Turbo (`ardriveapp/upload-service` + `payment-service`).
We track upstream for correctness / security / ANS-104 fixes but **deliberately
diverge** — these are recorded choices, not gaps:

- **De-AWS:** SQS→BullMQ, Lambda/ECS→PM2, DynamoDB→PostgreSQL, S3→MinIO, AWS
  Secrets Manager/SSM→dotenv. (Source comments mentioning SQS/Lambda/DynamoDB are
  legacy markers, not live behavior.)
- **Payments:** our own x402 design (byte-count quote + USDC settlement +
  ERC-1271), *different* from upstream's x402 promo/USD-amount path. ARIO/ArNS
  stays **enabled** — we did the Solana-ARIO migration (`@ar.io/sdk` v4); upstream
  temporarily disabled ARIO (PE-9069), which we did **not** inherit.
- **Vertical integration (additive):** reads/pricing/optical-posting target the
  local AR.IO gateway; after posting a bundle the bundler calls the gateway
  `queue-bundle` admin API so it unbundles + indexes (`bundledIn`).
  `PRICE_ORACLE_GATEWAY_URL` / `ARIO_GATEWAY_URL` point byte/ARIO pricing at our
  own gateway to avoid public-endpoint rate limits.
- **Not adopted (intentional — x402-primary, fewer-chains posture):** cross-chain
  signed-request funding (PE-6013), USDC-on-EVM funding gateways (PE-7482),
  base-bridged $ARIO (PE-8763),
  turbo-gateway.com host-swap + SSM optical keys, `$U` mint tags, DynamoDB RCU
  autoscaling.
- **Adopted from upstream (de-AWS port):** per-chunk broadcast (PE-8879/8967) — the
  `broadcast-chunks` BullMQ queue broadcasts each chunk to `AR_IO_NODE_URLS`
  distributor nodes (shuffle + failover), replacing the original AWS node-fleet
  design.
- **Platform:** Node 22+ (required — `@ar.io/sdk` v4 is ESM-only), TypeScript 5.
- **Open decision:** `usd_equiv` is *computed* on crypto funding but not persisted
  (PE-8705) — adopt only if USD-denominated crypto-funding accounting is needed.

---

## Architecture Principles

### Dependency Injection

Both services use a centralized `Architecture` interface that injects dependencies throughout the application:

**Payment Service** (`packages/payment-service/src/architecture.ts:24`):
```typescript
interface Architecture {
  paymentDatabase: Database;
  pricingService: PricingService;
  stripe: Stripe;
  emailProvider?: EmailProvider;
  gatewayMap: GatewayMap;
}
```

**Upload Service** (`packages/upload-service/src/arch/architecture.ts`):
```typescript
interface Architecture {
  database: Database;
  objectStore: ObjectStore;
  cacheService: CacheService;
  paymentService: PaymentService;
  arweaveGateway: ArweaveGateway;
  logger: winston.Logger;
  getArweaveWallet: () => JWKInterface;
  getRawDataItemWallet: () => JWKInterface;  // For raw data uploads (server-signed)
  tracer?: Tracer;
}
```

This pattern enables:
- Easy testing with mocked dependencies
- Environment-specific configurations
- Clear dependency boundaries
- Improved maintainability

### Separation of Concerns

- **Payment Service**: Isolated credit/payment management
- **Upload Service**: Focused on data handling and bundling
- **Workers**: Background job processing separated from API
- **Database**: Separate databases for each service
- **Redis**: Dedicated instances for caching vs queuing

### Asynchronous Processing

- **Koa Middleware**: Handles HTTP requests/responses quickly
- **BullMQ Queues**: Defers heavy processing to background workers
- **Job Pipeline**: Multi-stage bundle fulfillment (plan → prepare → post → verify)
- **Optical Posting**: Asynchronous AR.IO Gateway integration

### Resilience

- **Circuit Breakers**: Opossum library for fault tolerance (payment service, remote config, cache)
- **Retry Logic**: Exponential backoff for failed operations
- **Health Checks**: Docker Compose health checks for all infrastructure
- **PM2 Auto-Restart**: Automatic service recovery on crashes
- **Graceful Shutdown**: Workers finish current jobs before termination

---

## Infrastructure Components

### Docker Compose Services

Located in `docker-compose.yml`:

#### PostgreSQL
```yaml
Service: postgres
Image: postgres:16.1
Port: 5432
Databases: payment_service, upload_service
User: turbo_admin
Healthcheck: pg_isready
```

Creates both databases on initialization via `infrastructure/postgres/init-databases.sql`.

#### Redis Cache
```yaml
Service: redis-cache
Image: redis:7.2-alpine
Port: 6379
Purpose: Data item caching, API response caching
Healthcheck: redis-cli ping
```

Used by upload service for caching data item metadata, offset information, and reducing database load.

#### Redis Queues
```yaml
Service: redis-queues
Image: redis:7.2-alpine
Port: 6381
Purpose: BullMQ job queues
Healthcheck: redis-cli -p 6381 ping
```

Dedicated Redis instance for all BullMQ queues (15 queues total).

#### MinIO
```yaml
Service: minio
Image: minio/minio:latest
Ports: 9000 (S3 API), 9001 (Console UI)
Buckets: raw-data-items, backup-data-items
Healthcheck: mc ready local
```

S3-compatible object storage for all uploaded data items and bundles.

**MinIO Initialization**:
- Service: `minio-init` automatically creates required buckets
- Sets public read access for data retrieval
- Runs once on stack startup

### PM2 Process Management

Located in `infrastructure/pm2/ecosystem.config.js`:

```javascript
{
  apps: [
    {
      name: "payment-service",
      instances: API_INSTANCES || 2,
      exec_mode: "cluster",
      port: 4001
    },
    {
      name: "upload-api",
      instances: API_INSTANCES || 2,
      exec_mode: "cluster",
      port: 3001
    },
    {
      name: "payment-workers",
      instances: 1,            // hardcoded — never scaled (avoids duplicate credit processing)
      exec_mode: "fork",
      script: "./lib/workers/index.js"
    },
    {
      name: "upload-workers",
      instances: WORKER_INSTANCES || 1,
      exec_mode: "fork",
      script: "./lib/workers/allWorkers.js"   // 15 BullMQ queues
    },
    {
      name: "admin-dashboard",   // admin stats + embedded Bull Board
      instances: 1,
      exec_mode: "fork",
      script: "./server.js",     // packages/admin-service/server.js
      port: 3002
    }
  ]
}
```

There are **5** PM2 processes: `payment-service`, `upload-api` (cluster),
`payment-workers`, `upload-workers`, `admin-dashboard` (fork). There is no
separate `bull-board` process — Bull Board is embedded in `admin-dashboard`.
The `admin-dashboard` also computes a health rollup and, when `ALERTS_ENABLED`,
runs an opt-in Slack alerter that pushes that verdict to Slack (`chat.postMessage`).

**Execution Modes**:
- **Cluster**: APIs leverage multiple CPU cores, load balancing across instances
- **Fork**: Workers run single instance to avoid duplicate job processing

**Management Commands**:
```bash
pm2 start infrastructure/pm2/ecosystem.config.js
pm2 stop all
pm2 restart all
pm2 logs
pm2 monit
```

### Port Allocation

| Service | Port | Description |
|---------|------|-------------|
| Upload API | 3001 | Data upload REST API |
| Bull Board | 3002 | Queue monitoring dashboard |
| Payment API | 4001 | Payment processing REST API |
| AR.IO Gateway | 4000 | Separate AR.IO Gateway (external) |
| PostgreSQL | 5432 | Database server |
| Redis Cache | 6379 | ElastiCache/Redis cache |
| Redis Queues | 6381 | BullMQ job queues |
| MinIO S3 API | 9000 | Object storage API |
| MinIO Console | 9001 | Web UI for MinIO |

### Deployment topologies: single-node & HA

The platform runs in two topologies. **Start single-node; the architecture is
HA-ready** (stateless APIs, reader/writer DB split, BullMQ-distributed workers,
externalizable infra), so going HA is configuration + infrastructure, not a
rewrite. Step-by-step deploy lives in the Hetzner runbook (`docs/operations/`).

**Single-node (start here).** Everything on one host: PM2 runs all 5 processes
(payment-api ×2 + upload-api ×2 in cluster mode; upload-workers + payment-workers
in fork mode; admin-dashboard); Docker runs the infra (PostgreSQL, Redis cache,
Redis queues, single-drive MinIO); cron triggers (plan/cleanup/verify) run on the
box. Simple — and a single point of failure on every tier.

**High availability (the target).** What scales, what stays singleton, and the
infra to externalize:

- **Stateless API tier → scale horizontally behind a load balancer.** payment-api
  and upload-api hold no local state (it's all in Postgres/Redis/MinIO), so run N
  instances across nodes behind a LB (TLS termination, health-check `/health`).
- **Workers → distribute via BullMQ, but two things MUST stay singleton.** BullMQ
  atomically claims jobs from the shared Redis queues, so multiple
  upload-workers/payment-workers instances across nodes consume the same queues
  safely. The singletons:
  1. **The recurring producers / cron** — bundle planning (`plan-bundle`),
     the pending-tx check scheduler, cleanup, verify. Running these on every node
     creates duplicate/competing plans + credit checks. Run them on **one
     designated node** or behind a **distributed lock / leader election** (e.g. a
     Redis lock around each trigger).
  2. **`payment-workers` crypto-credit finalization** is pinned `instances: 1`
     for this reason — confirm idempotency (dedupe by tx hash) before scaling it;
     otherwise keep it on a single node.
- **Stateful infra → externalize to HA clusters:**
  - **PostgreSQL** → primary + replica(s) with automatic failover (Patroni/repmgr
    or managed). We already split reader/writer (`DB_READER_ENDPOINT` /
    `DB_WRITER_ENDPOINT`) — point readers at replicas, writer at the primary.
  - **Redis** (cache + queues) → Redis Sentinel or Cluster for failover; BullMQ
    needs a stable, HA Redis.
  - **MinIO** → distributed mode (≥4 drives/nodes, erasure coding) or a managed
    S3-compatible store. The AR.IO gateway retrieves data items from here, so it
    must stay highly available.
- **Shared config:** the signing wallets (`TURBO_JWK_FILE`,
  `RAW_DATA_ITEM_JWK_FILE`) and shared secrets (`PRIVATE_ROUTE_SECRET`,
  `JWT_SECRET`) must be identical on every node (config management / secret store).
- **Gateway layer:** the two baremetal AR.IO gateways already give gateway-layer
  HA — optical-post to both via `OPTIONAL_OPTICAL_BRIDGE_URLS`.

**Migration single→HA:** externalize Postgres/Redis/MinIO to HA clusters → put a
LB in front of the API nodes → designate/lock the singleton cron + scheduler →
scale API and worker instances. No application rewrite required. (DR/backup detail:
Hetzner runbook §16–17 + `docs/archive/HIGH_AVAILABILITY_DISASTER_RECOVERY.md`.)

---

## Service Architecture

### Payment Service

**Location**: `packages/payment-service/`
**Port**: 4001
**Database**: `payment_service`

#### Purpose

Manages all financial operations including:
- **x402 Protocol**: Instant USDC payments (primary method)
- **User balance tracking**: Winston credits for pre-funded accounts
- **Cryptocurrency payments**: Traditional on-chain payment verification
- **Stripe payments**: Credit card and fiat processing
- **ArNS purchases**: Arweave Name System name registrations
- **Promotional codes**: Discounts and adjustments
- **Payment receipts**: Audit logging and transaction history
- **Delegated payment approvals**: Third-party payment authorization

#### Architecture Components

**Entry Point** (`src/index.ts`):
- Starts HTTP server via `createServer()`
- Loads secrets from environment

**HTTP Server** (`src/server.ts`):
- Koa-based REST API on port 4001
- JWT authentication middleware (passthrough mode)
- Architecture dependencies injected via middleware
- Routes defined in `src/router.ts`

**Database Layer** (`src/database/postgres.ts`):
- `PostgresDatabase` implements `Database` interface
- Knex.js for SQL query building
- Separate reader/writer connections supported
- Schema migrations in `src/migrations/`

**Gateway Layer** (`src/gateway/`):
- Abstract `Gateway` class for blockchain interactions
- Implementations:
  - `X402Gateway`: x402 payment verification and on-chain confirmation (EVM networks)
  - `ArweaveGateway`: Arweave transaction verification
  - `EthereumGateway`: Ethereum transaction verification
  - `SolanaGateway`: Solana transaction verification
  - `MaticGateway`: Polygon (MATIC) transaction verification
  - `KyveGateway`: KYVE transaction verification
  - `BaseEthGateway`: Base (Ethereum L2) transaction verification
  - `ARIOGateway`: AR.IO Network interactions for ArNS

**Pricing Service** (`src/pricing/`):
- `TurboPricingService` implementation
- Oracles for rate conversions:
  - `X402PricingOracle`: Winston → USDC (via AR/USD from CoinGecko)
  - `BytesToWinstonOracle`: Storage bytes → Arweave Winston
  - `TokenToFiatOracle`: Cryptocurrency → Fiat currency
- Handles promotional codes, discounts, adjustments

**X402 Service** (`src/x402/x402Service.ts`):
- EIP-712 signature verification
- Payment requirement validation
- Facilitator integration (Coinbase settlement service)
- Multi-network support (Base, Ethereum, Polygon)
- Three payment modes: PAYG, top-up, hybrid

#### Key Routes

**x402 Payment Routes (Primary)**:

| Route | Method | Purpose |
|-------|--------|---------|
| `/v1/x402/price/:signatureType/:address` | GET | Get x402 payment requirements (402 response with USDC amount) |
| `/v1/x402/payment/:signatureType/:address` | POST | Verify and settle x402 payment (EIP-712 signature validation) |
| `/v1/x402/finalize` | POST | Finalize x402 payment after upload validation |

**Balance & Traditional Payment Routes**:

| Route | Method | Purpose |
|-------|--------|---------|
| `/v1/balance` | GET | Get user balance (Winston credits) |
| `/v1/balance/:token` | POST | Add pending cryptocurrency transaction |
| `/v1/reserve-balance` | POST | Reserve balance for operation |
| `/v1/refund-balance` | POST | Refund reserved balance |
| `/v1/top-up/:currency` | POST | Create Stripe checkout session |
| `/v1/stripe-webhook` | POST | Handle Stripe webhook events |
| `/v1/redeem` | POST | Redeem promotional code |
| `/v1/price/:currency/:amount` | GET | Calculate price for bytes |

**ArNS Routes**:

| Route | Method | Purpose |
|-------|--------|---------|
| `/v1/arns/price/:intent/:name` | GET | Get ArNS name price quote |
| `/v1/arns/purchase/:intent/:name` | POST | Initiate ArNS purchase |
| `/v1/arns/purchase/:nonce` | GET | Check ArNS purchase status |

**Delegated Payment Routes**:

| Route | Method | Purpose |
|-------|--------|---------|
| `/v1/account/approvals` | POST | Create payment approval |
| `/v1/account/approvals` | GET | List approvals |
| `/v1/account/approvals/:approvalId` | DELETE | Revoke approval |

**Utility Routes**:

| Route | Method | Purpose |
|-------|--------|---------|
| `/v1/rates` | GET | Get conversion rates |
| `/v1/currencies` | GET | List supported currencies |
| `/v1/countries` | GET | List supported countries |

#### Database Schema (Payment Service)

**x402 Payment Tables** (Primary Payment Method):

- **`x402_payment_transaction`**: USDC payment records
  - `id` (PK): UUID
  - `user_address`: Recipient address
  - `user_address_type`: Address type (e.g., 'ethereum')
  - `tx_hash`: On-chain transaction hash (unique)
  - `network`: EVM network (base-mainnet, ethereum-mainnet, etc.)
  - `token_address`: USDC contract address
  - `usdc_amount`: USDC atomic units (6 decimals)
  - `winc_amount`: Winston equivalent
  - `mode`: Payment mode ('payg', 'topup', 'hybrid')
  - `data_item_id`: Associated upload (nullable)
  - `declared_byte_count`: Size declared at payment (nullable)
  - `actual_byte_count`: Actual upload size (nullable)
  - `status`: 'pending_validation', 'confirmed', 'refunded', 'fraud_penalty'
  - `paid_at`: Payment timestamp
  - `finalized_at`: Finalization timestamp (nullable)
  - `refund_winc`: Refund amount if applicable (nullable)
  - `payer_address`: EIP-712 signer address

- **`x402_payment_reservation`**: Reserved credits for uploads
  - `data_item_id` (PK): Data item ID
  - `x402_payment_id` (FK): Associated payment
  - `winc_reserved`: Reserved Winston amount
  - `created_at`: Reservation timestamp
  - `expires_at`: Expiration timestamp (1 hour)

**Core Tables**:

- **`user`**: User accounts with Winston balance
  - `user_address` (PK): Arweave address
  - `winston_credit_balance`: Available credits
  - `reserved_balance`: Reserved credits

- **`payment_receipt`**: Successful payments
  - `payment_receipt_id` (PK): UUID
  - `top_up_quote_id`: Associated quote
  - `destination_address`: Recipient
  - `winston_credit_amount`: Credits purchased
  - `payment_amount`, `currency_type`: Paid amount
  - `payment_provider`: 'stripe' or crypto type

- **`payment_adjustment`**: Manual balance adjustments
  - `payment_adjustment_id` (PK): UUID
  - `catalog_id`: Adjustment type
  - `user_address`: Affected user
  - `winston_credit_amount`: Adjustment amount (+ or -)

- **`pending_payment_transaction`**: Pending crypto payments
  - `transaction_id` (PK): Blockchain TX ID
  - `destination_address`, `token_type`
  - `transaction_quantity`: Amount sent
  - `winston_credit_amount`: Expected credits

- **`credited_payment_transaction`**: Confirmed payments
  - Moved from `pending_payment_transaction` after verification

- **`failed_payment_transaction`**: Failed payments
  - `failure_reason`: Why payment failed

- **`arns_purchase`**: ArNS name purchases
  - `arns_purchase_nonce` (PK): UUID
  - `arns_name`: Purchased name
  - `arns_purchase_intent`: 'buy' or 'lease'
  - `arns_purchase_status`: 'pending', 'confirmed', 'failed'
  - `winston_credit_cost`: Cost in credits

- **`delegated_payment_approval`**: Payment authorizations
  - `payment_approval_id` (PK): UUID
  - `approved_address`: Delegated payer
  - `total_approved_winston`: Maximum amount
  - `single_use_approved_winston`: Per-use limit
  - `approval_expires_at`: Expiration timestamp

- **`balance_reservation`**: Temporary balance holds
  - `reservation_id` (PK): UUID
  - `user_address`: Account holder
  - `reserved_winston`: Amount reserved
  - `expires_at`: Reservation expiration

- **`audit_log`**: All balance changes
  - `audit_id` (PK): Incremental
  - `user_address`: Affected user
  - `winston_credit_amount`: Change amount
  - `balance_change_reason`: Why changed
  - `data_item_id`, `payment_receipt_id`: Associated entities

**Indexes**:
- `user_address` on all user-related tables
- `transaction_id` on payment transaction tables
- `arns_purchase_nonce` for status lookups
- `approved_address` for delegation queries

### Upload Service

**Location**: `packages/upload-service/`
**Port**: 3001
**Database**: `upload_service`

#### Purpose

Handles all data upload operations including:
- Single data item uploads (POST endpoint)
- Multipart uploads for large files
- ANS-104 bundle creation and posting
- Data item verification on Arweave
- Nested bundle (BDI) unbundling
- Optical posting to AR.IO Gateway
- Offset tracking for data retrieval

#### Architecture Components

**Entry Point** (`src/index.ts`):
- Starts HTTP server
- Runs database migrations if `MIGRATE_ON_STARTUP=true`

**HTTP Server** (`src/server.ts`):
- Koa-based REST API on port 3001
- Architecture dependencies injected
- Routes defined in `src/router.ts`

**Database Layer** (`src/arch/db/postgres.ts`):
- `PostgresDatabase` implements `Database` interface
- Separate reader/writer Knex connections
- Complex queries for bundle planning
- Migrations in `src/migrations/`

**Object Store** (`src/arch/`):
- `S3ObjectStore`: MinIO/S3 integration for production
- `FileSystemObjectStore`: Local development fallback
- Stores uploaded data items and bundles

**Cache Service** (`src/arch/elasticacheService.ts`):
- Redis-based caching for data item metadata
- Reduces database load for frequently accessed data
- Circuit breaker for fault tolerance

**Payment Service Integration** (`src/arch/payment.ts`):
- `PaymentService` interface
- Balance checks and reservations
- Credit adjustments on upload
- JWT authentication for inter-service calls
- Circuit breaker pattern

**Arweave Gateway** (`src/arch/arweaveGateway.ts`):
- `ArweaveGateway` class for network interaction
- Bundle posting to Arweave
- Transaction verification
- Block height tracking

**Workers** (`src/workers/allWorkers.ts`):
- 15 BullMQ workers processing async jobs
- Each worker handles specific job type
- Graceful shutdown support

#### Key Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/v1/tx` | POST | Upload single data item |
| `/v1/tx/:id` | POST | Upload signed data item |
| `/v1/tx/:id/status` | GET | Get data item status |
| `/v1/tx/:id/offsets` | GET | Get data item offset information |
| `/v1/upload` | POST | Create multipart upload |
| `/v1/upload/:id/:chunkIndex` | PUT | Upload chunk |
| `/v1/upload/:id` | POST | Finalize multipart upload |
| `/v1/upload/:id` | DELETE | Abort multipart upload |
| `/v1/upload/:id` | GET | Get multipart upload status |
| `/v1/account/balance` | POST | Private: Adjust user balance |
| `/v1/info` | GET | Service health/version info |
| `/swagger` | GET | Swagger API documentation |

#### Database Schema (Upload Service)

**Core Tables**:

- **`new_data_item`**: Uploaded data items awaiting bundling
  - `data_item_id` (PK): Base64URL ID
  - `owner_address`: Uploader
  - `byte_count`: Size in bytes
  - `assessed_winston_price`: Storage cost
  - `uploaded_date`: Timestamp
  - `premium_feature_type`: Bundle type (default, warp, ao, etc.)
  - `signature_type`: Signature algorithm
  - `content_type`: MIME type
  - `uploaded_by_address`: Paying address
  - `deadline_height`: Arweave block deadline

- **`planned_data_item`**: Data items assigned to bundle plans
  - `data_item_id` (PK)
  - `plan_id`: Associated bundle plan
  - `byte_count`, `premium_feature_type`, etc.

- **`bundle_plan`**: Bundle assembly plans
  - `plan_id` (PK): UUID
  - `planned_date`: When planned
  - `premium_feature_type`: Bundle type

- **`new_bundle`**: Bundles being prepared
  - `plan_id` (PK): UUID
  - `bundle_id`: Transaction ID
  - `reward`: Arweave fee
  - `header_byte_count`, `payload_byte_count`: Sizes

- **`posted_bundle`**: Bundles posted to Arweave
  - `plan_id` (PK)
  - `bundle_id`, `reward`

- **`seeded_bundle`**: Bundles seeded to additional gateways
  - `plan_id` (PK)
  - `bundle_id`

- **`permanent_bundle`**: Verified permanent bundles
  - `plan_id` (PK)
  - `bundle_id`
  - `block_height`: Arweave block included

- **`permanent_data_item`**: Verified permanent data items
  - `data_item_id` (PK)
  - `bundle_id`: Parent bundle
  - `block_height`: Confirmation block

- **`failed_bundle`**: Failed bundle posts
  - `plan_id` (PK)
  - `bundle_id`
  - `failed_bundles`: CSV of previously failed bundle IDs
  - `failed_date`: When failed

- **`failed_data_item`**: Failed data items
  - `data_item_id` (PK)
  - `failed_reason`: 'failed_to_post' or 'not_found'
  - `failed_date`

- **`in_flight_multipart_upload`**: Active multipart uploads
  - `upload_id` (PK): UUID
  - `created_date`, `expires_at`
  - `uploaded_by_public_address`
  - `chunk_size`, `total_chunks`
  - `finalized`: Boolean

- **`finished_multipart_upload`**: Completed/aborted multipart uploads
  - `upload_id` (PK)
  - `finished_reason`: 'completed', 'aborted', 'failed'
  - `failed_reason`: Optional failure details

- **`data_item_offsets`**: Offset tracking for data retrieval
  - `data_item_id` (PK): Data item ID
  - `root_bundle_id`: Top-level bundle
  - `start_offset_in_root_bundle`: Byte offset
  - `raw_content_length`: Total size
  - `payload_data_start`: Payload offset
  - `payload_content_type`: MIME type
  - `parent_data_item_id`: If nested in BDI
  - `start_offset_in_parent_data_item_payload`: Nested offset
  - `expires_at`: TTL timestamp

**Indexes**:
- `owner_address` on data item tables for user queries
- `plan_id` for bundle tracking
- `bundle_id` for verification
- `uploaded_date` for time-based queries
- `premium_feature_type` for dedicated bundling

---

## Queue System

### BullMQ Architecture

BullMQ provides Redis-based job queues with the following features:
- Delayed jobs and repeatable jobs
- Job prioritization
- Automatic retries with exponential backoff
- Job progress tracking
- Event-driven architecture

### Queue Definitions

Located in `packages/upload-service/src/constants.ts:278-290`:

```typescript
export const jobLabels = {
  finalizeUpload: "finalize-upload",
  opticalPost: "optical-post",
  unbundleBdi: "unbundle-bdi",
  newDataItem: "new-data-item",
  planBundle: "plan-bundle",
  prepareBundle: "prepare-bundle",
  postBundle: "post-bundle",
  seedBundle: "seed-bundle",
  verifyBundle: "verify-bundle",
  cleanupFs: "cleanup-fs",
  putOffsets: "put-offsets",
  redrivePosted: "redrive-posted",
  refundBalance: "refund-balance",
  broadcastChunks: "broadcast-chunks",
} as const;
```

### Worker Configuration

Located in `packages/upload-service/src/workers/allWorkers.ts`:

| Worker | Queue | Concurrency | Purpose |
|--------|-------|-------------|---------|
| `planWorker` | `plan-bundle` | 1 | Plan data items into bundles |
| `prepareWorker` | `prepare-bundle` | 3 | Download items, assemble bundles |
| `postWorker` | `post-bundle` | 2 | Post bundles to Arweave |
| `seedWorker` | `seed-bundle` | 2 | Seed bundles to additional gateways |
| `verifyWorker` | `verify-bundle` | 3 | Verify bundle permanence |
| `putOffsetsWorker` | `put-offsets` | 5 | Write offsets to PostgreSQL |
| `newDataItemWorker` | `new-data-item` | 5 | Batch insert new data items |
| `opticalWorker` | `optical-post` | 5 | Post to AR.IO optical bridge |
| `unbundleWorker` | `unbundle-bdi` | 2 | Unbundle nested BDIs |
| `finalizeWorker` | `finalize-upload` | 3 | Finalize multipart uploads |
| `cleanupWorker` | `cleanup-fs` | 1 | Clean temporary files |
| `redrivePostedWorker` | `redrive-posted` | 1 | Re-drive bundles stranded in `posted_bundle` |
| `refundBalanceWorker` | `refund-balance` | 3 | Durable balance-refund retry |
| `broadcastChunksWorker` | `broadcast-chunks` | `BROADCAST_CHUNKS_WORKER_CONCURRENCY` (10) | Broadcast each chunk to an AR.IO distributor (`AR_IO_NODE_URLS`, shuffle + failover) |

### Job Flow

**Upload Pipeline**:
```
POST /v1/tx
  ↓
newDataItem → planBundle → prepareBundle → postBundle → seedBundle → verifyBundle
                                                            ↓
                                          broadcastChunks (per-chunk fan-out → AR_IO_NODE_URLS)
                                              ↓
                                          opticalPost (parallel)
                                              ↓
                                          putOffsets (parallel)
                                              ↓
                                          cleanupFs
```

**Multipart Upload Pipeline**:
```
POST /v1/upload → PUT /v1/upload/:id/:chunk → POST /v1/upload/:id
                                                       ↓
                                                finalizeUpload
                                                       ↓
                                                (joins main pipeline)
```

**BDI Unbundling Pipeline**:
```
Detect BDI → unbundleBdi → putOffsets (for nested items)
                    ↓
              opticalPost (for each nested item)
```

### Queue Monitoring

**Bull Board** (port 3002):
- Web UI for monitoring all queues
- View job status, failed jobs, job details
- Retry failed jobs manually
- Clear completed jobs

Access at: `http://localhost:3002/admin/queues`

---

## Storage Layer

### MinIO Object Storage

**Configuration** (`.env`):
```bash
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin123
S3_REGION=us-east-1
S3_FORCE_PATH_STYLE=true
DATA_ITEM_BUCKET=raw-data-items
BACKUP_DATA_ITEM_BUCKET=backup-data-items
```

### Storage Keys

**Multipart Uploads**:
- Pattern: `${uploadId}/${chunkIndex}`
- Example: `a1b2c3d4-1234-5678-abcd-ef0123456789/0`

**Single Data Items**:
- Pattern: `${dataItemId}`
- Example: `abc123xyz...`

**Bundles**:
- Pattern: `${bundleId}`
- Example: `bundle_abc123...`

**Bundle Payloads**:
- Pattern: `${bundleId}/payload`
- Example: `bundle_abc123.../payload`

### Data Item Lifecycle

1. **Upload**: Stored in `raw-data-items` bucket
2. **Bundle Preparation**: Downloaded from MinIO, assembled into bundle
3. **Bundle Storage**: Complete bundle stored in MinIO
4. **Arweave Post**: Bundle transaction posted to Arweave
5. **Verification**: Confirmed on Arweave blockchain
6. **Cleanup**: Optional removal from MinIO after verification

### Backup Strategy

- **Primary**: `raw-data-items` bucket
- **Backup**: `backup-data-items` bucket (optional)
- **Redundancy**: MinIO can be configured with erasure coding

### Two-Tier MinIO (bundler hot + archive cold) — optional, opt-in

Gated entirely on `ARCHIVE_*` env. **Unset (the default) = single-MinIO behavior is
byte-for-byte unchanged.** When enabled, a **second, archive MinIO** mirrors served
content and takes **all AR.IO gateway reads**, so the bundler MinIO is reserved
for the ingest → bundle → post → seed → verify pipeline and is never exposed to the
gateway.

- **Archive copy (async):** a BullMQ `archive-copy` job (one per object, concurrency
  `ARCHIVE_COPY_WORKER_CONCURRENCY`, default 3) streams each `raw-data-item/{id}` and
  each `bundle-payload/{planId}` from bundler → archive. It is enqueued from the `new-data-item`
  handler (single uploads), the multipart-finalize path, and `prepare.ts` (bundle
  payloads). This is the 15th BullMQ queue (was 14).
- **Post-permanence bundler sweep:** once a bundle is permanent **and** its archive copy is
  HEAD-confirmed, `cleanup-fs` deletes the bundler copies (`raw-data-item/{id}`,
  `bundle-payload/{planId}`, `bundle/{txid}`) to reclaim the small SSD quickly. When
  archive is enabled this replaces the 90-day MinIO retention rule; the filesystem
  7-day tier is unchanged. The HEAD-gate against the archive store is the critical
  safety guard — the bundler copy is never deleted until the archive copy is confirmed present.
- **Archive retention:** 90 days (`ARCHIVE_RETENTION_DAYS`, default 90) via a native MinIO
  ILM expiry rule installed by `minio-init-archive`.
- **Gateway reads:** the gateway's S3 `AWS_ENDPOINT` points at the archive MinIO (port 9002)
  with the bundler MinIO removed from its retrieval sources. A brief pre-replication window
  falls through to the gateway's other retrieval methods (acceptable for an optimistic
  cache).

Key env (all distinct from the bundler `S3_*` vars; `ARCHIVE_BUCKET_REGION` **must** differ
from `S3_REGION`/`DATA_ITEM_BUCKET_REGION` or the archive client clobbers the bundler
client): `ARCHIVE_DATA_ITEM_BUCKET`, `ARCHIVE_S3_ENDPOINT`, `ARCHIVE_S3_ACCESS_KEY_ID`,
`ARCHIVE_S3_SECRET_ACCESS_KEY`, `ARCHIVE_S3_FORCE_PATH_STYLE`, `ARCHIVE_BUCKET_REGION`,
`ARCHIVE_COPY_WORKER_CONCURRENCY`, `ARCHIVE_RETENTION_DAYS`, `BUNDLER_CLEANUP_GRACE_DAYS`,
`ARCHIVE_MINIO_DATA_PATH`. See `docs/architecture/TWO_TIER_MINIO.md`.

### PostgreSQL Offset Storage

**Purpose**: Enables data item retrieval without full bundle download

**Storage** (`data_item_offsets` table):
- Data item ID → Offset in bundle
- Bundle ID → Root bundle containing item
- Nested offsets for BDIs
- TTL: 365 days (configurable via `POSTGRES_OFFSETS_TTL_SECS`)

**Size Threshold**:
- Items ≤ 10 KiB: Stored in PostgreSQL offsets table
- Items > 10 KiB: Reference to MinIO object
- Configurable via `POSTGRES_DATA_ITEM_BYTES_THRESHOLD`

---

## Data Flows

### Single Data Item Upload

```
1. Client → POST /v1/tx
   ├─ Validate signature
   ├─ Check balance with Payment Service
   ├─ Reserve balance
   └─ Store in MinIO

2. Upload API → Enqueue newDataItem
   ├─ Insert into new_data_item table
   └─ Deduct balance

3. Worker → planBundle (every N seconds)
   ├─ Fetch new_data_item records
   ├─ Group by premium_feature_type
   ├─ Pack into bundles (max 2GB or 10k items)
   ├─ Insert into bundle_plan + planned_data_item
   └─ Enqueue prepareBundle

4. Worker → prepareBundle
   ├─ Download all data items from MinIO
   ├─ Assemble ANS-104 bundle
   ├─ Calculate offsets
   ├─ Store bundle in MinIO
   ├─ Update to new_bundle
   ├─ Enqueue putOffsets
   └─ Enqueue postBundle

5. Worker → putOffsets (parallel)
   ├─ Write offsets to data_item_offsets table
   └─ Set TTL

6. Worker → postBundle
   ├─ Load bundle from MinIO
   ├─ Post to Arweave network
   ├─ Update to posted_bundle
   ├─ Enqueue seedBundle (optional)
   ├─ Enqueue opticalPost
   └─ Enqueue verifyBundle

7. Worker → opticalPost (parallel)
   ├─ Send data item headers to AR.IO Gateway
   └─ Enable optimistic caching

8. Worker → verifyBundle (delayed)
   ├─ Check Arweave confirmation (queries the gateway(s) in ARWEAVE_GATEWAYS,
   │  with read failover and GATEWAY_READ_TIMEOUT_MS per request)
   ├─ When confirmed (≥18 blocks) by the required number of independent sources
   │  (PERMANENCE_CONFIRMATION_SOURCES, default 1 — opt in to multi-source
   │  permanence by setting it to ≥2):
   │  └─ Update to permanent_bundle + permanent_data_item
   └─ If failed: retry or mark as failed_bundle

9. Worker → cleanupFs (optional)
   └─ Remove temporary files
```

### Multipart Upload

```
1. Client → POST /v1/upload
   └─ Create in_flight_multipart_upload record

2. Client → PUT /v1/upload/:id/:chunkIndex (repeat for each chunk)
   ├─ Store chunk in MinIO (key: uploadId/chunkIndex)
   └─ Update chunk tracking

3. Client → POST /v1/upload/:id (finalize)
   ├─ Validate all chunks present
   ├─ Enqueue finalizeUpload
   └─ Return 202 Accepted

4. Worker → finalizeUpload
   ├─ Download all chunks from MinIO
   ├─ Assemble complete data item
   ├─ Validate signature
   ├─ Check balance with Payment Service
   ├─ Reserve and deduct balance
   ├─ Store assembled data item
   ├─ Update to finished_multipart_upload
   ├─ Insert into new_data_item
   └─ (Joins main pipeline at step 3)
```

### Raw Data Upload (x402 Only)

The raw data upload flow is designed for AI agents and applications that want to upload data without implementing ANS-104 data item signing. The upload service creates and signs data items server-side while maintaining clear attribution of who paid versus who signed.

**Key Features:**
- **Server-signed**: Upload service signs ANS-104 data items using a dedicated wallet
- **x402 payment required**: Only works with instant USDC payments (no balance needed)
- **Automatic whitelisting**: Raw data item wallet is whitelisted (bypasses credit checks)
- **Attribution tracking**: Tags identify the payer (Ethereum address) separately from signer
- **Wallet separation**: Dedicated wallet for raw uploads (separate from bundle signing wallet)

**Configuration:**
```bash
# Enable raw data uploads
RAW_DATA_UPLOADS_ENABLED=true

# Wallet for signing raw data items (automatically whitelisted)
RAW_DATA_ITEM_JWK_FILE=/path/to/raw-data-wallet.json

# x402 payment configuration
X402_NETWORK=base-sepolia
USDC_CONTRACT_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
```

**Flow:**

```
1. Client → POST /v1/tx (raw data, no X-PAYMENT header)
   ├─ Smart detection: Check first 2 bytes for ANS-104 signature type
   ├─ If not ANS-104: Treat as raw data
   ├─ Parse request (binary + headers OR JSON envelope)
   ├─ Validate size (single data item: MAX_DATA_ITEM_SIZE, default 4 GiB; up to 10 GiB via multipart)
   └─ Return 402 Payment Required with x402 requirements

2. Client → POST /v1/tx (raw data + X-PAYMENT header)
   ├─ Parse raw data and custom tags (X-Tag-* headers)
   ├─ Extract payer address from X-PAYMENT header (EIP-3009)
   ├─ Calculate pricing:
   │  ├─ Get Winston cost from Arweave gateway
   │  ├─ Convert Winston → USDC with 10% buffer (X402PricingOracle)
   │  └─ Enforce 1000 atomic unit minimum (0.001 USDC)
   ├─ Verify and settle x402 payment:
   │  ├─ Validate EIP-712 signature and payment requirements
   │  ├─ Settle USDC transfer via facilitator (EIP-3009)
   │  └─ Receive transaction hash from blockchain
   ├─ Create ANS-104 data item server-side:
   │  ├─ Sign with RAW_DATA_ITEM_JWK (Arweave wallet)
   │  └─ Add attribution tags:
   │     ├─ Bundler: Service name
   │     ├─ Upload-Type: "raw-data-x402"
   │     ├─ Payer-Address: Ethereum address that paid
   │     ├─ Upload-Timestamp: Unix timestamp
   │     ├─ Content-Type: User-provided MIME type
   │     ├─ X402-Tx-Hash: Blockchain transaction hash
   │     ├─ X402-Payment-ID: Unique payment identifier (UUID)
   │     ├─ X402-Network: Payment network (e.g., "base")
   │     └─ Custom tags from X-Tag-* headers
   ├─ Store data item in MinIO
   ├─ Insert into new_data_item:
   │  ├─ ownerPublicAddress: Raw data item wallet (whitelisted)
   │  ├─ signatureType: 1 (Arweave - data item signer)
   │  └─ assessedWinstonPrice: From payment
   ├─ Store x402 payment record in payment_service database
   ├─ Enqueue newDataItem
   └─ Return 201 with:
      ├─ id: Data item ID
      ├─ owner: Raw data item wallet address (signer)
      ├─ payer: Ethereum address (actual payer)
      ├─ x402Payment: { paymentId, transactionHash, network, mode }
      └─ X-Payment-Response header: Base64-encoded payment confirmation

3. Worker → (Joins standard pipeline at planBundle)
   ├─ No special handling needed
   ├─ Uses "default" premiumFeatureType
   └─ Bundles with other data items normally
```

**Separation of Concerns:**
- **Payer** (Ethereum address): Provides x402 USDC payment, owns the upload economically
- **Signer** (Arweave address): Raw data item wallet, signs the ANS-104 data item
- Payment verified against payer's Ethereum wallet
- Data item signed by whitelisted Arweave wallet (no balance required)
- Attribution tracked via `Payer-Address` tag

**Request Formats:**

*Binary upload with headers:*
```bash
curl -X POST http://localhost:3001/v1/tx \
  -H "Content-Type: application/json" \
  -H "Content-Length: 1234" \
  -H "X-Tag-App-Name: MyApp" \
  -H "X-Tag-Version: 1.0" \
  -H "X-PAYMENT: <base64-eip3009-authorization>" \
  --data-binary @data.json
```

*JSON envelope:*
```bash
curl -X POST http://localhost:3001/v1/tx \
  -H "Content-Type: application/json" \
  -H "X-PAYMENT: <base64-eip3009-authorization>" \
  -d '{
    "data": "<base64-encoded-data>",
    "contentType": "application/json",
    "tags": [
      {"name": "App-Name", "value": "MyApp"},
      {"name": "Version", "value": "1.0"}
    ]
  }'
```

**Benefits:**
- **Simplified integration**: No ANS-104 signing library needed
- **Security**: Separate wallet limits exposure
- **Accounting**: Easy to track all raw uploads (single owner address)
- **Attribution**: Payer-Address tag tracks economic ownership
- **Backwards compatible**: Existing ANS-104 uploads unchanged

### x402 Payment Flow (Primary Payment Method)

The x402 protocol is the **primary payment method**, implementing Coinbase's HTTP 402 standard for instant USDC stablecoin payments using EIP-3009 (gasless transfers) and EIP-712 (typed signatures).

**Three-Phase Flow:**

#### Phase 1: Price Quote

```
1. Client → GET /v1/x402/price/:signatureType/:address?bytes=N
   ├─ Calculate Winston cost from byte count
   ├─ Add 10% pricing buffer for volatility (X402PricingOracle)
   ├─ Convert Winston → USD → USDC (via CoinGecko AR/USD price)
   ├─ Enforce 1000 atomic unit minimum (0.001 USDC)
   ├─ Generate PaymentRequirements for all enabled networks
   └─ Return 200 OK with payment requirements array

Response (JSON for API, HTML paywall for browsers):
{
  "x402Version": 1,
  "accepts": [{
    "scheme": "exact",
    "network": "base-mainnet",
    "maxAmountRequired": "1500000",  // USDC atomic units (6 decimals)
    "resource": "/v1/tx",
    "payTo": "0x...",  // X402_PAYMENT_ADDRESS
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",  // USDC contract
    "maxTimeoutSeconds": 300
  }]
}
```

#### Phase 2: Verify and Settle

```
2. Client generates EIP-712 signature
   ├─ Domain: USDC contract + chain ID
   ├─ Message: { from, to, value, validAfter, validBefore, nonce }
   └─ Sign with wallet (MetaMask, etc.)

3. Client → POST /v1/x402/payment/:signatureType/:address
   BODY: {
     paymentHeader: "base64(JSON+signature)",
     dataItemId: "optional-data-item-id",
     byteCount: 1048576,
     mode: "hybrid"  // or "payg" or "topup"
   }

   Server processes payment:
   ├─ Decode base64 payment header
   ├─ Verify EIP-712 signature (recover signer)
   ├─ Validate payment requirements (amount, recipient, timeout)
   ├─ Call facilitator: POST ${facilitatorUrl}/settle
   │  ├─ Facilitator executes receiveWithAuthorization() on USDC contract
   │  └─ Returns transaction hash
   ├─ Convert USDC → Winston using X402PricingOracle
   ├─ Create x402_payment_transaction record (status: pending_validation)
   ├─ Handle payment mode:
   │  ├─ PAYG: Reserve exact Winston for data_item_id
   │  ├─ Top-up: Credit entire amount to user balance
   │  └─ Hybrid (DEFAULT): Reserve for upload + credit excess to balance
   └─ Return payment confirmation

Response:
{
  "paymentId": "uuid",
  "txHash": "0x...",
  "network": "base-mainnet",
  "mode": "hybrid",
  "wincReserved": "5000000",  // For the upload
  "wincCredited": "1000000"   // Excess added to balance
}
```

#### Phase 3: Finalize (Post-Upload)

```
4. Upload Service → POST /v1/x402/finalize
   BODY: {
     dataItemId: "data-item-id",
     actualByteCount: 1048576
   }

   Server finalizes payment:
   ├─ Retrieve payment by data_item_id
   ├─ Compare actual_byte_count vs declared_byte_count
   ├─ Fraud detection (5% tolerance):
   │  ├─ actual > declared + 5%: status = "fraud_penalty" (keep payment)
   │  ├─ actual < declared - 5%: status = "refunded" (proportional refund)
   │  └─ within tolerance: status = "confirmed"
   ├─ Update payment status and finalized_at timestamp
   ├─ Credit refund to balance if applicable
   └─ Delete x402_payment_reservation

Response:
{
  "success": true,
  "status": "confirmed",
  "actualByteCount": 1048576,
  "refundWinc": "0"
}
```

**Payment Modes:**

| Mode | Behavior | Use Case |
|------|----------|----------|
| **payg** | Reserve exact amount for upload only | One-time payment per upload |
| **topup** | Credit entire payment to balance | Pre-fund account for multiple uploads |
| **hybrid** (default) | Reserve for upload, credit excess | Best UX: pay once, use excess later |

**Supported Networks:**

| Network | Chain ID | Status | Min Confirmations |
|---------|----------|--------|-------------------|
| Base Mainnet | 8453 | ✅ Enabled (default) | 1 |
| Ethereum Mainnet | 1 | ❌ Disabled | 3 |
| Polygon Mainnet | 137 | ❌ Disabled | 10 |
| Base Sepolia | 84532 | ✅ Testnet | 1 |

**Key Features:**
- **No pre-funding required**: Pay for upload in ~2 seconds
- **Instant settlement**: EIP-3009 gasless USDC transfers via Coinbase facilitator
- **Multi-network**: Support multiple EVM chains simultaneously
- **Three payment modes**: Flexible UX (PAYG, top-up, hybrid)
- **Fraud protection**: Size validation with 5% tolerance + proportional refunds
- **Browser support**: Interactive paywall with MetaMask integration
- **EIP-712 security**: Cryptographic signature verification with replay protection

### Crypto Payment Flow (Traditional)

```
1. Client → POST /v1/balance/:token
   ├─ Submit transaction ID
   └─ Store in pending_payment_transaction

2. Payment Service (polling)
   ├─ Query blockchain gateway
   ├─ Verify transaction confirmation
   ├─ Calculate Winston credits
   ├─ Move to credited_payment_transaction
   ├─ Create payment_receipt
   ├─ Update user balance
   └─ Create audit_log entry
```

### Stripe Payment Flow

```
1. Client → POST /v1/top-up/:currency
   ├─ Create top_up_quote
   └─ Return Stripe checkout session URL

2. User completes Stripe payment

3. Stripe → POST /v1/stripe-webhook
   ├─ Verify webhook signature
   ├─ Handle checkout.session.completed event
   ├─ Create payment_receipt
   ├─ Update user balance
   └─ Send email receipt (optional)
```

### ArNS Purchase Flow

```
1. Client → GET /v1/arns/price/:intent/:name
   └─ Return quote with pricing

2. Client → POST /v1/arns/purchase/:intent/:name
   ├─ Create arns_purchase_quote
   ├─ Return nonce + payment options

3. Client completes payment (Stripe or crypto)

4. Payment confirmed
   ├─ Update arns_purchase status → 'confirmed'
   ├─ Call AR.IO Gateway to register name
   └─ Deduct balance

5. Client → GET /v1/arns/purchase/:nonce
   └─ Check purchase status
```

### ArNS with Turbo Credits

Buy **and manage ArNS names paying with a Turbo credit balance** — no ARIO
tokens or SOL in the user's hands. A user authenticates with their existing
credit-account wallet (Arweave / Ethereum / Solana, or a keyless credit-card
balance); Turbo performs the on-chain Solana work and debits credits.

> **ArNS settles on Solana now.** ARIO migrated off Arweave/AO — ANTs are
> **Metaplex Core** assets and the bundler signs the Solana transactions with a
> server wallet. The legacy AO term `processId` is the ANT's Solana **asset
> address**; the AR.IO gateway surfaces it as `x-arns-ant-id`, so this codebase
> calls it **`antId`** (the SDK still says `processId` internally).

Full operational detail lives in `docs/guides/ARNS_INTEGRATION_GUIDE.md`;
implementation in `packages/payment-service/src/routes/{initiateArNSPurchase,
transferArNSAnt,manageArNSAnt}.ts`, `src/jobs/arnsRefund.ts`,
`src/utils/arnsCustodySignature.ts`, and `src/gateway/solana-ario.ts`.

#### Custody model (Model A — custodial)

| Case | Behavior |
|------|----------|
| **BYO-ANT** (caller supplies `processId`/`antId`) | Used as-is — Turbo registers the name to the caller's own ANT (typical self-custody Solana user). |
| **No ANT** (common Arweave / ETH / credit-card case) | Turbo **spawns a fresh Metaplex Core ANT owned by the Turbo server wallet**, registers the name to it, and records the user↔ANT link in the `user_ant` table. The user "owns" the name via that mapping + their credit account. |

A custodied user can later:

- **Exit** (`POST /v1/arns/transfer/:antId?target=`) — Turbo (the on-chain owner)
  signs a **cooperative transfer** of the ANT to a user-designated Solana pubkey
  and drops the custody mapping. This is a real ownership transfer, **not an
  escrow contract**.
- **Manage** (`POST /v1/arns/manage/:antId/{set-record,remove-record}`) — Turbo,
  as owner, writes the name's resolution records (base `@` or an undername) on
  the user's behalf.

Custodial provisioning is **off by default** — gated on `ARNS_PROVISIONING_ENABLED`
(false). With it off, a no-`processId` buy is an inert 400; only BYO-ANT buys and
the hardened money-path go live.

#### Purchase money-path state machine

The hard rule: a buyer is **never debited without an eventual credit-back on
failure**, and **never refunded a name they actually bought**. Each purchase
carries a `status` lifecycle on `arns_purchase_receipt`:

```
reserved ──────► spawned ──────► bought ──────► recorded
(debited)   (antId persisted   (on-chain buy   (message_id
            BEFORE the buy)    confirmed)      stored)
```

- **`status`, not `message_id`, is the success signal.** `bought` is set the
  instant the on-chain buy confirms — *before* the `message_id` is stored — so a
  later storage failure can never refund a paid name (the durable
  store-message-id retry just fills in `recorded`).
- The spawned `antId` is persisted to the receipt (`spawned`) **before** the buy.
  If the post-buy `user_ant` link write hiccups, the antId is already on the
  receipt — the mapping is a **rebuildable index**, never permanently lost
  (anti-orphan).
- The **synchronous failure path confirms on-chain before refunding**: for a
  fresh-name buy (`Buy-Name`/`Buy-Record`) it checks whether the name now
  resolves to this receipt's antId (`getArNSRecord`); a write that threw but
  actually landed (RPC/confirmation timeout) is marked `bought`, **not** refunded.

#### Reconciler (backstop) and durable refunds

A `payment-arns-refund` BullMQ queue carries refund / store-message-id /
`reconcile-stale` jobs (scheduled by `ARNS_RECONCILE_CRON`, `*/5 * * * *`).

- **`reconcile-stale`** finds receipts stuck in `reserved`/`spawned` past the
  stale threshold (`ARNS_RECEIPT_STALE_THRESHOLD_MS`, default 90 min) and
  **confirms on-chain (`getArNSRecord`) before acting**: it promotes a landed
  fresh-name buy to `bought` (only a fresh-name antId match proves *this* op
  landed — extend/upgrade matches don't, so they fall through), refunds only
  genuinely-unbought debits, and **fails safe on a gateway error** (skips that
  pass, never refunds blindly).
- **Durable refunds**: the critical-path refund tries inline, then enqueues a
  retry so a debit is *always* credited back even through an extended outage.
  Refunds are idempotent — `updateFailedArNSPurchase` only deletes a receipt with
  no `message_id`, so a duplicate/stale refund can't double-credit a bought name.

#### Auth for custody-mutating routes

`transfer`, `set-record`, and `remove-record` require an **action-bound,
single-use** signature (not the plain signed-request scheme used by price/buy):

- The signature is over a canonical newline-delimited message committing to the
  action + antId + params, concatenated with the nonce:
  `arns\n<action>\n<antId>\n<...params>` + nonce. A signature captured for any
  other route or different params can't authorize the operation — closing
  cross-route replay.
- The **nonce is consumed** (single-use, Redis `SET NX EX` in the BullMQ-queues
  Redis) after verification, so the exact request can't be replayed (e.g. to
  revert a record to an older value). The nonce store **fails closed (503)** if
  Redis is down.
- Ownership is enforced against `user_ant`; "not found" and "not yours" both
  return **404** (no ownership leak).

#### Routes

| Route | Method | Auth |
|-------|--------|------|
| `/v1/arns/price/:intent/:name` | GET | signed |
| `/v1/arns/purchase/:intent/:name` | POST | signed (provisioning gated by `ARNS_PROVISIONING_ENABLED`) |
| `/v1/arns/purchase/:nonce` | GET | public |
| `/v1/arns/quote/...` | GET | public (Stripe / fiat) |
| `/v1/arns/transfer/:antId?target=` | POST | action-bound signed |
| `/v1/arns/manage/:antId/set-record` | POST | action-bound signed |
| `/v1/arns/manage/:antId/remove-record` | POST | action-bound signed |

Intents: `Buy-Name`, `Buy-Record`, `Extend-Lease`, `Upgrade-Name`,
`Increase-Undername-Limit`.

### BDI Unbundling Flow

```
1. Detect Bundle Data Item (BDI) uploaded

2. Worker → unbundleBdi
   ├─ Download BDI payload from MinIO
   ├─ Parse nested data items (ANS-104)
   ├─ For each nested item:
   │  ├─ Extract raw data item
   │  ├─ Store in MinIO
   │  ├─ Calculate offsets
   │  ├─ Enqueue putOffsets
   │  └─ Enqueue opticalPost
   └─ Complete unbundling
```

---

## API Reference

### Upload Service API

**Base URL**: `http://localhost:3001`

#### POST /v1/tx
Upload a signed ANS-104 data item OR raw data with x402 payment.

**Two Upload Modes:**

**Mode 1: Traditional ANS-104 Upload (Client-Signed)**

Client creates and signs ANS-104 data item before uploading.

**Headers**:
- `Content-Type: application/octet-stream`
- `X-PAYMENT: <base64-eip3009-authorization>` (optional, for x402 payment)

**Body**: Raw binary data item in ANS-104 format (starts with signature type bytes)

**Response**:
```json
{
  "id": "abc123...",
  "owner": "xyz789...",
  "dataCaches": ["arweave.net"],
  "fastFinalityIndexes": ["arweave.net"]
}
```

**Mode 2: Raw Data Upload (Server-Signed, x402 Only)**

Client uploads raw data without ANS-104 signing. Server creates and signs data item. Requires `RAW_DATA_UPLOADS_ENABLED=true`.

**Smart Detection**: Service checks first 2 bytes - if not a valid ANS-104 signature type (1-8), treats as raw data.

**Phase 1 - Price Quote (no payment)**:

Request:
```bash
POST /v1/tx
Content-Type: application/json
Content-Length: 1234

<raw-data>
```

Response (402 Payment Required):
```json
{
  "x402Version": 1,
  "accepts": [{
    "scheme": "eip-3009",
    "network": "base-sepolia",
    "maxAmountRequired": "10000",
    "resource": "/v1/tx",
    "description": "Upload 1234 bytes to Arweave via AR.IO Bundler",
    "mimeType": "application/json",
    "payTo": "0x...",
    "maxTimeoutSeconds": 3600,
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
  }],
  "error": "Payment required to upload data"
}
```

**Phase 2 - Upload with Payment**:

Request:
```bash
POST /v1/tx
Content-Type: application/json
Content-Length: 1234
X-Tag-App-Name: MyApp
X-PAYMENT: <base64-json-with-eip3009-authorization>

<raw-data>
```

Response (201 Created):
```json
{
  "id": "abc123...",
  "owner": "xyz789...",  // Raw data item wallet (signer)
  "payer": "0x...",      // Ethereum address that paid
  "dataCaches": ["arweave.net"],
  "fastFinalityIndexes": ["arweave.net"],
  "receipt": { /* signed receipt */ },
  "x402Payment": {
    "paymentId": "uuid",
    "transactionHash": "0x...",
    "network": "base-sepolia",
    "mode": "hybrid"
  }
}
```

**JSON Envelope Format** (alternative):
```json
{
  "data": "<base64-encoded-data>",
  "contentType": "application/json",
  "tags": [
    {"name": "App-Name", "value": "MyApp"}
  ]
}
```

**Auto-Added Tags for Raw Uploads**:
- `Bundler`: Service name
- `Upload-Type`: "raw-data-x402"
- `Payer-Address`: Ethereum address from X-PAYMENT header
- `Upload-Timestamp`: Unix timestamp
- `Content-Type`: From request header or JSON
- Custom tags from `X-Tag-*` headers or JSON

#### POST /v1/tx/:id
Upload an unsigned data item with signature.

**Headers**:
- `Content-Type: application/octet-stream`
- `x-signature: <base64url-signature>`
- `x-signature-type: <signature-type>` (1=arweave, 2=ed25519, 3=ethereum, etc.)

**Body**: Raw binary data

**Response**: Same as POST /v1/tx

#### GET /v1/tx/:id/status
Get data item status.

**Response**:
```json
{
  "id": "abc123...",
  "status": "pending" | "finalized" | "permanent" | "failed",
  "bundleId": "bundle_xyz...",
  "blockHeight": 1234567
}
```

#### GET /v1/tx/:id/offsets
Get data item offset information for retrieval.

**Response**:
```json
{
  "dataItemId": "abc123...",
  "rootBundleId": "bundle_xyz...",
  "startOffset": 1024,
  "contentLength": 2048,
  "payloadDataStart": 512,
  "payloadContentType": "application/json"
}
```

#### POST /v1/upload
Create a multipart upload.

**Headers**:
- `x-data-item-size: <bytes>`
- `x-chunk-size: <bytes>` (optional, default: 25MB)
- `x-signature-type: <type>`

**Response**:
```json
{
  "uploadId": "uuid-1234-5678-abcd...",
  "chunkSize": 25000000,
  "totalChunks": 10,
  "expiresAt": "2025-10-25T12:00:00Z"
}
```

#### PUT /v1/upload/:uploadId/:chunkIndex
Upload a chunk.

**Headers**:
- `Content-Type: application/octet-stream`

**Body**: Raw chunk data

**Response**: `204 No Content`

#### POST /v1/upload/:uploadId
Finalize multipart upload.

**Headers**:
- `x-signature: <base64url-signature>`

**Response**:
```json
{
  "id": "abc123...",
  "status": "finalizing"
}
```

#### DELETE /v1/upload/:uploadId
Abort multipart upload.

**Response**: `204 No Content`

#### GET /v1/upload/:uploadId
Get multipart upload status.

**Response**:
```json
{
  "uploadId": "uuid-1234...",
  "status": "in_progress" | "finalizing" | "completed" | "aborted",
  "totalChunks": 10,
  "uploadedChunks": [0, 1, 2, 3],
  "expiresAt": "2025-10-25T12:00:00Z"
}
```

### Payment Service API

**Base URL**: `http://localhost:4001`

#### GET /v1/balance
Get user balance.

**Headers**:
- `Authorization: Bearer <jwt-token>` or signature-based auth

**Response**:
```json
{
  "winc": "1000000000",
  "reservedWinc": "100000"
}
```

#### POST /v1/balance/:token
Add a pending crypto payment.

**Parameters**:
- `token`: 'arweave' | 'ethereum' | 'solana' | 'matic' | 'kyve' | 'base-eth'

**Body**:
```json
{
  "tx_id": "blockchain-transaction-id"
}
```

**Response**:
```json
{
  "message": "Transaction pending confirmation",
  "transactionId": "blockchain-transaction-id",
  "estimatedCredits": "500000000"
}
```

#### POST /v1/top-up/:currency
Create Stripe checkout session.

**Parameters**:
- `currency`: 'usd' | 'eur' | 'gbp' | etc.

**Body**:
```json
{
  "amount": 1000,
  "destinationAddress": "arweave-address",
  "promoCode": "PROMO123" // optional
}
```

**Response**:
```json
{
  "paymentSession": {
    "url": "https://checkout.stripe.com/...",
    "id": "cs_..."
  },
  "topUpQuote": {
    "topUpQuoteId": "uuid",
    "wincAmount": "1000000000"
  }
}
```

#### GET /v1/price/:currency/:amount
Calculate price for storage.

**Parameters**:
- `currency`: 'arweave' | 'usd' | etc.
- `amount`: Number of bytes

**Response**:
```json
{
  "winc": "500000",
  "actualPaymentAmount": 100,
  "quotedPaymentAmount": 100,
  "adjustments": []
}
```

#### GET /v1/arns/price/:intent/:name
Get ArNS name price quote.

**Parameters**:
- `intent`: 'buy' | 'lease'
- `name`: ArNS name to purchase

**Query Parameters**:
- `years=1` (for lease)
- `type=permabuy` (for buy)

**Response**:
```json
{
  "namePrice": "1000000000",
  "networkFee": "100000000",
  "totalWinc": "1100000000"
}
```

#### POST /v1/arns/purchase/:intent/:name
Initiate ArNS purchase.

**Parameters**:
- `intent`: 'buy' | 'lease'
- `name`: ArNS name to purchase

**Headers**:
- Authorization with user signature

**Body**:
```json
{
  "years": 1, // for lease
  "type": "permabuy" // for buy
}
```

**Response**:
```json
{
  "nonce": "uuid",
  "winc": "1100000000",
  "status": "pending",
  "checkoutUrl": "https://checkout.stripe.com/..." // if Stripe
}
```

#### GET /v1/arns/purchase/:nonce
Check ArNS purchase status.

**Response**:
```json
{
  "status": "pending" | "confirmed" | "failed",
  "transactionId": "arweave-tx-id", // when confirmed
  "failureReason": "insufficient_balance" // when failed
}
```

#### POST /v1/account/approvals
Create a delegated payment approval.

**Headers**:
- User signature authentication

**Body**:
```json
{
  "approvedAddress": "delegate-address",
  "approvedWincAmount": "1000000000",
  "singleUseWincAmount": "100000000", // optional
  "expiresInSeconds": 86400 // optional, default: 30 days
}
```

**Response**:
```json
{
  "approvalId": "uuid",
  "approvedAddress": "delegate-address",
  "approvedWincAmount": "1000000000",
  "expiresAt": "2025-11-24T12:00:00Z"
}
```

#### GET /v1/account/approvals
List user's payment approvals.

**Response**:
```json
{
  "approvals": [
    {
      "approvalId": "uuid",
      "approvedAddress": "delegate-address",
      "totalApprovedWinc": "1000000000",
      "usedWinc": "200000000",
      "expiresAt": "2025-11-24T12:00:00Z"
    }
  ]
}
```

#### DELETE /v1/account/approvals/:approvalId
Revoke a payment approval.

**Response**: `204 No Content`

---

## Security

### Authentication Methods

**Upload Service**:
1. **Signature-based**: Data item signature validates uploader identity
2. **JWT Tokens**: For private routes (inter-service communication)
3. **Allow Lists**: Specific addresses get free uploads

**Payment Service**:
1. **JWT Tokens**: User authentication tokens
2. **Signature Verification**: Arweave/Ethereum/Solana signature validation
3. **Stripe Webhooks**: HMAC signature verification

### Authorization

**Balance Checks**:
- Upload service queries payment service before accepting uploads
- Reserved balance prevents double-spending
- Refund mechanism for failed operations

**Delegated Payments**:
- Approval system allows one address to pay for another
- Configurable limits (total + per-use)
- Expiration timestamps
- Revocable approvals

### Inter-Service Security

**Private Routes** (`PRIVATE_ROUTE_SECRET`):
```typescript
// Upload service calling payment service
headers: {
  'Authorization': `Bearer ${jwtToken}`,
  'x-service-secret': process.env.PRIVATE_ROUTE_SECRET
}
```

### Data Integrity

**Signature Validation**:
- All uploaded data items must have valid signatures
- Supported: Arweave (RSA), Ethereum (ECDSA), Solana (Ed25519), etc.
- Signature verified before storage

**Transaction Verification**:
- Cryptocurrency transactions verified on-chain
- Multiple confirmation blocks required
- Gateway polling for transaction status

### Environment Secrets

**Required Secrets** (`.env`):
```bash
# Inter-service
PRIVATE_ROUTE_SECRET=<openssl rand -hex 32>
JWT_SECRET=<openssl rand -hex 32>

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Arweave Wallets
TURBO_JWK_FILE=./wallet.json                    # Bundle signing wallet
RAW_DATA_ITEM_JWK_FILE=./raw-data-wallet.json   # Raw upload signing (auto-whitelisted)

# AR.IO Gateway
AR_IO_ADMIN_KEY=<admin-key>

# Database
DB_PASSWORD=<strong-password>

# MinIO
S3_ACCESS_KEY_ID=<access-key>
S3_SECRET_ACCESS_KEY=<secret-key>
```

**Secret Management**:
- Never commit secrets to git
- `.env` is git-ignored
- Use environment variables in production
- Rotate secrets regularly

### Network Security

**Firewall Rules**:
- Public: 3001 (upload API), 4001 (payment API)
- Internal: 5432 (PostgreSQL), 6379 (Redis cache), 6381 (Redis queues), 9000 (MinIO)
- Admin: 9001 (MinIO console), 3002 (Bull Board)

**TLS/SSL**:
- Recommended for production deployments
- Reverse proxy (nginx/Caddy) handles SSL termination
- MinIO supports native TLS

---

## Observability

### Logging

**Winston** configuration:
- Log level: Configurable via `LOG_LEVEL` (default: 'info')
- Formats: JSON for production, colorized for development
- Outputs:
  - Console (stdout/stderr)
  - File logs (PM2 managed)

**PM2 Logs**:
```bash
/home/vilenarios/ar-io-bundler/logs/
├── payment-service-error.log
├── payment-service-out.log
├── upload-api-error.log
├── upload-api-out.log
├── upload-workers-error.log
├── upload-workers-out.log
├── payment-workers-error.log
├── payment-workers-out.log
├── admin-dashboard-error.log
└── admin-dashboard-out.log
```

**Log Rotation**: Configure via PM2 or logrotate

### Metrics

**Prometheus Metrics**:
- `prom-client` library integrated
- Metrics exposed on `/metrics` endpoint (if enabled)
- Custom metrics:
  - Circuit breaker states
  - Queue depths
  - Bundle sizes
  - Upload success/failure rates

### Tracing

**OpenTelemetry** (optional):
- Auto-instrumentation for HTTP, PostgreSQL, S3 (AWS SDK client, used against MinIO)
- Configured via environment variables:
  - `OTEL_SAMPLE_RATE`: Sample percentage (default: 200 = 0.5%)
  - `HONEYCOMB_API_KEY`: Honeycomb integration
- Traces requests across services

**Instrumented Components**:
- HTTP requests (Koa)
- Database queries (Knex)
- S3 operations
- Redis operations

### Monitoring

**Bull Board** (port 3002):
- Real-time queue monitoring
- Job failure tracking
- Performance metrics per queue
- Manual job retry/removal

**Health Checks**:
- Docker Compose health checks for infrastructure
- `/v1/info` endpoints for service health
- PM2 process monitoring

**Alerts** (recommended external setup):
- Failed bundle posts
- Payment verification failures
- Database connection errors
- Disk space warnings

---

## Configuration

### Environment Variables

Comprehensive list in `packages/upload-service/.env`:

#### Service Ports
```bash
PAYMENT_SERVICE_PORT=4001
UPLOAD_SERVICE_PORT=3001
BULL_BOARD_PORT=3002
```

#### Database
```bash
DB_HOST=localhost
DB_PORT=5432
DB_USER=turbo_admin
DB_PASSWORD=postgres
# Per-service database name (there is no shared DB_DATABASE / *_DB_NAME var):
PAYMENT_DB_DATABASE=payment_service   # payment service
UPLOAD_DB_DATABASE=upload_service     # upload service
```

#### Redis
```bash
# Cache
REDIS_CACHE_HOST=localhost
REDIS_CACHE_PORT=6379
ELASTICACHE_HOST=localhost      # Legacy name
ELASTICACHE_PORT=6379
ELASTICACHE_NO_CLUSTERING=true

# Queues
REDIS_QUEUE_HOST=localhost
REDIS_QUEUE_PORT=6381
REDIS_HOST=localhost            # Legacy name
REDIS_PORT_QUEUES=6381
```

#### MinIO / S3
```bash
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin123
S3_REGION=us-east-1
S3_FORCE_PATH_STYLE=true
DATA_ITEM_BUCKET=raw-data-items
BACKUP_DATA_ITEM_BUCKET=backup-data-items
```

#### Arweave
```bash
ARWEAVE_GATEWAY=https://arweave.net
TURBO_JWK_FILE=./wallet.json
PUBLIC_ACCESS_GATEWAY=https://arweave.net

# Multi-gateway read/post failover (PR #41). Comma-separated; tried in order
# for both reads and posting. The verify-permanence flow queries these.
ARWEAVE_GATEWAYS=https://arweave.net,https://other-gateway.example
GATEWAY_READ_TIMEOUT_MS=10000
# Independent sources that must confirm permanence before a bundle is marked
# permanent. Default 1 (single source). Opt in to multi-source by setting >= 2.
PERMANENCE_CONFIRMATION_SOURCES=1
# Require the bundle row to be permanent before the tiered cleanup deletes its
# underlying objects.
CLEANUP_REQUIRE_PERMANENT_BUNDLE=true
```

#### AR.IO Gateway Integration
```bash
OPTICAL_BRIDGING_ENABLED=true
OPTICAL_BRIDGE_URL=http://localhost:4000/ar-io/admin/queue-data-item
AR_IO_ADMIN_KEY=<admin-key>
```

#### Upload Service Features
```bash
# Allowlist and balance
ALLOW_LISTED_ADDRESSES=addr1,addr2,addr3
SKIP_BALANCE_CHECKS=false

# Size limits
MAX_DATA_ITEM_SIZE=4294967296   # 4 GiB (default; single data-item ingest cap)
MAX_BUNDLE_SIZE=2147483648      # 2 GiB (default; target bundle packing size)
MAX_DATA_ITEM_LIMIT=10000
FREE_UPLOAD_LIMIT=517120        # ~505 KiB

# Raw data uploads (server-signed, x402 only)
RAW_DATA_UPLOADS_ENABLED=true
RAW_DATA_ITEM_JWK_FILE=./raw-data-wallet.json
```

#### PostgreSQL Configuration
```bash
POSTGRES_OFFSETS_TTL_SECS=31536000        # 365 days
POSTGRES_DATA_ITEM_BYTES_THRESHOLD=10240  # 10 KiB
```

#### Blockchain RPCs
```bash
ETHEREUM_RPC_ENDPOINT=https://eth.llamarpc.com
SOLANA_RPC_ENDPOINT=https://api.mainnet-beta.solana.com
MATIC_RPC_ENDPOINT=https://polygon-rpc.com
KYVE_RPC_ENDPOINT=https://rpc.kyve.network
BASE_ETH_RPC_ENDPOINT=https://mainnet.base.org
```

#### x402 Payment Protocol (Primary Payment Method)

**Core Settings:**
```bash
# Enable x402 protocol (default: true)
X402_ENABLED=true

# Payment recipient address (REQUIRED)
X402_PAYMENT_ADDRESS=0xYourWalletAddress

# Coinbase CDP credentials (REQUIRED for mainnet)
CDP_API_KEY_ID=your-key-id
CDP_API_KEY_SECRET=your-key-secret

# Browser paywall client key (optional - for Coinbase Onramp widget)
X_402_CDP_CLIENT_KEY=your-client-key
```

**Payment Behavior:**
```bash
# Default payment mode: payg | topup | hybrid
X402_DEFAULT_MODE=hybrid

# Payment authorization timeout (5 minutes default)
X402_PAYMENT_TIMEOUT_MS=300000

# Pricing buffer for volatility (15% default)
X402_PRICING_BUFFER_PERCENT=15

# Fraud detection tolerance (5% default)
X402_FRAUD_TOLERANCE_PERCENT=5
```

**Network Configuration:**
```bash
# Base Mainnet (primary network, enabled by default)
X402_BASE_ENABLED=true
BASE_MAINNET_RPC_URL=https://mainnet.base.org
X402_BASE_MIN_CONFIRMATIONS=1
X402_FACILITATOR_URL_BASE=https://facilitator.base.coinbasecloud.net

# Ethereum Mainnet (disabled by default)
X402_ETH_ENABLED=false
ETHEREUM_MAINNET_RPC_URL=https://cloudflare-eth.com/
X402_ETH_MIN_CONFIRMATIONS=3
X402_FACILITATOR_URL_ETH=https://facilitator.ethereum.coinbasecloud.net

# Polygon Mainnet (disabled by default)
X402_POLYGON_ENABLED=false
POLYGON_MAINNET_RPC_URL=https://polygon-rpc.com
X402_POLYGON_MIN_CONFIRMATIONS=10
X402_FACILITATOR_URL_POLYGON=https://facilitator.polygon.coinbasecloud.net

# Base Sepolia Testnet (for development)
X402_BASE_TESTNET_ENABLED=true
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
X402_FACILITATOR_URL_BASE_TESTNET=https://x402.org/facilitator
```

**External Dependencies:**
```bash
# CoinGecko API for AR/USD pricing (optional)
COINGECKO_API_KEY=your-api-key
```

**Important Notes:**
- CDP credentials are **required** for mainnet networks (Base, Ethereum, Polygon)
- Testnet networks (Base Sepolia) use public facilitator, no CDP credentials needed
- Get CDP credentials from: https://portal.cdp.coinbase.com/
- Browser paywall requires `X_402_CDP_CLIENT_KEY` for Coinbase Onramp integration
- Default network: Base Mainnet (fastest, lowest fees)

#### Stripe
```bash
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

#### Email (optional)
```bash
MANDRILL_API_KEY=<api-key>
```

#### Security
```bash
PRIVATE_ROUTE_SECRET=<openssl rand -hex 32>
JWT_SECRET=<openssl rand -hex 32>
ARIO_SIGNING_JWK=<json-jwk>
```

#### Observability
```bash
LOG_LEVEL=info
DISABLE_LOGS=false
HONEYCOMB_API_KEY=<api-key>
OTEL_SAMPLE_RATE=200  # 0.5%
```

#### PM2
```bash
NODE_ENV=production
API_INSTANCES=2
WORKER_INSTANCES=1
```

---

## Development

### Prerequisites

- Node.js 22 (required; .nvmrc v22.22.0)
- Yarn 3.6.0+
- Docker & Docker Compose
- PostgreSQL client (optional, for migrations)

### Setup

```bash
# Clone repository
git clone https://github.com/ar-io/ar-io-bundler.git
cd ar-io-bundler

# Install dependencies
yarn install

# Copy environment template
cp packages/upload-service/.env.sample packages/upload-service/.env

# Edit .env with your configuration
nano packages/upload-service/.env

# Start infrastructure
docker compose up -d

# Run database migrations
yarn db:migrate

# Build services
yarn build

# Start services with PM2
pm2 start infrastructure/pm2/ecosystem.config.js
```

### Development Workflow

**Watch Mode** (auto-recompile on changes):
```bash
# Terminal 1: Upload service
cd packages/upload-service
yarn start:watch

# Terminal 2: Payment service
cd packages/payment-service
yarn start:watch

# Terminal 3: Workers
cd packages/upload-service
yarn nodemon lib/workers/allWorkers.js
```

**Run Tests**:
```bash
# All unit tests
yarn test:unit

# Payment service tests
yarn workspace @ar-io-bundler/payment-service test:unit

# Upload service tests
yarn workspace @ar-io-bundler/upload-service test:unit

# Integration tests (requires running infrastructure)
yarn workspace @ar-io-bundler/upload-service test:integration:local
yarn workspace @ar-io-bundler/payment-service test:integration:local
```

**Code Quality**:
```bash
# Type checking
yarn typecheck

# Linting
yarn lint:check
yarn lint:fix

# Formatting
yarn format:check
yarn format:fix
```

**Database Operations**:
```bash
# Create new migration
yarn workspace @ar-io-bundler/upload-service db:migrate:new my_migration_name
yarn workspace @ar-io-bundler/payment-service db:migrate:new my_migration_name

# Run migrations
yarn db:migrate

# Rollback last migration
yarn workspace @ar-io-bundler/upload-service db:migrate:rollback
yarn workspace @ar-io-bundler/payment-service db:migrate:rollback

# List migrations
yarn workspace @ar-io-bundler/upload-service db:migrate:list
```

### Debugging

**VS Code Launch Config** (`.vscode/launch.json`):
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Upload Service",
      "runtimeArgs": ["-r", "ts-node/register"],
      "args": ["${workspaceFolder}/packages/upload-service/src/index.ts"],
      "env": {
        "NODE_ENV": "development"
      }
    },
    {
      "type": "node",
      "request": "launch",
      "name": "Payment Service",
      "runtimeArgs": ["-r", "ts-node/register"],
      "args": ["${workspaceFolder}/packages/payment-service/src/index.ts"],
      "env": {
        "NODE_ENV": "development"
      }
    }
  ]
}
```

**Inspect Database**:
```bash
# Connect to PostgreSQL
docker exec -it ar-io-bundler-postgres psql -U turbo_admin -d upload_service

# Common queries
SELECT COUNT(*) FROM new_data_item;
SELECT COUNT(*) FROM permanent_data_item;
SELECT * FROM bundle_plan ORDER BY planned_date DESC LIMIT 10;
```

**Inspect Redis**:
```bash
# Connect to Redis cache
docker exec -it ar-io-bundler-redis-cache redis-cli

# Connect to Redis queues
docker exec -it ar-io-bundler-redis-queues redis-cli -p 6381

# Common commands
KEYS *
GET key
HGETALL key
```

**Inspect MinIO**:
- Web UI: http://localhost:9001
- Username: minioadmin
- Password: minioadmin123

---

## Deployment

### Production Checklist

- [ ] Generate strong secrets (`openssl rand -hex 32`)
- [ ] Configure database credentials
- [ ] Set up Arweave wallet (fund with AR)
- [ ] Configure Stripe keys (if using)
- [ ] Set up email service (if using)
- [ ] Configure blockchain RPC endpoints
- [ ] Set up SSL/TLS certificates
- [ ] Configure reverse proxy (nginx/Caddy)
- [ ] Set up monitoring and alerts
- [ ] Configure log rotation (`pm2-logrotate` — see operations/ADMIN_GUIDE.md)
- [ ] Back up `.env` and `wallet.json` securely
- [ ] Configure firewall rules
- [ ] Set up database backups
- [ ] Configure MinIO backups/replication

### Docker Deployment

```bash
# Production docker-compose
docker compose -f docker-compose.prod.yml up -d

# Scale services
docker compose up --scale upload-api=4 --scale payment-service=2
```

### Manual Deployment

```bash
# Build
yarn build

# Start infrastructure
docker compose up -d postgres redis-cache redis-queues minio minio-init

# Run migrations
DB_HOST=localhost DB_PASSWORD=<password> yarn db:migrate

# Start with PM2
pm2 start infrastructure/pm2/ecosystem.config.js --env production

# Save PM2 process list
pm2 save

# Configure PM2 startup
pm2 startup

# Monitor
pm2 monit
```

### Reverse Proxy (nginx)

```nginx
# Upload Service
server {
    listen 80;
    server_name upload.yourdomain.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        client_max_body_size 10G;
    }
}

# Payment Service
server {
    listen 80;
    server_name payment.yourdomain.com;

    location / {
        proxy_pass http://localhost:4001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### Database Backups

**Automated Backups**:
```bash
#!/bin/bash
# backup.sh
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/backups"

# Backup upload_service
pg_dump -h localhost -U turbo_admin -d upload_service > $BACKUP_DIR/upload_service_$DATE.sql

# Backup payment_service
pg_dump -h localhost -U turbo_admin -d payment_service > $BACKUP_DIR/payment_service_$DATE.sql

# Compress
gzip $BACKUP_DIR/*.sql

# Remove old backups (keep 30 days)
find $BACKUP_DIR -name "*.sql.gz" -mtime +30 -delete
```

**Cron Schedule**:
```cron
0 2 * * * /path/to/backup.sh
```

### MinIO Replication

Configure MinIO server-side replication for production:
```bash
mc admin replicate add minio1/bucket minio2/bucket
```

### Scaling

**Horizontal Scaling**:
- Run multiple upload-api instances behind load balancer
- Run multiple payment-service instances
- Workers: Single instance recommended (avoid duplicate processing)

**Vertical Scaling**:
- Increase PM2 `API_INSTANCES` for more cluster workers
- Increase worker concurrency in `allWorkers.ts`
- Upgrade PostgreSQL/Redis resources

**Database Scaling**:
- PostgreSQL: Read replicas (configure `DB_READER_ENDPOINT`)
- Redis: Cluster mode (set `ELASTICACHE_NO_CLUSTERING=false`)

---

## Migration from AWS

> **Historical context.** This section documents the one-time de-AWS migration of
> ArDrive's upstream Turbo. It is background, not current operational guidance —
> the live architecture (BullMQ, PM2, PostgreSQL, MinIO) is described above. Any
> doc/comment/env var implying SQS/Lambda/DynamoDB/Secrets-Manager as *live*
> behavior is legacy framing.

This system has been completely migrated from AWS to open-source infrastructure.

### Previous AWS Services

| AWS Service | Replacement | Migration Path |
|-------------|-------------|----------------|
| **AWS Secrets Manager** | `.env` files | Moved all secrets to environment variables |
| **AWS Systems Manager (SSM)** | `.env` files | Consolidated parameter storage |
| **Amazon S3** | MinIO | Direct S3 API compatibility, changed endpoint |
| **Amazon DynamoDB** | PostgreSQL | Complete schema redesign with migrations |
| **Amazon SQS** | BullMQ (Redis) | Replaced message queues with BullMQ workers |
| **AWS Lambda** | PM2 Workers | Converted Lambda handlers to Node.js workers |
| **Amazon ECS** | PM2 | Replaced container orchestration |
| **Amazon ElastiCache** | Redis | Direct Redis compatibility |

### Key Changes

**Configuration Management**:
- Removed `aws-sdk` dependency
- Removed `loadSecretsToEnv()` function
- All config in `.env` file
- Environment variables used directly via `process.env`

**Database Migration**:
- DynamoDB tables → PostgreSQL tables
- Removed AWS DynamoDB client code
- Added Knex.js for SQL
- Migrated offset storage from DynamoDB to PostgreSQL `data_item_offsets` table
- Batch size increased from 25 (DynamoDB limit) to 500 (PostgreSQL batch insert)

**Queue Migration**:
- SQS queues → BullMQ queues (15 queues)
- Lambda handlers → Worker functions in `src/workers/`
- Message format preserved for compatibility
- Job concurrency configurable per worker

**Object Storage**:
- S3 bucket → MinIO buckets
- S3 SDK unchanged (API compatible)
- Changed `S3_ENDPOINT` to point to MinIO
- Added `S3_FORCE_PATH_STYLE=true` for MinIO

**Process Management**:
- ECS tasks → PM2 processes
- Cluster mode for APIs (horizontal scaling)
- Fork mode for workers (avoid duplication)
- Graceful shutdown handling

**Removed AWS-Specific Code**:
- Files: `src/arch/awsConfig.ts`, `src/arch/dynamoDbUtils.ts`
- Functions: `loadSecretsToEnv()`, `getDynamoClient()`
- Config keys: DynamoDB-related configuration
- Metrics: Removed "dynamodb" from circuit breaker sources

**Updated Comments**:
- Changed "DynamoDB" → "PostgreSQL" throughout codebase
- Updated architecture documentation
- Removed AWS references in logs

### Migration Benefits

- **Cost**: No AWS charges, only infrastructure costs
- **Control**: Full control over infrastructure and data
- **Portability**: Can run anywhere (local, VPS, dedicated servers)
- **Simplicity**: Fewer external dependencies
- **Performance**: PostgreSQL batching 20x larger than DynamoDB
- **Debugging**: Direct access to logs, databases, queues

### Compatibility Notes

- Message formats preserved (BullMQ jobs use same payloads as SQS)
- API contracts unchanged (clients unaffected)
- Database schema redesigned but functionality equivalent
- All tests passing (326/326 unit tests)

---

## Appendix

### Glossary

- **ANS-104**: Arweave standard for bundled data items
- **BDI**: Bundle Data Item (nested bundle within bundle)
- **Winc**: Winc (Winston Credit) - smallest unit of Arweave storage credit (10^-12 AR)
- **JWK**: JSON Web Key (Arweave wallet format)
- **ArNS**: Arweave Name System (decentralized naming)
- **Optical Posting**: Optimistic caching to AR.IO Gateway before Arweave confirmation
- **Circuit Breaker**: Fault tolerance pattern that prevents cascading failures

### File Structure

```
ar-io-bundler/
├── packages/
│   ├── payment-service/
│   │   ├── src/
│   │   │   ├── architecture.ts       # DI container
│   │   │   ├── server.ts             # Koa HTTP server
│   │   │   ├── router.ts             # Route definitions
│   │   │   ├── database/             # PostgreSQL layer
│   │   │   ├── gateway/              # Blockchain gateways
│   │   │   ├── pricing/              # Pricing service
│   │   │   ├── routes/               # Route handlers
│   │   │   ├── middleware/           # Koa middleware
│   │   │   └── migrations/           # Database migrations
│   │   ├── tests/                    # Test files
│   │   └── lib/                      # Compiled output
│   │
│   └── upload-service/
│       ├── src/
│       │   ├── arch/                 # Architecture components
│       │   │   ├── architecture.ts   # DI container
│       │   │   ├── db/               # Database layer
│       │   │   ├── queues.ts         # BullMQ integration
│       │   │   ├── payment.ts        # Payment service client
│       │   │   ├── s3ObjectStore.ts  # MinIO/S3 client
│       │   │   └── elasticacheService.ts  # Redis cache
│       │   ├── server.ts             # Koa HTTP server
│       │   ├── router.ts             # Route definitions
│       │   ├── routes/               # Route handlers
│       │   ├── jobs/                 # Job handlers
│       │   │   ├── plan.ts           # Bundle planning
│       │   │   ├── prepare.ts        # Bundle preparation
│       │   │   ├── post.ts           # Arweave posting
│       │   │   ├── verify.ts         # Verification
│       │   │   ├── optical-post.ts   # AR.IO integration
│       │   │   ├── unbundle-bdi.ts   # BDI unbundling
│       │   │   └── putOffsets.ts     # Offset storage
│       │   ├── workers/              # BullMQ workers
│       │   │   └── allWorkers.ts     # All 12 workers
│       │   ├── bundles/              # ANS-104 bundling
│       │   ├── migrations/           # Database migrations
│       │   └── constants.ts          # Configuration
│       ├── tests/                    # Test files
│       └── lib/                      # Compiled output
│
├── infrastructure/
│   ├── postgres/
│   │   └── init-databases.sql        # Database initialization
│   └── pm2/
│       └── ecosystem.config.js       # PM2 configuration
│
├── docker-compose.yml                # Infrastructure definition
├── package.json                      # Monorepo config
├── .env                              # Environment variables
└── ARCHITECTURE.md                   # This file
```

### Key Constants

From `packages/upload-service/src/constants.ts`:

```typescript
// Limits
MAX_DATA_ITEM_SIZE = 4GB (default)
MAX_BUNDLE_SIZE = 2GB (default)
MAX_DATA_ITEM_LIMIT = 10,000 items per bundle

// Thresholds
txPermanentThreshold = 18 blocks
txConfirmationThreshold = 1 block
retryLimitForFailedDataItems = 10

// Timeouts
POSTGRES_OFFSETS_TTL_SECS = 31,536,000 (365 days)
POSTGRES_DATA_ITEM_BYTES_THRESHOLD = 10,240 (10 KiB)

// Multipart
multipartChunkMinSize = 5 MiB
multipartChunkMaxSize = 500 MiB
multipartDefaultChunkSize = 25 MB
```

### Support & Resources

- **GitHub**: https://github.com/ar-io/ar-io-bundler
- **Arweave Docs**: https://docs.arweave.org
- **AR.IO Docs**: https://docs.ar.io
- **ANS-104 Spec**: https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-104.md

---

**Document Version**: 1.2.0
**Fully verified at**: 1.0.0 (2025-10-24); 1.2.0 = targeted corrections only (see banner at top)
**Author**: Claude Code (AI Assistant)
**Status**: Partial snapshot — defer to CLAUDE.md, docs/api/README.md, and the runbook for current details
