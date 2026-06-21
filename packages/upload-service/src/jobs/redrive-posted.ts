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
import winston from "winston";

import { Database } from "../arch/db/database";
import { PostgresDatabase } from "../arch/db/postgres";
import { enqueue } from "../arch/queues";
import {
  jobLabels,
  maxSeedRedrives,
  postedStaleThresholdMs,
} from "../constants";
import defaultLogger from "../logger";
import { MetricRegistry } from "../metricRegistry";
import { PlanId } from "../types/dbTypes";

interface RedrivePostedJobArch {
  database?: Database;
  logger?: winston.Logger;
  staleThresholdMs?: number;
  maxRedrives?: number;
  /** Injectable for testing; defaults to enqueuing a real seed-bundle job. */
  enqueueSeed?: (planId: PlanId) => Promise<void>;
}

const defaultEnqueueSeed = (planId: PlanId): Promise<void> =>
  enqueue(jobLabels.seedBundle, { planId });

/**
 * Re-drives bundles stranded in posted_bundle.
 *
 * Background: a posted_bundle whose seed-bundle job exhausts its BullMQ attempts
 * is otherwise stuck forever — its tx header is on chain but its chunks were
 * never seeded, and nothing re-scans posted_bundle (unlike seeded_bundle, which
 * verify re-scans every tick). This scheduled handler finds those stale rows and:
 *
 *   1. re-enqueues seed-bundle (giving the bundle another chance to seed), while
 *   2. counting re-drive attempts; once a bundle exceeds maxRedrives it is
 *      demoted to failed_bundle (items repacked → new_data_item) — LOUDLY, via a
 *      metric increment + error log, so the data loss is visible instead of silent.
 *
 * Concurrency 1 (registered in allWorkers.ts) is the overlap guard, mirroring the
 * plan scheduler: the row-level FOR UPDATE NOWAIT lock in getStalePostedBundles
 * means a second overlapping run simply selects nothing and returns.
 */
export async function redrivePostedHandler({
  database = new PostgresDatabase(),
  logger = defaultLogger.child({ job: "redrive-posted-job" }),
  staleThresholdMs = postedStaleThresholdMs,
  maxRedrives = maxSeedRedrives,
  enqueueSeed = defaultEnqueueSeed,
}: RedrivePostedJobArch): Promise<void> {
  const staleBundles = await database.getStalePostedBundles(staleThresholdMs);

  if (staleBundles.length === 0) {
    logger.info("No stale posted bundles to re-drive.");
    return;
  }

  logger.warn("Found stale posted bundles to re-drive", {
    count: staleBundles.length,
    staleThresholdMs,
    maxRedrives,
  });

  for (const bundle of staleBundles) {
    const { planId, bundleId } = bundle;
    try {
      const redriveCount = await database.incrementPostedBundleRedrive(
        planId,
        bundleId
      );

      if (redriveCount > maxRedrives) {
        // Exhausted re-drives: the bundle is never going to seed. Demote it so
        // its data items get repacked into a fresh bundle instead of being lost.
        // This is the loud path — metric + error log — so ops can alert on it.
        logger.error(
          "Posted bundle exhausted seed re-drives; demoting to failed_bundle (failedToSeed)",
          { planId, bundleId, redriveCount, maxRedrives }
        );
        await database.updatePostedBundleToFailed(planId, bundleId);
        MetricRegistry.postedBundleFailedToSeed.inc();
        MetricRegistry.postedBundleRedrive.inc({ result: "demoted" });
        continue;
      }

      await enqueueSeed(planId);
      logger.warn("Re-enqueued seed-bundle for stale posted bundle", {
        planId,
        bundleId,
        redriveCount,
        maxRedrives,
      });
      MetricRegistry.postedBundleRedrive.inc({ result: "reenqueued" });
    } catch (error) {
      // Isolate per-bundle failures: one bad row must not abort the whole sweep.
      logger.error("Failed to re-drive posted bundle", {
        planId,
        bundleId,
        error: error instanceof Error ? error.message : String(error),
      });
      MetricRegistry.postedBundleRedrive.inc({ result: "error" });
    }
  }
}

export async function handler(eventPayload?: unknown) {
  defaultLogger.info(
    `Redrive posted bundle job has been triggered with event payload:`,
    eventPayload
  );
  return redrivePostedHandler({});
}
