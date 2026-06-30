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
import { jobLabels } from "../constants";
import { UnbundleBDIMessageBody } from "../jobs/unbundle-bdi";
import { PlanId, PostedNewDataItem } from "../types/dbTypes";
import { ChunkHeader, DataItemOffsetsInfo, UploadId } from "../types/types";
import { DatedSignedDataItemHeader } from "../utils/opticalUtils";
import { getQueue } from "./queues/config";

type PlanMessage = { planId: PlanId };

// seed-bundle carries an optional cap deadline that the chunk-broadcast
// TX-confirmation gate threads across its self-re-enqueues (chunkBroadcastGate.ts).
type SeedBundleMessage = PlanMessage & { chunkGateDeadlineMs?: number };

export type EnqueuedNewDataItem = Omit<PostedNewDataItem, "signature"> & {
  signature: string;
};
export type EnqueueFinalizeUpload = {
  uploadId: UploadId;
  token: string;
  paidBy?: string[];
  // Client IP captured at the HTTP finalize request, carried through to the
  // worker so per-IP free-upload metering (PE-9011) is enforced on the async
  // validation path too — not skipped because the queued message lost the IP.
  ipAddress?: string;
};
export type EnqueuedOffsetsBatch = {
  offsets: DataItemOffsetsInfo[];
};
// Copy one object-store key (raw-data-item/{id} or bundle-payload/{planId}) from
// the primary (bundler) store to the archive store. The handler no-ops when
// the archive store is not configured.
export type ArchiveCopyMessage = {
  key: string;
};
type QueueTypeToMessageType = {
  [jobLabels.planBundle]: PlanMessage;
  [jobLabels.prepareBundle]: PlanMessage;
  [jobLabels.postBundle]: PlanMessage;
  [jobLabels.seedBundle]: SeedBundleMessage;
  [jobLabels.verifyBundle]: PlanMessage;
  [jobLabels.opticalPost]: DatedSignedDataItemHeader;
  [jobLabels.unbundleBdi]: UnbundleBDIMessageBody;
  [jobLabels.finalizeUpload]: EnqueueFinalizeUpload;
  [jobLabels.newDataItem]: EnqueuedNewDataItem;
  [jobLabels.putOffsets]: EnqueuedOffsetsBatch;
  [jobLabels.cleanupFs]: Record<string, never>;
  [jobLabels.redrivePosted]: Record<string, never>;
  [jobLabels.refundBalance]: RefundBalanceMessage;
  [jobLabels.broadcastChunks]: ChunkHeader;
  [jobLabels.archiveCopy]: ArchiveCopyMessage;
  [jobLabels.ensurePartitions]: Record<string, never>;
};

// Durable refund retry payload. winstonCredits is the Winston value serialized
// to a string (BullMQ messages are JSON), reconstructed in the worker.
export type RefundBalanceMessage = {
  nativeAddress: string;
  winstonCredits: string;
  dataItemId: string;
  signatureType: number;
};

export type QueueType = keyof QueueTypeToMessageType;

// Optical-post retry policy. More attempts + a longer exponential backoff than
// the global default (3 / 5s, see queues/config.ts) so the retry schedule
// STRADDLES the optical circuit-breaker's open window
// (OPTICAL_BREAKER_RESET_TIMEOUT_MS, default 30s). Under a BDI optical fan-out
// burst the breaker opens for ~30s; with the global default all 3 retries fell
// inside that single window and the post was permanently lost. 15s exponential
// → roughly 15s / 30s / 60s / 120s, so a later attempt lands after the gateway
// recovers. Tunable via OPTICAL_POST_ATTEMPTS / OPTICAL_POST_BACKOFF_MS.
const opticalPostAttempts = Math.max(
  1,
  Number.parseInt(process.env.OPTICAL_POST_ATTEMPTS || "5", 10) || 5
);
const opticalPostBackoffMs = Math.max(
  1000,
  Number.parseInt(process.env.OPTICAL_POST_BACKOFF_MS || "15000", 10) || 15000
);

// Per-queue job options, centralized so BOTH enqueue() and the batched
// enqueueBatch() apply the same policy. This matters for optical-post: the BDI
// fan-out enqueues via enqueueBatch, which previously passed NO options, so
// those posts silently inherited only the global default retry policy.
const jobOptionsFor = (queueType: QueueType): Record<string, unknown> => {
  const jobOptions: Record<string, unknown> = {};
  if (queueType === jobLabels.seedBundle) {
    jobOptions.timeout = 300000; // 5 minutes for seed jobs
  }
  if (queueType === jobLabels.refundBalance) {
    // Durable refund: retry persistently (≈ many hours) so a wallet is always
    // credited back, even through an extended payment-service outage.
    jobOptions.attempts = 50;
    jobOptions.backoff = { type: "exponential", delay: 30000 };
  }
  if (queueType === jobLabels.opticalPost) {
    jobOptions.attempts = opticalPostAttempts;
    jobOptions.backoff = { type: "exponential", delay: opticalPostBackoffMs };
  }
  return jobOptions;
};

export const enqueue = async <T extends QueueType>(
  queueType: T,
  message: QueueTypeToMessageType[T],
  options?: { delay?: number; timeout?: number }
) => {
  const queue = getQueue(queueType);

  const jobOptions = jobOptionsFor(queueType);

  // Apply custom options if provided
  if (options?.delay) {
    jobOptions.delay = options.delay;
  }
  if (options?.timeout) {
    jobOptions.timeout = options.timeout;
  }

  await queue.add(queueType, message, jobOptions);
};

export const enqueueBatch = async <T extends QueueType>(
  queueType: T,
  messages: QueueTypeToMessageType[T][]
) => {
  if (messages.length === 0) return;

  const queue = getQueue(queueType);
  const opts = jobOptionsFor(queueType);
  await queue.addBulk(
    messages.map((message) => ({
      name: queueType,
      data: message,
      opts,
    }))
  );
};

/**
 * Register (or update) a repeatable BullMQ job scheduler — the in-process
 * replacement for the external `cron-trigger-*.sh` crons.
 *
 * Idempotent by `schedulerId`: BullMQ stores the schedule in the (shared) queue
 * Redis and dedupes by id, so even if several worker processes/boxes that share
 * the same queue Redis call this on startup, exactly ONE job is produced per
 * interval. (Do NOT replace this with `setInterval` — that would double-fire
 * per instance.)
 *
 * An empty/whitespace `pattern` is treated as "disabled": any existing scheduler
 * with this id is removed and no new one is created, so ops can turn a schedule
 * off via env (e.g. `PLAN_SCHEDULE_CRON=""`) without a code change.
 *
 * Teardown note: schedulers persist in Redis. To stop one for good (e.g. if this
 * feature is reverted), call `getQueue(queueType).removeJobScheduler(id)` — or
 * set the corresponding `*_SCHEDULE_CRON` env to "" and restart — otherwise the
 * schedule keeps firing.
 *
 * @param pattern A cron expression (e.g. every-5-minutes), passed to BullMQ.
 */
export const upsertRepeatable = async <T extends QueueType>(
  queueType: T,
  schedulerId: string,
  pattern: string,
  data: QueueTypeToMessageType[T]
): Promise<void> => {
  const queue = getQueue(queueType);
  const trimmed = pattern.trim();

  if (trimmed === "") {
    // Disabled: drop any previously-registered scheduler with this id.
    await queue.removeJobScheduler(schedulerId);
    return;
  }

  await queue.upsertJobScheduler(
    schedulerId,
    { pattern: trimmed },
    { name: queueType, data }
  );
};

// BullMQ workers will automatically acknowledge completed jobs
// Workers are created in src/workers/ directory and managed via PM2
