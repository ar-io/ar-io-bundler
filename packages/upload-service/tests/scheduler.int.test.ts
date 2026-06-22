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
import { expect } from "chai";

import { getQueue } from "../src/arch/queues/config";
import { upsertRepeatable } from "../src/arch/queues";
import { jobLabels } from "../src/constants";

// Coverage for the in-process BullMQ job schedulers added in #25
// (upsertRepeatable), which replaced the external cron-trigger-*.sh crons. Uses
// the real queue Redis (redis-queues) the harness provides. A unique scheduler
// id keeps this isolated from the production plan-bundle/cleanup-fs schedulers.
describe("upsertRepeatable (in-process BullMQ job schedulers)", () => {
  const queue = getQueue(jobLabels.planBundle);
  const schedulerId = "test-plan-bundle-scheduler";

  const findScheduler = async (id: string) => {
    const schedulers = await queue.getJobSchedulers();
    // BullMQ exposes the scheduler id as `key` (some versions also `id`).
    return schedulers.find(
      (s) =>
        (s as { key?: string }).key === id ||
        (s as { id?: string }).id === id
    );
  };

  afterEach(async () => {
    // Never leave a test scheduler firing in the shared queue Redis.
    await queue.removeJobScheduler(schedulerId);
  });

  it("registers a repeatable scheduler for a non-empty cron pattern", async () => {
    await upsertRepeatable(jobLabels.planBundle, schedulerId, "*/5 * * * *", {
      planId: "scheduler",
    });

    const scheduler = await findScheduler(schedulerId);
    expect(scheduler, "scheduler should be registered").to.not.equal(undefined);
    expect(scheduler?.pattern).to.equal("*/5 * * * *");
  });

  it("is idempotent and updates the pattern on re-registration (same id)", async () => {
    await upsertRepeatable(jobLabels.planBundle, schedulerId, "*/5 * * * *", {
      planId: "scheduler",
    });
    await upsertRepeatable(jobLabels.planBundle, schedulerId, "0 2 * * *", {
      planId: "scheduler",
    });

    const all = await queue.getJobSchedulers();
    const matching = all.filter(
      (s) =>
        (s as { key?: string }).key === schedulerId ||
        (s as { id?: string }).id === schedulerId
    );
    // Exactly one scheduler for this id (deduped by id), with the new pattern.
    expect(matching.length).to.equal(1);
    expect(matching[0].pattern).to.equal("0 2 * * *");
  });

  it("removes the scheduler when the pattern is empty/whitespace (ops disable)", async () => {
    await upsertRepeatable(jobLabels.planBundle, schedulerId, "*/5 * * * *", {
      planId: "scheduler",
    });
    expect(await findScheduler(schedulerId)).to.not.equal(undefined);

    // Empty pattern => disabled => existing scheduler dropped.
    await upsertRepeatable(jobLabels.planBundle, schedulerId, "  ", {
      planId: "scheduler",
    });

    expect(await findScheduler(schedulerId)).to.equal(undefined);
  });
});
