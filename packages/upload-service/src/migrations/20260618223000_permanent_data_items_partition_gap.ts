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
import { Knex } from "knex";

/**
 * Migration: close the permanent_data_items DECEMBER-2025 partition gap and add
 * a DEFAULT catch-all partition.
 *
 * PartitionedPermanentDataItemsMigrator created monthly half-partitions only up
 * to 2025-11 and a `_future` partition starting 2026-01-01 — leaving all of
 * December 2025 with NO partition. Any data item with an uploaded_date in that
 * gap fails the verify-bundle permanent insert ("no partition of relation
 * permanent_data_items found for row"). Because verify inserts a whole bundle's
 * items in one batch, a single gap-dated row fails the entire batch, so the job
 * retries forever and every item in that bundle is stranded in planned_data_item.
 *
 * Fix: create the missing Dec-2025 partitions, then add a DEFAULT partition so
 * NO uploaded_date can ever fail to route again (defense-in-depth against any
 * future gap). Specific partitions are created before DEFAULT so DEFAULT only
 * ever holds rows no explicit range covers. Idempotent (IF NOT EXISTS) so it is
 * safe on environments where the gap was already patched by hand.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.raw(`
    CREATE TABLE IF NOT EXISTS permanent_data_items_12_2025_01 PARTITION OF permanent_data_items
      FOR VALUES FROM ('2025-12-01') TO ('2025-12-15');

    CREATE TABLE IF NOT EXISTS permanent_data_items_12_2025_02 PARTITION OF permanent_data_items
      FOR VALUES FROM ('2025-12-15') TO ('2026-01-01');

    CREATE TABLE IF NOT EXISTS permanent_data_items_default PARTITION OF permanent_data_items DEFAULT;
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Drop DEFAULT first so the specific Dec-2025 partitions can be removed without
  // leaving rows unroutable mid-rollback.
  await knex.schema.raw(`
    DROP TABLE IF EXISTS permanent_data_items_default;
    DROP TABLE IF EXISTS permanent_data_items_12_2025_02;
    DROP TABLE IF EXISTS permanent_data_items_12_2025_01;
  `);
}
