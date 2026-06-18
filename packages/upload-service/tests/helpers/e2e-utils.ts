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
import { Queue, QueueEvents } from "bullmq";
import { Knex } from "knex";
import * as knex from "knex";
import axios from "axios";

import { getWriterConfig } from "../../src/arch/db/knexConfig";
import { createRedisConnection } from "../../src/arch/queues/redis";
import { QUEUE_NAMES } from "../../src/arch/queues/config";
import { getS3ObjectStore } from "../../src/utils/objectStoreUtils";
import logger from "../../src/logger";

export interface E2ETestContext {
  database: Knex;
  redis: any;
  objectStore: any;
  baseUrl: string;
}

/**
 * Setup test context for E2E tests
 */
export async function setupE2EContext(): Promise<E2ETestContext> {
  const database = knex.default(getWriterConfig());
  const redis = createRedisConnection();
  const objectStore = getS3ObjectStore();
  const baseUrl = process.env.TEST_BASE_URL || "http://localhost:3001";

  return { database, redis, objectStore, baseUrl };
}

/**
 * Cleanup test context
 */
export async function cleanupE2EContext(context: E2ETestContext) {
  await context.database?.destroy();
  context.redis?.disconnect();
}

/**
 * Clear all BullMQ queues
 */
export async function clearAllQueues(redis: any) {
  const queueNames = Object.values(QUEUE_NAMES);

  for (const queueName of queueNames) {
    try {
      const queue = new Queue(queueName, { connection: redis });
      await queue.obliterate({ force: true });
      logger.debug(`Cleared queue: ${queueName}`);
    } catch (err) {
      logger.warn(`Failed to clear queue ${queueName}:`, err);
    }
  }
}

/**
 * Wait for a job to complete in a queue
 */
export async function waitForJobCompletion(
  queueName: string,
  redis: any,
  timeoutMs = 10000
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const queueEvents = new QueueEvents(queueName, { connection: redis });
    const timeout = setTimeout(() => {
      void queueEvents.close();
      resolve(false);
    }, timeoutMs);

    queueEvents.on("completed", () => {
      clearTimeout(timeout);
      void queueEvents.close();
      resolve(true);
    });

    queueEvents.on("failed", (err) => {
      clearTimeout(timeout);
      void queueEvents.close();
      reject(err);
    });
  });
}

/**
 * Verify MinIO object exists
 */
export async function verifyMinIOObject(
  objectStore: any,
  key: string
): Promise<boolean> {
  try {
    await objectStore.headObject(key);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Get MinIO object content
 */
export async function getMinIOObject(
  objectStore: any,
  key: string
): Promise<Buffer> {
  const { readable } = await objectStore.getObject(key);

  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

/**
 * Verify PostgreSQL record exists
 */
export async function verifyPostgresRecord(
  database: Knex,
  table: string,
  where: Record<string, any>
): Promise<boolean> {
  const result = await database(table).where(where).first();
  return !!result;
}

/**
 * Check if AR.IO Gateway is available
 */
export async function isARIOGatewayAvailable(
  gatewayUrl = "http://localhost:3000"
): Promise<boolean> {
  try {
    const response = await axios.get(`${gatewayUrl}/`, {
      timeout: 2000,
      validateStatus: () => true,
    });
    return response.status === 200;
  } catch (err) {
    return false;
  }
}

/**
 * Check if AR.IO Core API is available
 */
export async function isARIOCoreAvailable(
  coreUrl = "http://localhost:4000"
): Promise<boolean> {
  try {
    const response = await axios.get(`${coreUrl}/`, {
      timeout: 2000,
      validateStatus: () => true,
    });
    return response.status === 200;
  } catch (err) {
    return false;
  }
}

/**
 * Wait for condition to be true
 */
export async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs = 10000,
  checkIntervalMs = 500
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
  }

  return false;
}

/**
 * Create a test data item with random data
 */
export function createRandomDataItem(sizeBytes: number): Buffer {
  return Buffer.alloc(sizeBytes, Math.floor(Math.random() * 256));
}

/**
 * Measure function execution time
 */
export async function measureTime<T>(
  fn: () => Promise<T>
): Promise<{ result: T; timeMs: number }> {
  const startTime = Date.now();
  const result = await fn();
  const timeMs = Date.now() - startTime;

  return { result, timeMs };
}

/**
 * Get queue statistics
 */
export async function getQueueStats(queueName: string, redis: any) {
  const queue = new Queue(queueName, { connection: redis });
  const jobCounts = await queue.getJobCounts();

  return {
    waiting: jobCounts.waiting,
    active: jobCounts.active,
    completed: jobCounts.completed,
    failed: jobCounts.failed,
    delayed: jobCounts.delayed,
    total:
      jobCounts.waiting +
      jobCounts.active +
      jobCounts.completed +
      jobCounts.failed +
      jobCounts.delayed,
  };
}

/**
 * Clean up test data from PostgreSQL
 */
export async function cleanupTestData(
  database: Knex,
  dataItemIds: string[]
) {
  if (dataItemIds.length === 0) return;

  await database("new_data_item")
    .whereIn("data_item_id", dataItemIds)
    .del();

  await database("data_item_offsets")
    .whereIn("data_item_id", dataItemIds)
    .del();

  logger.debug(`Cleaned up ${dataItemIds.length} test data items`);
}

/**
 * Clean up test data from MinIO
 */
export async function cleanupMinIOTestData(
  objectStore: any,
  keys: string[]
) {
  for (const key of keys) {
    try {
      await objectStore.deleteObject(key);
      logger.debug(`Deleted MinIO object: ${key}`);
    } catch (err) {
      logger.warn(`Failed to delete MinIO object ${key}:`, err);
    }
  }
}

/**
 * Verify all infrastructure is running
 */
export async function verifyInfrastructure(context: E2ETestContext): Promise<{
  database: boolean;
  redis: boolean;
  minio: boolean;
  uploadService: boolean;
  arioGateway: boolean;
}> {
  const results = {
    database: false,
    redis: false,
    minio: false,
    uploadService: false,
    arioGateway: false,
  };

  // Check PostgreSQL
  try {
    await context.database.raw("SELECT 1");
    results.database = true;
  } catch (err) {
    logger.warn("PostgreSQL not available:", err);
  }

  // Check Redis
  try {
    await context.redis.ping();
    results.redis = true;
  } catch (err) {
    logger.warn("Redis not available:", err);
  }

  // Check MinIO
  try {
    await context.objectStore.headObject("health-check");
  } catch (err: any) {
    // 404 is expected, but connection should work
    results.minio = err.name !== "NetworkingError";
  }

  // Check Upload Service
  try {
    const response = await axios.get(`${context.baseUrl}/v1/`, {
      timeout: 2000,
    });
    results.uploadService = response.status === 200;
  } catch (err) {
    logger.warn("Upload Service not available:", err);
  }

  // Check AR.IO Gateway
  results.arioGateway = await isARIOGatewayAvailable();

  return results;
}
