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

import logger from "../../logger";
import { tableNames } from "./dbConstants";

/**
 * Half-month range-partition management for the `permanent_data_items` table.
 *
 * The table is RANGE-partitioned by `uploaded_date` into two partitions per
 * month, matching the original scheme:
 *   [YYYY-MM-01, YYYY-MM-15)        -> permanent_data_items_MM_YYYY_01
 *   [YYYY-MM-15, next-month-01)     -> permanent_data_items_MM_YYYY_02
 *
 * A DEFAULT partition is the safety net for any date without an explicit
 * partition. Critically, new explicit partitions can be added ahead of time
 * ONLY while the DEFAULT partition is empty (Postgres scans DEFAULT for
 * conflicting rows when attaching a range partition). This scheduler keeps a
 * rolling lead of explicit partitions so DEFAULT stays empty — which is also why
 * the table must NOT use an open-ended `(... TO MAXVALUE)` catch-all partition:
 * that would permanently overlap (and thus block) any future explicit partition.
 */

export interface PartitionSpec {
  name: string;
  /** inclusive lower bound, 'YYYY-MM-DD' */
  from: string;
  /** exclusive upper bound, 'YYYY-MM-DD' */
  to: string;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The two half-month partition specs for a given year + month (1-12). */
export function halfMonthPartitionSpecsForMonth(
  year: number,
  month: number,
): PartitionSpec[] {
  const mm = pad2(month);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const base = tableNames.permanentDataItems;
  return [
    {
      name: `${base}_${mm}_${year}_01`,
      from: `${year}-${mm}-01`,
      to: `${year}-${mm}-15`,
    },
    {
      name: `${base}_${mm}_${year}_02`,
      from: `${year}-${mm}-15`,
      to: `${nextYear}-${pad2(nextMonth)}-01`,
    },
  ];
}

/**
 * All half-month specs for `monthCount` consecutive months starting at
 * (startYear, startMonth).
 */
export function halfMonthPartitionSpecs(
  startYear: number,
  startMonth: number,
  monthCount: number,
): PartitionSpec[] {
  const specs: PartitionSpec[] = [];
  let year = startYear;
  let month = startMonth;
  for (let i = 0; i < monthCount; i++) {
    specs.push(...halfMonthPartitionSpecsForMonth(year, month));
    if (month === 12) {
      year++;
      month = 1;
    } else {
      month++;
    }
  }
  return specs;
}

/**
 * Idempotently create each partition (CREATE TABLE IF NOT EXISTS ... PARTITION
 * OF). The date bounds are inlined (they are generated from integers, never user
 * input). Returns the partition names that were processed.
 */
export async function createPartitionsIfNotExist(
  knex: Knex,
  specs: PartitionSpec[],
): Promise<string[]> {
  for (const spec of specs) {
    await knex.raw(
      `CREATE TABLE IF NOT EXISTS ?? PARTITION OF ?? FOR VALUES FROM ('${spec.from}') TO ('${spec.to}')`,
      [spec.name, tableNames.permanentDataItems],
    );
  }
  return specs.map((s) => s.name);
}

/**
 * Ensure half-month partitions exist from the start of `now`'s month through
 * `monthsAhead` months in the future. Idempotent and safe to run on a schedule;
 * keeps the DEFAULT partition empty by always staying ahead of incoming rows.
 */
export async function ensurePermanentDataItemPartitions(
  knex: Knex,
  now: Date,
  monthsAhead = 12,
): Promise<string[]> {
  const startYear = now.getUTCFullYear();
  const startMonth = now.getUTCMonth() + 1; // getUTCMonth is 0-indexed
  const monthCount = monthsAhead + 1; // include the current month
  const specs = halfMonthPartitionSpecs(startYear, startMonth, monthCount);
  const ensured = await createPartitionsIfNotExist(knex, specs);
  logger.debug("Ensured permanent_data_items partitions", {
    from: `${startYear}-${pad2(startMonth)}`,
    monthsAhead,
    partitionCount: ensured.length,
  });
  return ensured;
}
