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
import { Job, Worker, WorkerOptions } from "bullmq";
import winston from "winston";

import { QUEUE_NAMES } from "../arch/queues/config";
import { createRedisConnection } from "../arch/queues/redis";
import logger from "../logger";

export type JobHandler<T> = (job: Job<T>) => Promise<void>;

export function createWorker<T>(
  jobLabel: keyof typeof QUEUE_NAMES,
  handler: JobHandler<T>,
  options?: Partial<WorkerOptions>
): Worker {
  const queueName = QUEUE_NAMES[jobLabel];

  const worker = new Worker<T>(
    queueName,
    async (job: Job<T>) => {
      const jobLogger = logger.child({
        jobId: job.id,
        jobName: job.name,
        queueName,
      });

      jobLogger.info("Processing job", {
        attemptsMade: job.attemptsMade,
        data: job.data,
      });

      try {
        await handler(job);
        jobLogger.info("Job completed successfully");
      } catch (error) {
        jobLogger.error("Job failed", {
          error,
          attemptsMade: job.attemptsMade,
        });
        throw error; // Re-throw to trigger Bull MQ retry logic
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: options?.concurrency ?? 1,
      ...options,
    }
  );

  // Worker event listeners
  worker.on("completed", (job: Job) => {
    logger.debug(`Job ${job.id} completed`, {
      jobName: job.name,
      queueName,
    });
  });

  worker.on("failed", (job: Job | undefined, error: Error) => {
    logger.error(`Job ${job?.id} failed`, {
      jobName: job?.name,
      queueName,
      error: error.message,
      stack: error.stack,
    });
  });

  worker.on("error", (error: Error) => {
    logger.error(`Worker error for queue ${queueName}`, {
      error: error.message,
      stack: error.stack,
    });
  });

  return worker;
}

export function setupGracefulShutdown(
  workers: Worker[],
  workerLogger: winston.Logger
) {
  const shutdown = async (signal: string) => {
    workerLogger.info(`Received ${signal}, shutting down workers...`);

    await Promise.all(
      workers.map(async (worker) => {
        await worker.close();
        workerLogger.info(`Worker for queue ${worker.name} closed`);
      })
    );

    workerLogger.info("All workers shut down gracefully");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
