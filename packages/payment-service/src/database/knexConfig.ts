/**
 * Copyright (C) 2022-2024 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import KnexDialect from "knex/lib/dialects/postgres";
import path from "path";

// Connection-pool sizing. Honors DB_POOL_MIN/DB_POOL_MAX so the payment service
// can be tuned the same way the upload service already is (previously the
// payment service silently used knex's defaults of min 2 / max 10 and ignored
// these env vars).
const poolSizing = {
  min: parseInt(process.env.DB_POOL_MIN || "5", 10),
  max: parseInt(process.env.DB_POOL_MAX || "50", 10),
  acquireTimeoutMillis: parseInt(process.env.DB_ACQUIRE_TIMEOUT || "10000", 10),
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || "30000", 10),
  reapIntervalMillis: parseInt(process.env.DB_REAP_INTERVAL || "1000", 10),
};

// Per-session safety timeouts set on every APP connection via afterCreate. A
// runaway query or a leaked open transaction can otherwise pin a pooled
// connection — and any row locks it holds — indefinitely. statement_timeout=0
// disables (Postgres semantics). These are deliberately NOT applied to the
// migration runner (knexfile.ts uses getMigrationConfig), whose long DDL must
// not be killed by a statement timeout.
const statementTimeoutMs = parseInt(
  process.env.DB_STATEMENT_TIMEOUT_MS || "60000",
  10,
);
const idleInTransactionTimeoutMs = parseInt(
  process.env.DB_IDLE_IN_TX_TIMEOUT_MS || "60000",
  10,
);

function afterCreateSetTimeouts(
  conn: { query: (sql: string, cb: (err: Error | null) => void) => void },
  done: (err: Error | null, conn: unknown) => void,
) {
  conn.query(
    `SET statement_timeout = ${statementTimeoutMs}; SET idle_in_transaction_session_timeout = ${idleInTransactionTimeoutMs};`,
    (err: Error | null) => done(err, conn),
  );
}

// App pools (writer/reader) get the per-session timeouts; the migration pool
// does not.
const appPool = {
  ...poolSizing,
  afterCreate: afterCreateSetTimeouts,
};

const baseConfig = {
  client: KnexDialect,
  version: "13.8",
  migrations: {
    tableName: "knex_migrations",
    directory: path.join(__dirname, "../migrations"),
  },
  pool: appPool,
  acquireConnectionTimeout: parseInt(
    process.env.DB_ACQUIRE_TIMEOUT || "10000",
    10,
  ),
};

function getDbConnection(host: string) {
  const dbPort = +(process.env.DB_PORT || 5432);
  const dbUser = process.env.DB_USER || "postgres";
  const dbPassword = process.env.DB_PASSWORD || "postgres";
  const dbName = process.env.PAYMENT_DB_DATABASE || "payment_service";

  return `postgres://${dbUser}:${dbPassword}@${host}:${dbPort}/${dbName}?sslmode=disable`;
}

export function getWriterConfig() {
  const dbHost =
    process.env.DB_WRITER_ENDPOINT || process.env.DB_HOST || "127.0.0.1";
  return {
    ...baseConfig,
    connection: getDbConnection(dbHost),
  };
}

export function getReaderConfig() {
  const dbHost =
    process.env.DB_READER_ENDPOINT ||
    process.env.DB_WRITER_ENDPOINT ||
    process.env.DB_HOST ||
    "127.0.0.1";
  return {
    ...baseConfig,
    connection: getDbConnection(dbHost),
  };
}

// Migration-runner config (knexfile.ts). Same host/pool sizing as the writer,
// but WITHOUT the statement/idle timeouts — long DDL such as
// CREATE INDEX CONCURRENTLY or a partition re-carve must not be killed mid-run.
export function getMigrationConfig() {
  return {
    ...getWriterConfig(),
    pool: poolSizing,
  };
}
