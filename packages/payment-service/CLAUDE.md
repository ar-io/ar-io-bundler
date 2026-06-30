# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the **AR.IO Bundler Payment Service** — a Node.js service that handles
cryptocurrency payments (Arweave, Ethereum, Solana, Matic/POL, KYVE, Base-ETH),
x402 USDC payments, Stripe card payments, and credit management for the AR.IO
Bundler platform. It manages user balances (Winston credits), payment receipts,
delegated payment approvals, and ArNS (Arweave Name System) purchases.

> This is a de-AWS fork of ArDrive's Turbo Payment Service. The original ran on
> AWS (SQS consumers, Secrets Manager/SSM). **That is no longer the case.**
> Background work runs on **BullMQ** (the `payment-workers` PM2 process) and all
> configuration loads from the repo-root `.env` — `loadSecretsToEnv()` is now just
> a dotenv loader (the AWS Secrets Manager/SSM integration was removed).

## Key Commands

Run from `packages/payment-service/` (or via `yarn workspace @ar-io-bundler/payment-service <script>`).

```bash
# Setup
yarn                 # Install dependencies (Node 22 required)
yarn build           # Clean and compile TypeScript to lib/
yarn db:up           # Start PostgreSQL in Docker and run migrations
yarn start           # Run the compiled service (lib/index.js)
yarn start:watch     # Hot reload via nodemon (loads .env)

# Testing (Mocha + nyc)
yarn test:unit                          # Unit tests (src/**/*.test.ts)
yarn test:integration:local             # Integration tests against local docker postgres
yarn test:integration:local -g "Router" # Targeted integration tests
yarn test                               # All unit + integration tests
yarn test:docker                        # Full suite in an isolated container

# Code Quality
yarn lint:check / yarn lint:fix
yarn format:check / yarn format:fix
yarn typecheck

# Database migrations (Knex)
yarn db:migrate:latest                  # Apply pending migrations
yarn db:migrate:rollback                # Roll back the last migration
yarn db:migrate:list                    # List applied migrations
yarn db:migrate:make MIGRATION_NAME     # Create a new migration file
```

> Migration creation here is `yarn db:migrate:make` (the upload-service uses
> `db:migrate:new`). There is no `db:migrate:new` script in this package.

### Creating migrations
1. Add migration logic to `src/database/schema.ts` as a static function.
2. `yarn db:migrate:make MIGRATION_NAME` generates a file in `src/migrations/`.
3. Update the generated file to call your function from step 1.
4. `yarn db:migrate:latest` to apply it.

## Architecture Overview

### Core dependency-injection pattern

The service centers on an `Architecture` interface (`src/architecture.ts`)
injected into the Koa middleware context. The concrete object is built inline in
`src/server.ts` and injected via `src/middleware/architecture.ts` (there is no
`defaultArchitecture` export here).

```typescript
interface Architecture {
  paymentDatabase: Database;
  pricingService: PricingService;
  stripe: Stripe;
  emailProvider?: EmailProvider;   // optional (gifting/notifications)
  gatewayMap: GatewayMap;
  x402Service: X402Service;
}
```

### Application structure

**Entry point (`src/index.ts`)** — starts the HTTP server via `createServer()`.

**HTTP server (`src/server.ts`)** — Koa REST API on port 4001 by default
(`PAYMENT_SERVICE_PORT`, see `defaultPort` in `src/constants.ts`). JWT middleware
runs in passthrough mode; routes enforce auth themselves. Calls
`loadSecretsToEnv()` (dotenv) at boot.

**Background workers (`src/workers/index.ts`)** — a separate process (PM2's
`payment-workers`, fork mode, single instance) running two **BullMQ** workers:
1. **Pending payment TX worker** (`creditPendingTx.worker.ts`) — credits accounts
   once blockchain transactions confirm. A recurring producer schedules the check.
2. **Admin credit tool worker** (`adminCreditTool.worker.ts`) — bulk credit
   operations for administration.

The worker process self-loads the repo-root `.env` before importing modules that
validate config at import time (e.g. `X402_PAYMENT_ADDRESS`).

### Key components

**Database layer (`src/database/`)** — the `Database` interface with
`PostgresDatabase` (Knex) as the implementation. Migrations in `src/migrations/`;
types/mappings in `dbTypes.ts` / `dbMaps.ts`. Database name comes from
`PAYMENT_DB_DATABASE` (default `payment_service`).

**Gateway layer (`src/gateway/`)** — an abstract `Gateway` and per-chain
implementations: `arweave.ts`, `ethereum.ts`, `solana.ts`, `matic.ts`, `kyve.ts`,
`base-eth.ts`, plus `x402.ts` and the ArNS gateways `ario.ts` / `solana-ario.ts`
(see below). Gateways handle transaction verification, balance checks, and address
validation, polling each chain for confirmations.

**Pricing service (`src/pricing/`)** — `PricingService` / `TurboPricingService`
with oracles: `BytesToWinstonOracle` (bytes → Winston) and `TokenToFiatOracle`
(crypto → fiat). `src/pricing/pricing.ts` also applies a **flat per-data-item USD
surcharge** (`USD_PRICE_PER_DATA_ITEM`, default `0.00002`) on top of the byte
price across price/reserve/check. The bytes→Winston oracle can be pointed at a
self-hosted gateway via `PRICE_ORACLE_GATEWAY_URL` (vertical integration; avoids
arweave.net rate limits).

**Routes (`src/routes/`)** — see "Routes" below.

**Middleware (`src/middleware/`)** — `verifySignature` (validates request
signatures), `architecture` (injects DI context), and request/response logging.

### Routes

- **x402 (primary)** — `GET /v1/x402/price/:signatureType/:address`,
  `POST /v1/x402/payment/:signatureType/:address`, `POST /v1/x402/finalize`,
  `POST /v1/x402/top-up/:signatureType/:address`
  (handlers: `x402Price.ts`, `x402Payment.ts`, `x402Finalize.ts`, `x402TopUp.ts`,
  `x402PaywallHtml.ts`)
- **Pricing** — `/v1/price/*` (`priceBytes.ts`, `priceFiat.ts`, `priceCrypto.ts`),
  `/v1/rates`, `arweaveCompatiblePrice.ts`
- **Balance** — `GET /v1/balance`, `GET /v1/account/balance[/:token]`,
  `/v1/reserve-balance`, `/v1/refund-balance`, `/v1/check-balance`
- **Top-up / redeem** — `GET /v1/top-up/:method/:address/:currency/:amount`,
  `/v1/redeem`
- **Crypto funding (pending tx)** — `POST /v1/account/balance/:token` →
  `addPendingPaymentTx.ts`
- **Stripe** — `POST /v1/stripe-webhook` → `stripe/stripeRoute.ts`
- **ArNS** — `GET /v1/arns/price/:intent/:name`,
  `POST /v1/arns/purchase/:intent/:name`, `GET /v1/arns/purchase/:nonce`,
  `GET /v1/arns/quote/...`; custody routes (action-bound signature):
  `POST /v1/arns/transfer/:antId`, `POST /v1/arns/manage/:antId/{set,remove}-record`
- **Delegated payment approvals** — create / get / get-all / revoke

### ArNS purchases (Solana-ARIO, @ar.io/sdk v4)

ArNS purchases settle on **Solana** with the SPL ARIO token, using
**`@ar.io/sdk` v4** (ESM-only — this is the main reason **Node 22 is required**).

- `src/gateway/solana-ario.ts` — `SolanaARIOGateway`, built on `@ar.io/sdk`
  (`SolanaARIOReadable`/`SolanaARIOWriteable`, ARIO mints, RPC URLs) plus
  `@solana/kit` / `@solana/web3.js`. Reads `ARIO_SOLANA_SIGNER_SECRET_KEY` (bs58
  Solana secret key) to authorize writes; if unset, ArNS is **read-only** (price/
  quote work, purchases disabled). Mint/RPC default to devnet in dev/test and
  mainnet otherwise (override via `ARIO_MINT_ADDRESS` / `ARIO_GATEWAY_URL`).
- `src/gateway/ario.ts` — `ARIOGateway extends SolanaARIOGateway`, wired into
  `gatewayMap.ario` and used by `initiateArNSPurchase.ts`.
- The ARIO payment recipient is `ARIO_ADDRESS` (falls back to `SOLANA_ADDRESS`);
  the service **fails closed at boot** if neither is set, so ARIO payments can
  never silently credit the wrong wallet.

> This replaces the old Arweave-based `ARIO_SIGNING_JWK` write path for ARIO.

**Custody Model A — provisioning, exit, manage** (the `processId`→`antId` rename:
the ANT is a Solana asset, the gateway calls it `x-arns-ant-id`):
- `initiateArNSPurchase.ts` — a Buy with **no** `antId` provisions a fresh
  Turbo-owned ANT (`spawnAnt`) and records the user↔ANT link in `user_ant`. Gated
  by `ARNS_PROVISIONING_ENABLED` (default off — otherwise a no-`antId` buy is a
  400, enforced in `validators.ts`). Optional `ANT_SPAWN_WINC_SURCHARGE` recovers
  the spawn SOL rent.
- `transferArNSAnt.ts` (`/transfer`) — cooperative exit: transfer the ANT to a
  user Solana pubkey; `manageArNSAnt.ts` (`/manage/...`) — set/remove resolution
  records. Both gated by `verifyArNSCustodySignature` (`src/utils/arnsCustodySignature.ts`):
  an **action-bound** signature over `arns\n<action>\n<antId>\n<params>` + a
  **single-use nonce** (`arnsNonceStore.ts`, Redis `SET NX EX`, fails closed → 503).
  Ownership checked against `user_ant`; not-found/not-yours both 404.

**Money-path safety** — `arns_purchase_receipt.status` lifecycle
(`reserved → spawned → bought → recorded`) is the success signal (NOT
`message_id`): `markArNSPurchaseBought` is set the instant the buy confirms,
before message_id; the spawned `antId` is persisted **before** the buy
(anti-orphan). The `payment-arns-refund` queue's `reconcile-stale` job + the
synchronous failure path both **confirm on-chain** (`getArNSRecord`) before
refunding — never refund a name that actually landed; fail safe on gateway
errors. Files: `src/jobs/arnsRefund.ts`, `src/workers/arnsRefund.worker.ts`,
`src/queues/producers.ts`. Tunables: `ARNS_RECONCILE_CRON`,
`ARNS_RECEIPT_STALE_THRESHOLD_MS`, `ARNS_NONCE_TTL_SECONDS`, `ARNS_MIN/MAX_TTL_SECONDS`.

### Data flow examples

**Stripe payment** — checkout session → `POST /v1/stripe-webhook` →
`stripeRoute` event handlers → payment receipt → credits added.

**Crypto payment** — `POST /v1/account/balance/:token` → `addPendingPaymentTx`
stores it "pending" → the **BullMQ** pending-tx worker polls the chain → on
confirmation, credits applied, receipt created, tx marked "credited".

**ArNS purchase** — `GET /v1/arns/price/:intent/:name` → quote →
`POST /v1/arns/purchase/:intent/:name` → `initiateArNSPurchase` computes the ARIO
cost, creates a receipt, and calls `ario.initiateArNSPurchase(...)` (Solana).

### x402 payment protocol (primary flow)

Coinbase's x402 (HTTP 402 + USDC) is the primary payment method.

1. **Price quote** — `GET /v1/x402/price/:signatureType/:address` returns
   **402 Payment Required** with `X-Payment-Required: x402-1` and a
   `PaymentRequirements` object (scheme `exact`, network, `maxAmountRequired` in
   USDC's 6-decimal unit, `payTo`, `asset` USDC contract, timeout, etc.).
2. **Verify & settle** — `POST /v1/x402/payment/:signatureType/:address` validates
   the base64 `X-PAYMENT` header (EIP-712 signature over an EIP-3009
   authorization) and settles the USDC transfer.
3. **Finalize** — `POST /v1/x402/finalize` runs fraud detection comparing the
   declared byte count vs. the actual data-item size, refunding/penalizing on
   discrepancy.

**Implementation:** `src/routes/x402Price.ts`, `x402Payment.ts`, `x402Finalize.ts`;
`src/gateway/x402.ts`; x402 pricing oracle in `src/pricing/`.

**Payment modes:** `payg` (this upload only), `topup` (credit balance), `hybrid`
(pay for upload + top up the remainder — default, `X402_DEFAULT_MODE`).

**Smart-contract wallets:** ERC-1271 signature verification is supported.

**Standards:** x402 (https://github.com/coinbase/x402), EIP-3009
(TransferWithAuthorization), EIP-712 (typed-data signing).

## Important Implementation Notes

### Configuration
- All config loads from the repo-root `.env` (via dotenv). No AWS Secrets
  Manager/SSM. Set `NODE_ENV=test` for local test runs.
- Notable required vars: `PRIVATE_ROUTE_SECRET`, `X402_PAYMENT_ADDRESS` (when x402
  enabled), `STRIPE_SECRET_KEY` (when Stripe enabled).

### Address types
Supports multiple `DestinationAddressType`s: `arweave`, `ethereum`, `solana` /
`ed25519`, `kyve`, `matic` / `pol`, `base-eth`, and `email` (gifting). Validation
lives in `src/utils/`. Ethereum-family addresses are normalized to their EIP-55
checksum form via `src/utils/normalizeEthereumAddress.ts` so the same wallet maps
to one canonical balance regardless of input casing.

### Balance reservations
`reserveBalance` locks credits for a pending upload; `refundBalance` releases them.
This prevents double-spending across multi-step operations.

### Type system
Domain types in `src/types/`: `Winston`/`W` (10⁻¹² AR), `ByteCount`,
`PositiveFiniteInteger` — strong typing prevents bytes/Winston/fiat confusion.

### Testing patterns
- Unit tests co-located in `src/` (`*.test.ts`); integration tests in `tests/`.
- `yarn test:integration:local` manages the postgres lifecycle; helpers in
  `tests/dbTestHelper.ts`.

### Backward compatibility
Maintains legacy ArDrive/Arweave-ecosystem routes (`/account/balance/:token`,
Arconnect-compatible price routes) for older clients.

## Development Workflow
1. Make changes.
2. `yarn typecheck`.
3. `yarn lint:fix` and `yarn format:fix`.
4. Run tests (`yarn test:unit` / `yarn test:integration:local`).
5. For schema changes, follow the migration steps above.
