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
  ArweaveGateway,
  EthereumGateway,
  KyveGateway,
  MaticGateway,
  SolanaGateway,
} from "../gateway";
import { ARIOGateway } from "../gateway/ario";
import { BaseEthGateway } from "../gateway/base-eth";
import { creditPendingTransactionsHandler } from "../jobs/creditPendingTx";
import globalLogger from "../logger";
import { MetricRegistry } from "../metricRegistry";
import { TurboPricingService } from "../pricing/pricing";
import { createRedisConnection } from "../queues/config";

export function createPendingTxWorker(): Worker {
  // Create shared database and services instances (reused across all jobs)
  const paymentDatabase = new PostgresDatabase({});
  const pricingService = new TurboPricingService();
  const gatewayMap = {
    arweave: new ArweaveGateway(),
    ario: new ARIOGateway({
      logger: globalLogger,
    }),
    ethereum: new EthereumGateway(),
    solana: new SolanaGateway(),
    ed25519: new SolanaGateway(),
    kyve: new KyveGateway(),
    matic: new MaticGateway(),
    pol: new MaticGateway(),
    "base-eth": new BaseEthGateway(),
  };

  const worker = new Worker(
    "payment-pending-tx",
    async (job: Job) => {
      const jobLogger = globalLogger.child({
        jobId: job.id,
        queue: "payment-pending-tx",
      });

      jobLogger.info("Processing pending tx job");

      const startTime = Date.now();

      try {
        await creditPendingTransactionsHandler({
          paymentDatabase,
          pricingService,
          gatewayMap,
          logger: jobLogger,
        });

        const duration = (Date.now() - startTime) / 1000;

        jobLogger.info("Pending tx job completed", { duration });
      } catch (error) {
        MetricRegistry.creditPendingTxJobFailure.inc();

        jobLogger.error("Pending tx job failed", {
          error: error instanceof Error ? error.message : error,
          stack: error instanceof Error ? error.stack : undefined,
        });

        throw error; // Re-throw to trigger retry
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: parseInt(process.env.WORKER_CONCURRENCY_PENDING_TX || "1"),
      limiter: {
        max: 10,
        duration: 60000, // Max 10 jobs per minute
      },
    },
  );

  worker.on("completed", (job) => {
    globalLogger.info("Job completed", {
      jobId: job.id,
      queue: "payment-pending-tx",
    });
  });

  worker.on("failed", (job, err) => {
    globalLogger.error("Job failed", {
      jobId: job?.id,
      queue: "payment-pending-tx",
      error: err.message,
      attemptsMade: job?.attemptsMade,
      attemptsTotal: job?.opts.attempts,
    });
  });

  worker.on("error", (err) => {
    globalLogger.error("Worker error", {
      queue: "payment-pending-tx",
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
