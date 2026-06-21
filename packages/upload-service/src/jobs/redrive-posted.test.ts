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
import winston from "winston";

import { Database } from "../arch/db/database";
import { PlanId } from "../types/dbTypes";
import { PostedBundle } from "../types/dbTypes";
import { TransactionId } from "../types/types";
import { redrivePostedHandler } from "./redrive-posted";

const silentLogger = winston.createLogger({
  silent: true,
  transports: [new winston.transports.Console()],
});

// Minimal PostedBundle — the handler only reads planId/bundleId.
const stalePosted = (planId: string, bundleId: string): PostedBundle =>
  ({ planId, bundleId } as unknown as PostedBundle);

/**
 * In-memory fake of the bits of Database the re-driver touches. Tracks a
 * per-bundle redrive counter (mirroring the real ON CONFLICT increment) plus
 * which bundles were re-enqueued vs demoted to failed.
 */
class FakeDb {
  public stale: PostedBundle[] = [];
  public redriveCounts = new Map<string, number>();
  public demoted: string[] = [];
  public getStaleArgs: { olderThanMs?: number } = {};

  public getStalePostedBundles = async (
    olderThanMs: number,
    _limit?: number
  ): Promise<PostedBundle[]> => {
    this.getStaleArgs.olderThanMs = olderThanMs;
    return this.stale;
  };

  public incrementPostedBundleRedrive = async (
    _planId: PlanId,
    bundleId: TransactionId
  ): Promise<number> => {
    const next = (this.redriveCounts.get(bundleId) ?? 0) + 1;
    this.redriveCounts.set(bundleId, next);
    return next;
  };

  public updatePostedBundleToFailed = async (
    _planId: PlanId,
    bundleId: TransactionId
  ): Promise<void> => {
    this.demoted.push(bundleId);
  };

  public asDatabase(): Database {
    return this as unknown as Database;
  }
}

describe("redrivePostedHandler", () => {
  it("passes the stale threshold through to the query", async () => {
    const db = new FakeDb();
    await redrivePostedHandler({
      database: db.asDatabase(),
      logger: silentLogger,
      staleThresholdMs: 12_345,
      enqueueSeed: async () => undefined,
    });
    // The query is the only thing that decides which rows are "stale"; assert the
    // configured threshold is the one used (selecting only stale rows).
    expect(db.getStaleArgs.olderThanMs).to.equal(12_345);
  });

  it("re-enqueues seed-bundle for stale rows under the redrive limit", async () => {
    const db = new FakeDb();
    db.stale = [
      stalePosted("plan-a", "bundle-a"),
      stalePosted("plan-b", "bundle-b"),
    ];

    const enqueued: string[] = [];
    await redrivePostedHandler({
      database: db.asDatabase(),
      logger: silentLogger,
      maxRedrives: 5,
      enqueueSeed: async (planId) => {
        enqueued.push(planId);
      },
    });

    expect(enqueued).to.deep.equal(["plan-a", "plan-b"]);
    expect(db.demoted).to.be.empty;
  });

  it("demotes a bundle to failed only after exceeding maxRedrives", async () => {
    const db = new FakeDb();
    db.stale = [stalePosted("plan-x", "bundle-x")];

    let enqueueCount = 0;
    const run = () =>
      redrivePostedHandler({
        database: db.asDatabase(),
        logger: silentLogger,
        maxRedrives: 3,
        enqueueSeed: async () => {
          enqueueCount++;
        },
      });

    // Runs 1..3: redrive count 1,2,3 — all <= maxRedrives → re-enqueue, not demote.
    await run();
    await run();
    await run();
    expect(enqueueCount).to.equal(3);
    expect(db.demoted).to.be.empty;

    // Run 4: redrive count becomes 4 (> maxRedrives) → demote, no further enqueue.
    await run();
    expect(enqueueCount).to.equal(3);
    expect(db.demoted).to.deep.equal(["bundle-x"]);
  });

  it("isolates a per-bundle failure and continues the sweep", async () => {
    const db = new FakeDb();
    db.stale = [
      stalePosted("plan-1", "bundle-1"),
      stalePosted("plan-2", "bundle-2"),
    ];

    const enqueued: string[] = [];
    await redrivePostedHandler({
      database: db.asDatabase(),
      logger: silentLogger,
      maxRedrives: 5,
      enqueueSeed: async (planId) => {
        if (planId === "plan-1") {
          throw new Error("transient enqueue failure");
        }
        enqueued.push(planId);
      },
    });

    // bundle-1 threw, but bundle-2 was still processed.
    expect(enqueued).to.deep.equal(["plan-2"]);
  });

  it("does nothing when there are no stale bundles", async () => {
    const db = new FakeDb();
    let enqueueCount = 0;
    await redrivePostedHandler({
      database: db.asDatabase(),
      logger: silentLogger,
      enqueueSeed: async () => {
        enqueueCount++;
      },
    });
    expect(enqueueCount).to.equal(0);
    expect(db.demoted).to.be.empty;
  });
});
