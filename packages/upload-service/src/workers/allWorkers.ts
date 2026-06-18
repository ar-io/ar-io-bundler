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
import { getWriterConfig } from "../arch/db/knexConfig";
import {
  EnqueuedNewDataItem,
  EnqueuedOffsetsBatch,
  EnqueueFinalizeUpload,
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

const knex = require("knex")(getWriterConfig());
const database = new PostgresDatabase();

// Plan Bundle Worker - Runs continuously to plan new data items into bundles
// Planning can run concurrently for different bundle sizes/types
// Higher concurrency reduces queue backlog under high load
// Memory usage: ~50MB per concurrent planning operation
const planWorker = createWorker(
  jobLabels.planBundle,
  async () => {
    await planBundleHandler(database);
  },
  { concurrency: parseInt(process.env.PLAN_WORKER_CONCURRENCY || "5", 10) }
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
