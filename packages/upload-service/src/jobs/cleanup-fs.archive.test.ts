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
import { Readable } from "stream";
import winston from "winston";

import { ObjectStore } from "../arch/objectStore";
import {
  ReclaimBundleResult,
  reclaimBundleFromBundler,
  runBundlerReclaimSweep,
} from "./cleanup-fs";

const silentLogger = winston.createLogger({
  silent: true,
  transports: [new winston.transports.Console()],
});

/**
 * In-memory fake of the bits of ObjectStore the bundler reclamation touches:
 * headObject (the archive HEAD gate) and deleteObject (the bundler delete). Records
 * deletes so we can assert exactly which bundler copies were (not) removed.
 */
class FakeStore {
  public keys: Set<string>;
  public deleted: string[] = [];

  constructor(keys: string[] = []) {
    this.keys = new Set(keys);
  }

  headObject = async (Key: string) => {
    if (!this.keys.has(Key)) throw new Error("NoSuchKey");
    return { etag: "e", ContentLength: 1, ContentType: undefined };
  };

  deleteObject = async (Key: string) => {
    if (!this.keys.has(Key)) {
      const err: any = new Error("NoSuchKey");
      err.name = "NoSuchKey";
      throw err;
    }
    this.keys.delete(Key);
    this.deleted.push(Key);
  };

  // Unused by the helper but part of the interface surface for streaming reads.
  getObject = async () => ({ readable: Readable.from([""]), etag: "e" });
}

const asStore = (s: FakeStore) => s as unknown as ObjectStore;

describe("reclaimBundleFromBundler (two-tier MinIO post-permanence sweep)", () => {
  it("deletes raw-data-item + bundle-payload + bundle tx from the bundler when all archive copies are confirmed", async () => {
    const bundler = new FakeStore([
      "raw-data-item/item-1",
      "raw-data-item/item-2",
      "bundle-payload/plan-1",
      "bundle/tx-1",
    ]);
    const archive = new FakeStore([
      "raw-data-item/item-1",
      "raw-data-item/item-2",
      "bundle-payload/plan-1",
    ]);

    const result = await reclaimBundleFromBundler({
      objectStore: asStore(bundler),
      archiveObjectStore: asStore(archive),
      planId: "plan-1",
      bundleId: "tx-1",
      dataItemIds: ["item-1", "item-2"],
      logger: silentLogger,
    });

    expect(result.deferred).to.equal(false);
    expect(result.rawDeleted).to.equal(2);
    expect(result.payloadDeleted).to.equal(true);
    expect(result.txDeleted).to.equal(true);
    expect(result.missingArchiveKeys).to.deep.equal([]);
    expect(bundler.deleted).to.have.members([
      "raw-data-item/item-1",
      "raw-data-item/item-2",
      "bundle-payload/plan-1",
      "bundle/tx-1",
    ]);
  });

  it("NEVER deletes any bundler copy and defers when the archive bundle-payload is missing (the critical guard)", async () => {
    const bundler = new FakeStore([
      "raw-data-item/item-1",
      "bundle-payload/plan-1",
      "bundle/tx-1",
    ]);
    const archive = new FakeStore([]); // archive copy hasn't landed yet

    const result = await reclaimBundleFromBundler({
      objectStore: asStore(bundler),
      archiveObjectStore: asStore(archive),
      planId: "plan-1",
      bundleId: "tx-1",
      dataItemIds: ["item-1"],
      logger: silentLogger,
    });

    expect(result.deferred).to.equal(true);
    expect(bundler.deleted).to.deep.equal([]); // nothing removed from the bundler
    // The missing archive bundle-payload is reported so the sweep can re-enqueue it.
    expect(result.missingArchiveKeys).to.deep.equal(["bundle-payload/plan-1"]);
  });

  it("skips the bundler raw-item delete (and defers) when that item's archive copy is missing, but still drops the confirmed payload + tx", async () => {
    const bundler = new FakeStore([
      "raw-data-item/item-1",
      "raw-data-item/item-2",
      "bundle-payload/plan-1",
      "bundle/tx-1",
    ]);
    // payload is archived and item-1, but item-2's archive copy hasn't landed.
    const archive = new FakeStore([
      "raw-data-item/item-1",
      "bundle-payload/plan-1",
    ]);

    const result = await reclaimBundleFromBundler({
      objectStore: asStore(bundler),
      archiveObjectStore: asStore(archive),
      planId: "plan-1",
      bundleId: "tx-1",
      dataItemIds: ["item-1", "item-2"],
      logger: silentLogger,
    });

    expect(result.deferred).to.equal(true); // revisit for item-2
    expect(result.rawDeleted).to.equal(1);
    // Only item-2's archive copy is missing, so that's the one key to re-enqueue.
    expect(result.missingArchiveKeys).to.deep.equal(["raw-data-item/item-2"]);
    expect(bundler.deleted).to.have.members([
      "raw-data-item/item-1",
      "bundle-payload/plan-1",
      "bundle/tx-1",
    ]);
    // item-2 stays on the bundler because its archive copy isn't confirmed.
    expect(bundler.keys.has("raw-data-item/item-2")).to.equal(true);
  });

  it("is idempotent: a re-run after a successful sweep deletes nothing more", async () => {
    const bundler = new FakeStore([]); // already reclaimed
    const archive = new FakeStore([
      "raw-data-item/item-1",
      "bundle-payload/plan-1",
    ]);

    const result = await reclaimBundleFromBundler({
      objectStore: asStore(bundler),
      archiveObjectStore: asStore(archive),
      planId: "plan-1",
      bundleId: "tx-1",
      dataItemIds: ["item-1"],
      logger: silentLogger,
    });

    expect(result.deferred).to.equal(false);
    expect(result.rawDeleted).to.equal(0);
    expect(result.payloadDeleted).to.equal(false);
    expect(result.txDeleted).to.equal(false);
    expect(result.missingArchiveKeys).to.deep.equal([]);
    expect(bundler.deleted).to.deep.equal([]);
  });
});

interface FakeBundle {
  plan_id: string;
  bundle_id: string;
  permanent_date: string;
}

/**
 * Drive `runBundlerReclaimSweep` over an in-memory set of permanent bundles with
 * fully-injected deps (no DB, no object store), so the cursor / deferral /
 * reconciliation control flow can be asserted directly. `reclaimByBundle` maps a
 * bundle_id to the `ReclaimBundleResult` the (faked) reclaim returns for it.
 */
function makeSweepHarness({
  bundles,
  reclaimByBundle,
  pageSize = 2,
  startCursor,
}: {
  bundles: FakeBundle[];
  reclaimByBundle: Record<string, ReclaimBundleResult>;
  pageSize?: number;
  startCursor?: { permanentDate: string; bundleId: string | undefined };
}) {
  const sorted = [...bundles].sort((a, b) =>
    a.permanent_date !== b.permanent_date
      ? a.permanent_date < b.permanent_date
        ? -1
        : 1
      : a.bundle_id < b.bundle_id
      ? -1
      : a.bundle_id > b.bundle_id
      ? 1
      : 0
  );

  let cursor = startCursor;
  const setCursorCalls: { permanentDate: string; bundleId: string | undefined }[] =
    [];
  const enqueued: string[] = [];
  const reclaimedBundleIds: string[] = [];

  const deps = {
    pageSize,
    logger: silentLogger,
    getCursor: async () => cursor,
    setCursor: async (c: {
      permanentDate: string;
      bundleId: string | undefined;
    }) => {
      cursor = c;
      setCursorCalls.push(c);
    },
    fetchPage: async (scanCursor: {
      permanentDate: string;
      bundleId: string | undefined;
    }) =>
      sorted
        .filter(
          (b) =>
            b.permanent_date > scanCursor.permanentDate ||
            (b.permanent_date === scanCursor.permanentDate &&
              b.bundle_id > (scanCursor.bundleId ?? ""))
        )
        .slice(0, pageSize),
    fetchItemIds: async () => [],
    reclaim: async ({ bundleId }: { bundleId: string }) => {
      reclaimedBundleIds.push(bundleId);
      return reclaimByBundle[bundleId];
    },
    enqueueArchiveCopy: async (keys: string[]) => {
      enqueued.push(...keys);
    },
  };

  return {
    deps,
    finalCursor: () => cursor,
    setCursorCalls,
    enqueued,
    reclaimedBundleIds,
  };
}

const clean = (): ReclaimBundleResult => ({
  deferred: false,
  payloadDeleted: true,
  txDeleted: true,
  rawDeleted: 1,
  missingArchiveKeys: [],
});

const deferred = (missingArchiveKeys: string[]): ReclaimBundleResult => ({
  deferred: true,
  payloadDeleted: false,
  txDeleted: false,
  rawDeleted: 0,
  missingArchiveKeys,
});

const b = (date: string, id: string): FakeBundle => ({
  plan_id: `plan-${id}`,
  bundle_id: id,
  permanent_date: date,
});

describe("runBundlerReclaimSweep (cursor / deferral / reconciliation)", () => {
  it("reclaims every bundle and persists the cursor at the tail when there are no holes", async () => {
    const bundles = [b("2026-01-01", "b1"), b("2026-01-02", "b2"), b("2026-01-03", "b3")];
    const h = makeSweepHarness({
      bundles,
      reclaimByBundle: { b1: clean(), b2: clean(), b3: clean() },
      pageSize: 2,
    });

    const stats = await runBundlerReclaimSweep(h.deps);

    expect(stats.bundlesSwept).to.equal(3);
    expect(stats.deferredBundles).to.equal(0);
    expect(stats.reEnqueuedKeys).to.equal(0);
    expect(h.enqueued).to.deep.equal([]);
    expect(h.reclaimedBundleIds).to.deep.equal(["b1", "b2", "b3"]);
    expect(stats.persistedCursor).to.deep.equal({
      permanentDate: "2026-01-03",
      bundleId: "b3",
    });
    expect(h.finalCursor()).to.deep.equal({
      permanentDate: "2026-01-03",
      bundleId: "b3",
    });
  });

  it("a deferred bundle in the middle does NOT stall the tail, parks the persist cursor before the hole, and re-enqueues the missing copy", async () => {
    const bundles = [b("2026-01-01", "b1"), b("2026-01-02", "b2"), b("2026-01-03", "b3")];
    const h = makeSweepHarness({
      bundles,
      reclaimByBundle: {
        b1: clean(),
        b2: deferred(["bundle-payload/plan-b2"]),
        b3: clean(),
      },
      pageSize: 2,
    });

    const stats = await runBundlerReclaimSweep(h.deps);

    // b1 and b3 are reclaimed even though b2 is a hole (no head-of-line stall).
    expect(h.reclaimedBundleIds).to.deep.equal(["b1", "b2", "b3"]);
    expect(stats.bundlesSwept).to.equal(2); // b1 + b3
    expect(stats.deferredBundles).to.equal(1);
    // The missing archive copy is re-requested (reconciliation backstop).
    expect(stats.reEnqueuedKeys).to.equal(1);
    expect(h.enqueued).to.deep.equal(["bundle-payload/plan-b2"]);
    // Persist cursor parks at b1 (the last contiguous reclaim before the hole),
    // so the hole (b2) is retried next run while the tail still got reclaimed.
    expect(stats.persistedCursor).to.deep.equal({
      permanentDate: "2026-01-01",
      bundleId: "b1",
    });
    expect(h.finalCursor()).to.deep.equal({
      permanentDate: "2026-01-01",
      bundleId: "b1",
    });
    // The cursor is persisted exactly once (when it advanced to b1), not
    // re-written on every later page once the hole froze it.
    expect(h.setCursorCalls).to.deep.equal([
      { permanentDate: "2026-01-01", bundleId: "b1" },
    ]);
  });

  it("never persists a cursor (and re-enqueues) when the very first bundle is a hole, so it is retried from the start next run", async () => {
    const bundles = [b("2026-01-01", "b1"), b("2026-01-02", "b2"), b("2026-01-03", "b3")];
    const h = makeSweepHarness({
      bundles,
      reclaimByBundle: {
        b1: deferred(["raw-data-item/x", "raw-data-item/y"]),
        b2: clean(),
        b3: clean(),
      },
      pageSize: 2,
    });

    const stats = await runBundlerReclaimSweep(h.deps);

    expect(stats.deferredBundles).to.equal(1);
    expect(stats.bundlesSwept).to.equal(2); // b2 + b3 still reclaimed
    expect(stats.reEnqueuedKeys).to.equal(2);
    expect(h.enqueued).to.deep.equal(["raw-data-item/x", "raw-data-item/y"]);
    // No contiguous reclaim before the hole → cursor never persisted → next run
    // re-scans from the beginning and retries b1.
    expect(h.setCursorCalls).to.deep.equal([]);
    expect(h.finalCursor()).to.equal(undefined);
  });

  it("resumes from the persisted cursor and only scans newer bundles", async () => {
    const bundles = [b("2026-01-01", "b1"), b("2026-01-02", "b2"), b("2026-01-03", "b3")];
    const h = makeSweepHarness({
      bundles,
      reclaimByBundle: { b2: clean(), b3: clean() },
      pageSize: 2,
      startCursor: { permanentDate: "2026-01-01", bundleId: "b1" },
    });

    const stats = await runBundlerReclaimSweep(h.deps);

    // b1 is before the resume cursor and is never re-examined.
    expect(h.reclaimedBundleIds).to.deep.equal(["b2", "b3"]);
    expect(stats.bundlesSwept).to.equal(2);
    expect(stats.scannedThrough).to.deep.equal({
      permanentDate: "2026-01-03",
      bundleId: "b3",
    });
  });
});
