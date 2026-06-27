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
import { Job, Worker } from "bullmq";

import { PostgresDatabase } from "../database/postgres";
import {
  processArNSRefundJob,
  processStoreArNSMessageIdJob,
  reconcileStaleArNSPurchases,
} from "../jobs/arnsRefund";
import globalLogger from "../logger";
import { createRedisConnection } from "../queues/config";
import {
  arnsReconcileJobName,
  arnsRefundJobName,
  arnsRefundQueueName,
  arnsStoreMessageIdJobName,
  enqueueArNSRefund,
} from "../queues/producers";

// Orphaned-debit reconcile threshold. Default 30 min — comfortably longer than
// the store-message-id / refund retry backoff so a still-retrying job is not
// reconciled out from under itself.
function arnsStaleThresholdMs(): number {
  return parseInt(
    process.env.ARNS_RECEIPT_STALE_THRESHOLD_MS || `${30 * 60 * 1000}`,
  );
}

export function createArNSRefundWorker(): Worker {
  // Shared DB instance reused across all jobs.
  const paymentDatabase = new PostgresDatabase({});

  const worker = new Worker(
    arnsRefundQueueName,
    async (job: Job) => {
      const logger = globalLogger.child({
        jobId: job.id,
        queue: arnsRefundQueueName,
        name: job.name,
      });

      switch (job.name) {
        case arnsRefundJobName:
          return processArNSRefundJob({ paymentDatabase, logger }, job.data);
        case arnsStoreMessageIdJobName:
          return processStoreArNSMessageIdJob(
            { paymentDatabase, logger },
            job.data,
          );
        case arnsReconcileJobName:
          return void (await reconcileStaleArNSPurchases(
            { paymentDatabase, logger },
            enqueueArNSRefund,
            arnsStaleThresholdMs(),
          ));
        default:
          logger.warn("Unknown ArNS refund job name — ignoring");
          return;
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: parseInt(process.env.WORKER_CONCURRENCY_ARNS_REFUND || "3"),
    },
  );

  worker.on("failed", (job, err) => {
    globalLogger.error("ArNS refund job failed", {
      jobId: job?.id,
      queue: arnsRefundQueueName,
      name: job?.name,
      error: err.message,
      attemptsMade: job?.attemptsMade,
      attemptsTotal: job?.opts.attempts,
    });
  });

  worker.on("error", (err) => {
    globalLogger.error("ArNS refund worker error", {
      queue: arnsRefundQueueName,
      error: err.message,
    });
  });

  const shutdown = async (signal: string) => {
    globalLogger.info(`${signal} received, closing ArNS refund worker`);
    await worker.close();
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  return worker;
}
