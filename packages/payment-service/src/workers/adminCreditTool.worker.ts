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
import { MandrillEmailProvider } from "../emailProvider";
import { addCreditsToAddresses } from "../jobs/addCreditsToAddresses";
import globalLogger from "../logger";
import { MetricRegistry } from "../metricRegistry";
import { AdminCreditJobData } from "../queues/producers";
import { createRedisConnection } from "../queues/config";
import { isValidUserAddress } from "../utils/base64";
import { sendSlackMessage } from "../utils/slack";

class AdminCreditToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminCreditToolInputError";
  }
}

export function createAdminCreditWorker(): Worker {
  const paymentDatabase = new PostgresDatabase({});
  const emailProvider = process.env.MANDRILL_API_KEY
    ? new MandrillEmailProvider(process.env.MANDRILL_API_KEY)
    : undefined;

  const worker = new Worker<AdminCreditJobData>(
    "payment-admin-credit",
    async (job: Job<AdminCreditJobData>) => {
      const jobLogger = globalLogger.child({
        jobId: job.id,
        queue: "payment-admin-credit",
      });

      jobLogger.info("Processing admin credit job", { data: job.data });

      const startTime = Date.now();

      try {
        const {
          addresses,
          creditAmount,
          addressType = "arweave",
          giftMessage,
        } = job.data;

        // Validation
        if (!addresses || !creditAmount || !addresses.length) {
          throw new AdminCreditToolInputError(
            `Missing required fields: addresses and creditAmount`
          );
        }

        if (addressType !== "email") {
          for (const address of addresses) {
            if (!isValidUserAddress(address, addressType)) {
              throw new AdminCreditToolInputError(
                `Invalid address for ${addressType} address type: ${address}`
              );
            }
          }
        }

        // Process credits
        await addCreditsToAddresses({
          paymentDatabase,
          emailProvider,
          logger: jobLogger,
          addresses,
          addressType,
          creditAmount,
          giftMessage,
        });

        const duration = (Date.now() - startTime) / 1000;

        jobLogger.info("Admin credit job completed", {
          duration,
          addressCount: addresses.length,
        });
      } catch (error) {
        MetricRegistry.adminCreditToolJobFailure.inc();

        // Send Slack notification for failures
        await sendSlackMessage({
          message: `Error processing admin credit tool message:\n${
            error instanceof Error ? error.message : error
          }`,
          icon_emoji: ":x:",
        });

        jobLogger.error("Admin credit job failed", {
          error: error instanceof Error ? error.message : error,
          stack: error instanceof Error ? error.stack : undefined,
        });

        // Don't retry input validation errors
        if (error instanceof AdminCreditToolInputError) {
          jobLogger.warn(
            "Input validation error - job will not be retried",
            { error: error.message }
          );
          return; // Mark as complete (failed but don't retry)
        }

        throw error; // Re-throw to trigger retry
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: parseInt(
        process.env.WORKER_CONCURRENCY_ADMIN_CREDIT || "2"
      ),
      limiter: {
        max: 10,
        duration: 60000, // Max 10 jobs per minute
      },
    }
  );

  worker.on("completed", (job) => {
    globalLogger.info("Job completed", {
      jobId: job.id,
      queue: "payment-admin-credit",
    });
  });

  worker.on("failed", (job, err) => {
    globalLogger.error("Job failed", {
      jobId: job?.id,
      queue: "payment-admin-credit",
      error: err.message,
      attemptsMade: job?.attemptsMade,
      attemptsTotal: job?.opts.attempts,
    });
  });

  worker.on("error", (err) => {
    globalLogger.error("Worker error", {
      queue: "payment-admin-credit",
      error: err.message,
    });
  });

  const shutdown = async (signal: string) => {
    globalLogger.info(`${signal} received, closing worker gracefully`);
    await worker.close();
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  return worker;
}
