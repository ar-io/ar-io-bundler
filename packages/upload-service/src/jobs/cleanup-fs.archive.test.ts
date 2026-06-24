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
import { reclaimBundleFromSsd } from "./cleanup-fs";

const silentLogger = winston.createLogger({
  silent: true,
  transports: [new winston.transports.Console()],
});

/**
 * In-memory fake of the bits of ObjectStore the SSD reclamation touches:
 * headObject (the archive HEAD gate) and deleteObject (the SSD delete). Records
 * deletes so we can assert exactly which SSD copies were (not) removed.
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

describe("reclaimBundleFromSsd (two-tier MinIO post-permanence sweep)", () => {
  it("deletes raw-data-item + bundle-payload + bundle tx from the SSD when all HDD copies are confirmed", async () => {
    const ssd = new FakeStore([
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

    const result = await reclaimBundleFromSsd({
      objectStore: asStore(ssd),
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
    expect(ssd.deleted).to.have.members([
      "raw-data-item/item-1",
      "raw-data-item/item-2",
      "bundle-payload/plan-1",
      "bundle/tx-1",
    ]);
  });

  it("NEVER deletes any SSD copy and defers when the HDD bundle-payload is missing (the critical guard)", async () => {
    const ssd = new FakeStore([
      "raw-data-item/item-1",
      "bundle-payload/plan-1",
      "bundle/tx-1",
    ]);
    const archive = new FakeStore([]); // archive copy hasn't landed yet

    const result = await reclaimBundleFromSsd({
      objectStore: asStore(ssd),
      archiveObjectStore: asStore(archive),
      planId: "plan-1",
      bundleId: "tx-1",
      dataItemIds: ["item-1"],
      logger: silentLogger,
    });

    expect(result.deferred).to.equal(true);
    expect(ssd.deleted).to.deep.equal([]); // nothing removed from the SSD
  });

  it("skips the SSD raw-item delete (and defers) when that item's HDD copy is missing, but still drops the confirmed payload + tx", async () => {
    const ssd = new FakeStore([
      "raw-data-item/item-1",
      "raw-data-item/item-2",
      "bundle-payload/plan-1",
      "bundle/tx-1",
    ]);
    // payload is archived and item-1, but item-2's HDD copy hasn't landed.
    const archive = new FakeStore([
      "raw-data-item/item-1",
      "bundle-payload/plan-1",
    ]);

    const result = await reclaimBundleFromSsd({
      objectStore: asStore(ssd),
      archiveObjectStore: asStore(archive),
      planId: "plan-1",
      bundleId: "tx-1",
      dataItemIds: ["item-1", "item-2"],
      logger: silentLogger,
    });

    expect(result.deferred).to.equal(true); // revisit for item-2
    expect(result.rawDeleted).to.equal(1);
    expect(ssd.deleted).to.have.members([
      "raw-data-item/item-1",
      "bundle-payload/plan-1",
      "bundle/tx-1",
    ]);
    // item-2 stays on the SSD because its HDD copy isn't confirmed.
    expect(ssd.keys.has("raw-data-item/item-2")).to.equal(true);
  });

  it("is idempotent: a re-run after a successful sweep deletes nothing more", async () => {
    const ssd = new FakeStore([]); // already reclaimed
    const archive = new FakeStore([
      "raw-data-item/item-1",
      "bundle-payload/plan-1",
    ]);

    const result = await reclaimBundleFromSsd({
      objectStore: asStore(ssd),
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
    expect(ssd.deleted).to.deep.equal([]);
  });
});
