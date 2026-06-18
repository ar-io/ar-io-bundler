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
import { Job } from "bullmq";
import { knex as knexFactory } from "knex";

import { getWriterConfig } from "../arch/db/knexConfig";
import { EnqueuedOffsetsBatch } from "../arch/queues";
import { jobLabels } from "../constants";
import { putOffsetsHandler } from "../jobs/putOffsets";
import logger from "../logger";
import { createWorker, setupGracefulShutdown } from "./workerUtils";

const knex = knexFactory(getWriterConfig());

const worker = createWorker<EnqueuedOffsetsBatch>(
  jobLabels.putOffsets,
  async (job: Job<EnqueuedOffsetsBatch>) => {
    await putOffsetsHandler(job.data.offsets, knex, logger);
  },
  {
    concurrency: 5, // Can handle multiple offset batches in parallel
  }
);

setupGracefulShutdown([worker], logger);

logger.info("Put Offsets worker started", {
  queueName: worker.name,
  concurrency: 5,
});
