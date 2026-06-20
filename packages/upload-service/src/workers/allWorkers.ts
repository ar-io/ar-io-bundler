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
// Load .env from the repository root BEFORE importing anything that reads
// process.env at module-eval time (arch/db config reads DB_USER/DB_PASSWORD;
// the wallet utils read TURBO_JWK_FILE). The API entry (src/index.ts) loads
// dotenv the same way; PM2's env_file injection is not reliable enough, so the
// worker process must self-load its env first — otherwise the DB connection
// falls back to user "postgres" (auth failure) and TURBO_JWK_FILE is missing.
import { config as loadEnvFile } from "dotenv";
import * as path from "path";
loadEnvFile({ path: path.join(__dirname, "../../../../.env") });

import { Job } from "bullmq";

import { defaultArchitecture } from "../arch/architecture";
import { PostgresDatabase } from "../arch/db/postgres";
import { knex as knexFactory } from "knex";

import { getWriterConfig } from "../arch/db/knexConfig";
import {
  EnqueuedNewDataItem,
  EnqueuedOffsetsBatch,
  EnqueueFinalizeUpload,
  upsertRepeatable,
} from "../arch/queues";
import { jobLabels } from "../constants";
import { handler as cleanupFsHandler } from "../jobs/cleanup-fs";
import { finalizeMultipartUpload } from "../routes/multiPartUploads";
import { UnbundleBDIMessageBody, unbundleBDIBatchHandler } from "../jobs/unbundle-bdi";
import { opticalPostHandler } from "../jobs/optical-post";
import { planBundleHandler } from "../jobs/plan";
import { postBundleHandler } from "../jobs/post";
import { prepareBundleHandler } from "../jobs/prepare";
import { putOffsetsHandler } from "../jobs/putOffsets";
import { seedBundleHandler } from "../jobs/seed";
import { verifyBundleHandler } from "../jobs/verify";
import { newDataItemBatchInsertHandler } from "../jobs/newDataItemBatchInsert";
import logger from "../logger";
import { createWorker, setupGracefulShutdown } from "./workerUtils";
import { DatedSignedDataItemHeader } from "../utils/opticalUtils";

const knex = knexFactory(getWriterConfig());
const database = new PostgresDatabase();

// Plan Bundle Worker - Runs continuously to plan new data items into bundles.
//
// planBundleHandler is a self-draining loop: a single invocation scans ALL
// pending data items and keeps planning until none remain (or it hits the
// ~14-min cap, plan.ts). Running multiple plan jobs concurrently therefore
// doesn't speed anything up — they just contend over the same rows (the handler
// itself runs at PARALLEL_LIMIT=1 for exactly this reason).
//
// OVERLAP GUARD: the in-process scheduler (below) fires plan-bundle on a fixed
// wall-clock tick (default every 5 min). If a prior drain is still running when
// the next tick fires, concurrency 1 makes the queued tick wait its turn rather
// than scanning in parallel. Hence the default is 1 (was 5); still env-tunable
// via PLAN_WORKER_CONCURRENCY, but raising it re-introduces overlap.
const planWorker = createWorker(
  jobLabels.planBundle,
  async () => {
    await planBundleHandler(database);
  },
  { concurrency: parseInt(process.env.PLAN_WORKER_CONCURRENCY || "1", 10) }
);

// Prepare Bundle Worker - Prepares bundles for posting
const prepareWorker = createWorker<{ planId: string }>(
  jobLabels.prepareBundle,
  async (job: Job<{ planId: string }>) => {
    await prepareBundleHandler(job.data.planId, {
      database,
      objectStore: defaultArchitecture.objectStore,
      cacheService: defaultArchitecture.cacheService,
    });
  },
  { concurrency: parseInt(process.env.PREPARE_WORKER_CONCURRENCY || "3", 10) }
);

// Post Bundle Worker - Posts bundles to Arweave
const postWorker = createWorker<{ planId: string }>(
  jobLabels.postBundle,
  async (job: Job<{ planId: string }>) => {
    await postBundleHandler(job.data.planId, {
      database,
      objectStore: defaultArchitecture.objectStore,
      arweaveGateway: defaultArchitecture.arweaveGateway,
    });
  },
  { concurrency: parseInt(process.env.POST_WORKER_CONCURRENCY || "2", 10) }
);

// Seed Bundle Worker - Seeds bundles to additional gateways
const seedWorker = createWorker<{ planId: string }>(
  jobLabels.seedBundle,
  async (job: Job<{ planId: string }>) => {
    await seedBundleHandler(job.data.planId, {
      database,
      objectStore: defaultArchitecture.objectStore,
    });
  },
  { concurrency: 2 }
);

// Verify Bundle Worker - Verifies bundle posting
const verifyWorker = createWorker<{ planId: string }>(
  jobLabels.verifyBundle,
  async (_job: Job<{ planId: string }>) => {
    await verifyBundleHandler({
      database,
      objectStore: defaultArchitecture.objectStore,
      arweaveGateway: defaultArchitecture.arweaveGateway,
    });
  },
  { concurrency: parseInt(process.env.VERIFY_WORKER_CONCURRENCY || "3", 10) }
);

// Put Offsets Worker - Writes offsets to PostgreSQL
const putOffsetsWorker = createWorker<EnqueuedOffsetsBatch>(
  jobLabels.putOffsets,
  async (job: Job<EnqueuedOffsetsBatch>) => {
    await putOffsetsHandler(job.data.offsets, knex, logger);
  },
  { concurrency: 5 }
);

// New Data Item Worker - Batch inserts new data items
const newDataItemWorker = createWorker<EnqueuedNewDataItem>(
  jobLabels.newDataItem,
  async (job: Job<EnqueuedNewDataItem>) => {
    await newDataItemBatchInsertHandler({
      dataItemBatch: [job.data],
      logger,
      uploadDatabase: database,
    });
  },
  { concurrency: 5 }
);

// Optical Post Worker - Posts to optical bridge
const opticalWorker = createWorker<DatedSignedDataItemHeader>(
  jobLabels.opticalPost,
  async (job: Job<DatedSignedDataItemHeader>) => {
    // Call the optical post handler directly with the job data
    await opticalPostHandler({
      stringifiedDataItemHeaders: [JSON.stringify(job.data)],
      logger,
    });
  },
  { concurrency: 5 }
);

// Unbundle BDI Worker - Unbundles nested bundle data items
const unbundleWorker = createWorker<UnbundleBDIMessageBody>(
  jobLabels.unbundleBdi,
  async (job: Job<UnbundleBDIMessageBody>) => {
    await unbundleBDIBatchHandler(
      [{ Body: JSON.stringify(job.data) } as any],
      logger,
      defaultArchitecture.cacheService
    );
  },
  { concurrency: 2 }
);

// Finalize Upload Worker - Finalizes multipart uploads
const finalizeWorker = createWorker<EnqueueFinalizeUpload>(
  jobLabels.finalizeUpload,
  async (job: Job<EnqueueFinalizeUpload>) => {
    await finalizeMultipartUpload({
      uploadId: job.data.uploadId,
      paymentService: defaultArchitecture.paymentService,
      objectStore: defaultArchitecture.objectStore,
      database,
      arweaveGateway: defaultArchitecture.arweaveGateway,
      getArweaveWallet: defaultArchitecture.getArweaveWallet,
      logger,
      asyncValidation: false, // Worker mode - synchronous validation
      token: job.data.token,
      paidBy: job.data.paidBy,
    });
  },
  { concurrency: 3 }
);

// Cleanup FS Worker - Cleans up temporary filesystem artifacts
const cleanupWorker = createWorker(
  jobLabels.cleanupFs,
  async () => {
    await cleanupFsHandler();
  },
  { concurrency: 1 }
);

const allWorkers = [
  planWorker,
  prepareWorker,
  postWorker,
  seedWorker,
  verifyWorker,
  putOffsetsWorker,
  newDataItemWorker,
  opticalWorker,
  unbundleWorker,
  finalizeWorker,
  cleanupWorker,
];

setupGracefulShutdown(allWorkers, logger);

logger.info("All BullMQ workers started successfully", {
  workerCount: allWorkers.length,
  queues: allWorkers.map((w) => w.name),
});

// ---------------------------------------------------------------------------
// In-process job schedulers (replaces the external cron-trigger-*.sh crons).
//
// Registered here in the always-running worker so the bundle-planning and
// tiered-cleanup schedules can never be silently "forgotten" (the old failure
// mode: a cron that was never added to crontab, or one that couldn't find
// `node` on cron's minimal PATH). BullMQ dedupes each schedule by id in the
// shared queue Redis, so this stays correct even if the worker is ever run
// multi-instance / multi-box — exactly one job fires per interval.
//
// Patterns are env-overridable; set a pattern to "" to disable that schedule.
// The cron-trigger-*.sh / trigger-*.js scripts remain as MANUAL dev triggers.
// ---------------------------------------------------------------------------
const PLAN_SCHEDULE_CRON = process.env.PLAN_SCHEDULE_CRON ?? "*/5 * * * *";
const CLEANUP_SCHEDULE_CRON = process.env.CLEANUP_SCHEDULE_CRON ?? "0 2 * * *";

async function registerJobSchedulers() {
  // planId is cosmetic — planBundleHandler ignores job data and scans the DB.
  await upsertRepeatable(
    jobLabels.planBundle,
    "plan-bundle-scheduler",
    PLAN_SCHEDULE_CRON,
    { planId: "scheduler" }
  );
  await upsertRepeatable(
    jobLabels.cleanupFs,
    "cleanup-fs-scheduler",
    CLEANUP_SCHEDULE_CRON,
    {}
  );
  logger.info("Registered BullMQ job schedulers", {
    planBundle: PLAN_SCHEDULE_CRON || "(disabled)",
    cleanupFs: CLEANUP_SCHEDULE_CRON || "(disabled)",
  });
}

// Register with bounded retry/backoff. A transient Redis/network hiccup at
// startup must NOT silently leave the schedules unregistered (the exact
// silent-failure mode this change exists to kill) and must NOT crash the
// workers either. So we retry on a backoff instead of giving up after one log;
// upsert is idempotent, so retries are safe.
const SCHEDULER_REGISTRATION_MAX_RETRIES = 5;
const SCHEDULER_REGISTRATION_BASE_DELAY_MS = 5_000;

async function registerJobSchedulersWithRetry(attempt = 0): Promise<void> {
  try {
    await registerJobSchedulers();
  } catch (error) {
    const retriesLeft = SCHEDULER_REGISTRATION_MAX_RETRIES - attempt;
    logger.error("Failed to register BullMQ job schedulers", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      attempt,
      retriesLeft,
    });
    if (retriesLeft > 0) {
      const delayMs = SCHEDULER_REGISTRATION_BASE_DELAY_MS * (attempt + 1);
      setTimeout(() => {
        void registerJobSchedulersWithRetry(attempt + 1);
      }, delayMs);
    } else {
      logger.error(
        "Giving up registering BullMQ job schedulers after max retries; " +
          "restart upload-workers to re-attempt (plan/cleanup will not run until then)",
        { maxRetries: SCHEDULER_REGISTRATION_MAX_RETRIES }
      );
    }
  }
}

void registerJobSchedulersWithRetry();
