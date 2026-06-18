# AR.IO Bundler — Upload Service

The Upload Service accepts data uploads (single-request or multipart) and bundles
[ANS-104](https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-104.md)
data items for reliable delivery to [Arweave](https://arweave.org). It integrates
with the sibling [`payment-service`](../payment-service/) for credit management and
payments.

> Part of the [AR.IO Bundler](https://github.com/ar-io/ar-io-bundler) monorepo, a
> de-AWS fork of ArDrive's Turbo. The fulfillment pipeline runs on **BullMQ**
> workers (Redis), managed by **PM2**; data items and offsets live in
> **PostgreSQL**; object storage is **S3-compatible MinIO**. (The original AWS
> design — SQS/Lambda/DynamoDB/S3 — has been replaced.)

Data items can be signed by clients with Arweave, Ethereum, or Solana keys, or
signed by the bundler itself for unsigned/x402 uploads.

## Payment methods

- **x402 (primary)**: HTTP 402 + USDC via EIP-3009 — see [examples/](../../examples/)
- **Account balance**: traditional credit-based uploads
- **Free uploads**: allowlist-based, for authorized addresses

## Upload methods

### Client-signed ANS-104 uploads
The client builds and signs its own ANS-104 data item (Arweave/Ethereum/Solana),
single-request or multipart (up to 10 GiB), with full control over tags.

### Unsigned / raw uploads (x402 only)
For agents/apps without wallet-signing capability:
- The client POSTs raw bytes to `POST /x402/upload/unsigned`.
- The bundler returns an HTTP 402 USDC quote; the client pays via an EIP-712
  `transferWithAuthorization` signature in the `X-PAYMENT` header.
- The **bundler signs the ANS-104 item with its own server wallet**
  (`RAW_DATA_ITEM_JWK_FILE`), stores it, optical-bridges it, and returns a
  signed receipt.
- ERC-1271 smart-contract-wallet signatures are supported for verification.

Tags added to raw items include `Bundler` (from `APP_NAME`), `Upload-Type`,
`Payer-Address`, `Upload-Timestamp`, and any `X-Tag-*` headers.

## Running locally

Requires Node 22 (`.nvmrc` v22.22.0), Yarn 3, and Docker. Most operators run the
whole platform from the repo root (see the root [README](../../README.md)); to run
just this service:

```bash
cp ../../.env.sample ../../.env   # single shared root .env
yarn
yarn build
yarn db:up && yarn db:migrate:latest   # local Postgres + migrations
yarn start                              # or: yarn start:watch (hot reload)
```

The API listens on `UPLOAD_SERVICE_PORT` (default 3001). Visit `/api-docs` for the
OpenAPI documentation.

> The BullMQ pipeline needs the bundle-planning cron (`cron-trigger-plan.sh`) and,
> optionally, the cleanup cron (`cron-trigger-cleanup.sh`). See the root README,
> step "Setup Bundle Planning Cron Job".

## Database

Knex with separate reader/writer connections; database name `UPLOAD_DB_DATABASE`
(default `upload_service`).

```bash
yarn db:up                 # start local Postgres (port 5432) + migrate
yarn db:down               # tear down the container and volume
yarn db:migrate:latest     # apply migrations
yarn db:migrate:list       # list applied migrations
yarn db:migrate:new NAME   # generate a new migration file
yarn db:migrate:rollback   # roll back the last migration
```

### Migration workflow
1. Add migration logic to `src/arch/db/migrator.ts` (not the generated file).
2. `yarn db:migrate:new MIGRATION_NAME` generates a file in `src/arch/db/migrations/`.
3. Update the generated file to call your migrator function.
4. `yarn db:migrate:latest`.

> `db:migrate:new` chains `yarn prettier:fix`, which is misnamed (the script is
> `format:fix`), so the final step errors after the file is created — just run
> `yarn format:fix` yourself.

## Tests

```bash
yarn test:unit                 # unit tests (src/**/*.test.ts)
yarn test:integration:local    # integration tests (Postgres + ArLocal), under .env.test
yarn test:integration:local -g "Router"   # targeted
yarn test:e2e:local            # end-to-end (tests/e2e-*.test.ts) against local infra
yarn test:docker               # full suite in an isolated container
```

## License

GNU Affero General Public License v3.0 — see the repository [LICENSE](../../LICENSE).
