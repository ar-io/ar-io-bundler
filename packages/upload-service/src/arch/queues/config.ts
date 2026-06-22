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
import { Queue, QueueOptions } from "bullmq";

import { jobLabels } from "../../constants";
import { createRedisConnection } from "./redis";

export const QUEUE_NAMES = {
  [jobLabels.planBundle]: "upload-plan-bundle",
  [jobLabels.prepareBundle]: "upload-prepare-bundle",
  [jobLabels.postBundle]: "upload-post-bundle",
  [jobLabels.seedBundle]: "upload-seed-bundle",
  [jobLabels.verifyBundle]: "upload-verify-bundle",
  [jobLabels.putOffsets]: "upload-put-offsets",
  [jobLabels.newDataItem]: "upload-new-data-item",
  [jobLabels.opticalPost]: "upload-optical-post",
  [jobLabels.unbundleBdi]: "upload-unbundle-bdi",
  [jobLabels.finalizeUpload]: "upload-finalize-upload",
  [jobLabels.cleanupFs]: "upload-cleanup-fs",
  [jobLabels.redrivePosted]: "upload-redrive-posted",
} as const;

const defaultQueueOptions: QueueOptions = {
  connection: createRedisConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000,
    },
    removeOnComplete: {
      count: 1000,
      age: 86400, // 24 hours
    },
    removeOnFail: {
      count: 5000,
      age: 604800, // 7 days
    },
  },
};

const queueInstances = new Map<string, Queue>();

export function getQueue(jobLabel: keyof typeof QUEUE_NAMES): Queue {
  const queueName = QUEUE_NAMES[jobLabel];

  if (!queueInstances.has(queueName)) {
    queueInstances.set(queueName, new Queue(queueName, defaultQueueOptions));
  }

  return queueInstances.get(queueName)!;
}

export async function closeAllQueues(): Promise<void> {
  await Promise.all(
    Array.from(queueInstances.values()).map((queue) => queue.close())
  );
  queueInstances.clear();
}
