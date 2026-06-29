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
import { Queue } from "bullmq";

import { DestinationAddressType } from "../database/dbTypes";
import globalLogger from "../logger";
import { defaultQueueOptions } from "./config";

let pendingTxQueue: Queue | null = null;
let adminCreditQueue: Queue | null = null;
let arnsRefundQueue: Queue | null = null;

export const arnsRefundQueueName = "payment-arns-refund";
// Job names processed on the ArNS refund queue.
export const arnsRefundJobName = "refund";
export const arnsStoreMessageIdJobName = "store-message-id";
export const arnsReconcileJobName = "reconcile-stale";

export function getPendingTxQueue(): Queue {
  if (!pendingTxQueue) {
    pendingTxQueue = new Queue("payment-pending-tx", defaultQueueOptions);
  }
  return pendingTxQueue;
}

export function getAdminCreditQueue(): Queue {
  if (!adminCreditQueue) {
    adminCreditQueue = new Queue("payment-admin-credit", defaultQueueOptions);
  }
  return adminCreditQueue;
}

export function getArNSRefundQueue(): Queue {
  if (!arnsRefundQueue) {
    arnsRefundQueue = new Queue(arnsRefundQueueName, defaultQueueOptions);
  }
  return arnsRefundQueue;
}

export async function schedulePendingTxCheck(): Promise<void> {
  const queue = getPendingTxQueue();

  await queue.add(
    "check-pending-tx",
    {}, // Empty data - handler will fetch all pending tx from database
    {
      repeat: {
        pattern: "*/60 * * * * *", // Every 60 seconds
      },
      jobId: "pending-tx-cron", // Prevents duplicate cron jobs
    },
  );

  globalLogger.info("Pending TX cron job scheduled");
}

export interface AdminCreditJobData {
  addresses: string[];
  creditAmount: number;
  addressType?: DestinationAddressType;
  giftMessage?: string;
}

export async function enqueueAdminCredit(
  data: AdminCreditJobData,
): Promise<string> {
  const queue = getAdminCreditQueue();

  const job = await queue.add("admin-credit", data, {
    priority: 1, // High priority
    attempts: 5, // More retries for admin operations
  });

  globalLogger.info("Admin credit job enqueued", { jobId: job.id });

  return job.id!;
}

export interface ArNSRefundJobData {
  nonce: string;
  reason: string;
}

export interface StoreArNSMessageIdJobData {
  nonce: string;
  messageId: string;
}

/**
 * Durably refund a debited-but-failed ArNS purchase. Used both on the request
 * critical path (when the synchronous refund itself fails) and by the
 * reconciler. Keyed by nonce so the sync path and the reconciler de-duplicate.
 */
export async function enqueueArNSRefund(
  data: ArNSRefundJobData,
): Promise<string> {
  const queue = getArNSRefundQueue();

  const job = await queue.add(arnsRefundJobName, data, {
    jobId: `arns-refund-${data.nonce}`, // dedupe sync-path + reconciler
    attempts: 10, // money-back: retry hard through an extended outage
    backoff: { type: "exponential", delay: 5000 },
  });

  globalLogger.info("ArNS refund job enqueued", {
    jobId: job.id,
    nonce: data.nonce,
  });

  return job.id!;
}

/**
 * Durably store the on-chain message_id for a purchase whose write SUCCEEDED
 * (the name was bought) but whose message_id write failed. Must never refund —
 * the name is already paid for on-chain.
 */
export async function enqueueStoreArNSMessageId(
  data: StoreArNSMessageIdJobData,
): Promise<string> {
  const queue = getArNSRefundQueue();

  const job = await queue.add(arnsStoreMessageIdJobName, data, {
    jobId: `arns-store-msgid-${data.nonce}`,
    attempts: 10,
    backoff: { type: "exponential", delay: 5000 },
  });

  globalLogger.info("ArNS store-message-id job enqueued", {
    jobId: job.id,
    nonce: data.nonce,
  });

  return job.id!;
}

/**
 * Repeatable backstop: scans for debits that were orphaned (no message_id, past
 * the stale threshold — e.g. the process died mid-request) and enqueues refunds.
 */
export async function scheduleArNSReconcile(): Promise<void> {
  const queue = getArNSRefundQueue();

  await queue.add(
    arnsReconcileJobName,
    {},
    {
      repeat: {
        pattern: process.env.ARNS_RECONCILE_CRON || "*/5 * * * *",
      },
      jobId: "arns-reconcile-cron", // Prevents duplicate cron jobs
    },
  );

  globalLogger.info("ArNS reconcile cron job scheduled");
}

// Graceful shutdown
export async function closeQueues(): Promise<void> {
  const queues = [pendingTxQueue, adminCreditQueue, arnsRefundQueue].filter(
    (q) => q !== null,
  );

  await Promise.all(queues.map((q) => q!.close()));

  globalLogger.info("All queues closed");
}
