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

import { broadcastChunkToArioNode, shuffled } from "./arweaveJs";
import { ChunkHeader } from "./types/types";

const silentLog = winston.createLogger({ silent: true });

const header: ChunkHeader = {
  planId: "plan-1",
  bundleId: "bundle-1",
  data_root: "dr",
  data_size: "262144",
  data_path: "dp",
  offset: "262143",
  chunkIndex: "0",
  chunkByteLength: "262144",
};

describe("broadcastChunkToArioNode (per-chunk failover)", () => {
  const urls = [
    new URL("http://a:3000"),
    new URL("http://b:3000"),
    new URL("http://c:3000"),
  ];

  it("returns the accepting node and stops at the first success", async () => {
    const tried: string[] = [];
    const result = await broadcastChunkToArioNode({
      chunk: "Y2h1bms",
      chunkHeader: header,
      logger: silentLog,
      urls,
      post: async (url) => {
        tried.push(url.host);
      },
    });
    expect(urls.map((u) => u.host)).to.include(result.host);
    expect(tried).to.have.lengthOf(1);
  });

  it("fails over until a node accepts (order-independent)", async () => {
    const goodHost = "c:3000";
    const result = await broadcastChunkToArioNode({
      chunk: "x",
      chunkHeader: header,
      logger: silentLog,
      urls,
      post: async (url) => {
        if (url.host !== goodHost) throw new Error("node down");
      },
    });
    expect(result.host).to.equal(goodHost);
  });

  it("throws (with the last error) when ALL nodes reject", async () => {
    let err: Error | undefined;
    try {
      await broadcastChunkToArioNode({
        chunk: "x",
        chunkHeader: header,
        logger: silentLog,
        urls,
        post: async () => {
          throw new Error("boom");
        },
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).to.match(/All 3 AR\.IO node\(s\) rejected chunk 0/);
    expect(err?.message).to.match(/boom/);
  });

  it("throws when no nodes are configured", async () => {
    let err: Error | undefined;
    try {
      await broadcastChunkToArioNode({
        chunk: "x",
        chunkHeader: header,
        logger: silentLog,
        urls: [],
        post: async () => undefined,
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).to.match(/No AR\.IO node urls configured/);
  });

  it("sends the JsonChunkPost body + arweave-data headers", async () => {
    let body: Record<string, string> | undefined;
    let headers: Record<string, string> | undefined;
    await broadcastChunkToArioNode({
      chunk: "Y2h1bmtkYXRh",
      chunkHeader: header,
      logger: silentLog,
      urls: [new URL("http://only:3000")],
      post: async (_url, b, h) => {
        body = b;
        headers = h;
      },
    });
    expect(body).to.deep.equal({
      data_root: "dr",
      data_size: "262144",
      data_path: "dp",
      offset: "262143",
      chunk: "Y2h1bmtkYXRh",
    });
    expect(headers).to.deep.equal({
      "arweave-data-root": "dr",
      "arweave-data-size": "262144",
    });
  });
});

describe("shuffled", () => {
  it("returns a new array with the same elements (non-mutating)", () => {
    const input = [1, 2, 3, 4, 5];
    const out = shuffled(input);
    expect(out).to.not.equal(input);
    expect(input).to.deep.equal([1, 2, 3, 4, 5]);
    expect([...out].sort((a, b) => a - b)).to.deep.equal([1, 2, 3, 4, 5]);
  });

  it("handles empty and single-element arrays", () => {
    expect(shuffled([])).to.deep.equal([]);
    expect(shuffled([42])).to.deep.equal([42]);
  });
});
