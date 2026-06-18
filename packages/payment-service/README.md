# AR.IO Bundler — Payment Service

The Payment Service handles payment processing, credit (Winston) management, and
blockchain payment-gateway integrations for the
[AR.IO Bundler](https://github.com/ar-io/ar-io-bundler) platform.

> A de-AWS fork of ArDrive's Turbo Payment Service. Background work runs on
> **BullMQ** (the `payment-workers` PM2 process), and all configuration loads from
> the shared repo-root `.env` — there is no AWS Secrets Manager/SSM.

## Supported payment methods

- **x402 (primary)**: HTTP 402 + USDC via EIP-3009 — see [examples/](../../examples/)
- **Cryptocurrency**: Arweave, Ethereum, Solana, Matic/POL, KYVE, Base-ETH
- **Stripe**: credit-card top-ups
- **Account credits**: balance with reservations/refunds
- **ArNS purchases**: Arweave Name System, settled on Solana via `@ar.io/sdk` v4

## x402 payment protocol

Implements Coinbase's x402 standard as the primary payment method:

- `GET /v1/x402/price/:signatureType/:address` — payment requirements (returns 402)
- `POST /v1/x402/payment/:signatureType/:address` — verify and settle
- `POST /v1/x402/finalize` — finalize with fraud detection
- `POST /v1/x402/top-up/:signatureType/:address` — top up a balance via x402

See [../../docs/guides/X402_INTEGRATION_GUIDE.md](../../docs/guides/X402_INTEGRATION_GUIDE.md)
and [examples/README.md](../../examples/README.md).

## Running locally

Requires Node 22 (`.nvmrc` v22.22.0), Yarn 3, and Docker. Most operators run the
whole platform from the repo root (see the root [README](../../README.md)); to run
just this service:

```bash
cp ../../.env.sample ../../.env   # single shared root .env
yarn
yarn build
yarn db:up                         # local Postgres + migrations
yarn start                         # or: yarn start:watch (hot reload)
```

Set `NODE_ENV=test` for local test runs. The API listens on `PAYMENT_SERVICE_PORT`
(default 4001).

> Crypto-payment credits are finalized by the **`payment-workers`** process
> (BullMQ). In production this is one of the five PM2 processes (started via
> `yarn pm2:start` from the repo root); without it, pending crypto credits never
> finalize.

## Database

Knex; database name `PAYMENT_DB_DATABASE` (default `payment_service`).

```bash
yarn db:up                 # start local Postgres (port 5432) + migrate
yarn db:down               # tear down the container and volume
yarn db:migrate:latest     # apply migrations
yarn db:migrate:list       # list applied migrations
yarn db:migrate:make NAME  # generate a new migration file
yarn db:migrate:rollback   # roll back the last migration
```

### Migration workflow
1. Add migration logic to `src/database/schema.ts` as a static function.
2. `yarn db:migrate:make MIGRATION_NAME` generates a file in `src/migrations/`.
3. Update the generated file to call that function.
4. `yarn db:migrate:latest`.

## Tests

```bash
yarn test:unit                 # unit tests (src/**/*.test.ts)
yarn test:integration:local    # integration tests against local Postgres
yarn test:integration:local -g "Router"   # targeted
yarn test:docker               # full suite in an isolated container
```

## License

GNU Affero General Public License v3.0 — see the repository [LICENSE](../../LICENSE).
