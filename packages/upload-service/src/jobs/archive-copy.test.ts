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
import { PayloadInfo } from "../types/types";
import { archiveCopyHandler } from "./archive-copy";

const silentLogger = winston.createLogger({
  silent: true,
  transports: [new winston.transports.Console()],
});

interface PutCall {
  key: string;
  payloadInfo?: PayloadInfo;
  contentType?: string;
}

/**
 * In-memory fake of the bits of ObjectStore the archive-copy handler touches:
 * head (for the idempotency gate), get + getObjectPayloadInfo (source reads),
 * and put (the archive write). Records put calls for assertions.
 */
class FakeStore {
  public objects = new Map<string, PayloadInfo | undefined>();
  public putCalls: PutCall[] = [];
  public deleted: string[] = [];
  public getCount = 0;
  public putShouldThrow = false;
  // Default reported byte count for any present object ("data".length). Per-key
  // overrides live in `byteCounts`; `putByteCountOverride` lets a test simulate a
  // truncated archive write (the stored object reports fewer bytes than source).
  public defaultByteCount = 4;
  public byteCounts = new Map<string, number>();
  public putByteCountOverride?: number;

  constructor(seed: Record<string, PayloadInfo | undefined> = {}) {
    for (const [k, v] of Object.entries(seed)) this.objects.set(k, v);
  }

  headObject = async (Key: string) => {
    if (!this.objects.has(Key)) throw new Error("NoSuchKey");
    return {
      etag: "e",
      ContentLength: 1,
      ContentType: "application/octet-stream",
    };
  };

  getObject = async (Key: string) => {
    this.getCount++;
    if (!this.objects.has(Key)) throw new Error("NoSuchKey");
    return { readable: Readable.from(["data"]), etag: "e" };
  };

  getObjectByteCount = async (Key: string): Promise<number> => {
    if (this.byteCounts.has(Key)) return this.byteCounts.get(Key) as number;
    if (!this.objects.has(Key)) throw new Error("NoSuchKey");
    return this.defaultByteCount;
  };

  getObjectPayloadInfo = async (Key: string): Promise<PayloadInfo> => {
    const info = this.objects.get(Key);
    if (!info) throw new Error("No payload info found");
    return info;
  };

  putObject = async (
    Key: string,
    _Body: Readable,
    Options: { payloadInfo?: PayloadInfo; contentType?: string } = {}
  ) => {
    if (this.putShouldThrow) throw new Error("archive put failed");
    this.putCalls.push({
      key: Key,
      payloadInfo: Options.payloadInfo,
      contentType: Options.contentType,
    });
    this.objects.set(Key, Options.payloadInfo);
    this.byteCounts.set(Key, this.putByteCountOverride ?? this.defaultByteCount);
  };

  deleteObject = async (Key: string) => {
    this.objects.delete(Key);
    this.byteCounts.delete(Key);
    this.deleted.push(Key);
  };
}

const asStore = (s: FakeStore) => s as unknown as ObjectStore;

const payloadInfo: PayloadInfo = {
  payloadDataStart: 1100,
  payloadContentType: "image/png",
};

describe("archiveCopyHandler", () => {
  it("no-ops (no error, no reads) when the archive store is undefined", async () => {
    const primary = new FakeStore({ "raw-data-item/abc": payloadInfo });

    await archiveCopyHandler(
      { key: "raw-data-item/abc" },
      {
        objectStore: asStore(primary),
        archiveObjectStore: undefined,
        logger: silentLogger,
      }
    );

    expect(primary.getCount).to.equal(0);
  });

  it("copies a raw-data-item and preserves its payload metadata", async () => {
    const primary = new FakeStore({ "raw-data-item/abc": payloadInfo });
    const archive = new FakeStore();

    await archiveCopyHandler(
      { key: "raw-data-item/abc" },
      {
        objectStore: asStore(primary),
        archiveObjectStore: asStore(archive),
        logger: silentLogger,
      }
    );

    expect(archive.putCalls).to.have.length(1);
    expect(archive.putCalls[0].key).to.equal("raw-data-item/abc");
    expect(archive.putCalls[0].payloadInfo).to.deep.equal(payloadInfo);
  });

  it("copies a bundle-payload as a plain octet stream (no payload metadata)", async () => {
    const primary = new FakeStore({ "bundle-payload/plan-1": undefined });
    const archive = new FakeStore();

    await archiveCopyHandler(
      { key: "bundle-payload/plan-1" },
      {
        objectStore: asStore(primary),
        archiveObjectStore: asStore(archive),
        logger: silentLogger,
      }
    );

    expect(archive.putCalls).to.have.length(1);
    expect(archive.putCalls[0].key).to.equal("bundle-payload/plan-1");
    expect(archive.putCalls[0].payloadInfo).to.equal(undefined);
    expect(archive.putCalls[0].contentType).to.be.a("string");
  });

  it("is idempotent: skips the copy when the object is already on the archive", async () => {
    const primary = new FakeStore({ "raw-data-item/abc": payloadInfo });
    const archive = new FakeStore({ "raw-data-item/abc": payloadInfo });

    await archiveCopyHandler(
      { key: "raw-data-item/abc" },
      {
        objectStore: asStore(primary),
        archiveObjectStore: asStore(archive),
        logger: silentLogger,
      }
    );

    expect(primary.getCount).to.equal(0);
    expect(archive.putCalls).to.have.length(0);
  });

  it("deletes the bad archive object and throws when the archived byte count doesn't match the source (truncation guard)", async () => {
    const primary = new FakeStore({ "raw-data-item/abc": payloadInfo });
    primary.byteCounts.set("raw-data-item/abc", 100); // source is 100 bytes
    const archive = new FakeStore();
    archive.putByteCountOverride = 60; // simulate a truncated archive write

    let threw = false;
    try {
      await archiveCopyHandler(
        { key: "raw-data-item/abc" },
        {
          objectStore: asStore(primary),
          archiveObjectStore: asStore(archive),
          logger: silentLogger,
        }
      );
    } catch {
      threw = true;
    }

    expect(threw).to.equal(true);
    // The wrong-size object MUST be removed so the BullMQ retry re-copies instead
    // of the idempotency HEAD short-circuiting on the truncated object.
    expect(archive.deleted).to.include("raw-data-item/abc");
    expect(archive.objects.has("raw-data-item/abc")).to.equal(false);
  });

  it("throws on copy failure so BullMQ retries", async () => {
    const primary = new FakeStore({ "raw-data-item/abc": payloadInfo });
    const archive = new FakeStore();
    archive.putShouldThrow = true;

    let threw = false;
    try {
      await archiveCopyHandler(
        { key: "raw-data-item/abc" },
        {
          objectStore: asStore(primary),
          archiveObjectStore: asStore(archive),
          logger: silentLogger,
        }
      );
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
  });
});
