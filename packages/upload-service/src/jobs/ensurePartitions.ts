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

import { ensurePermanentDataItemPartitions } from "../arch/db/partitions";
import globalLogger from "../logger";

/**
 * Scheduled maintenance: pre-create the upcoming `permanent_data_items`
 * half-month partitions so the DEFAULT partition never has to absorb live rows
 * (an ever-growing DEFAULT/catch-all defeats partitioning and becomes painful to
 * carve out later). Idempotent — only missing partitions are created.
 */
export async function ensurePartitionsHandler({
  knex,
  now = new Date(),
  monthsAhead = parseInt(process.env.PARTITION_MONTHS_AHEAD || "12", 10),
}: {
  knex: Knex;
  now?: Date;
  monthsAhead?: number;
}): Promise<void> {
  const logger = globalLogger.child({ job: "ensure-partitions" });
  try {
    const ensured = await ensurePermanentDataItemPartitions(
      knex,
      now,
      monthsAhead,
    );
    logger.info("Ensured upcoming permanent_data_items partitions", {
      monthsAhead,
      partitionsEnsured: ensured.length,
    });
  } catch (error) {
    // Surface loudly — falling behind on partition creation eventually forces
    // live rows into DEFAULT, which is expensive to fix. Re-throw so BullMQ marks
    // the job failed (and the next scheduled tick retries).
    logger.error("Failed to ensure permanent_data_items partitions", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}
