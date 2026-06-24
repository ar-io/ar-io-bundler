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

import { seedChunksWithFailover, shuffled } from "./arweaveJs";

const silentLog = winston.createLogger({ silent: true });
const node = (host: string) => ({ url: new URL(`http://${host}:4000`) });

describe("seedChunksWithFailover (multi-distributor chunk seeding)", () => {
  it("returns the first node's URL on success, without trying others", async () => {
    const tried: string[] = [];
    const url = await seedChunksWithFailover(
      [node("a"), node("b"), node("c")],
      async (n) => {
        tried.push(n.url.host);
      },
      silentLog
    );
    expect(url.host).to.equal("a:4000");
    expect(tried).to.deep.equal(["a:4000"]);
  });

  it("fails over in order when earlier nodes throw", async () => {
    const tried: string[] = [];
    const url = await seedChunksWithFailover(
      [node("a"), node("b"), node("c")],
      async (n) => {
        tried.push(n.url.host);
        if (n.url.host !== "c:4000") {
          throw new Error("node down");
        }
      },
      silentLog
    );
    expect(url.host).to.equal("c:4000");
    expect(tried).to.deep.equal(["a:4000", "b:4000", "c:4000"]);
  });

  it("throws (with the last error) when ALL nodes fail", async () => {
    let err: Error | undefined;
    try {
      await seedChunksWithFailover(
        [node("a"), node("b")],
        async () => {
          throw new Error("boom");
        },
        silentLog
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.be.instanceOf(Error);
    expect(err?.message).to.match(/All 2 chunk-distributor node\(s\) failed/);
    expect(err?.message).to.match(/boom/);
  });

  it("throws when no nodes are configured", async () => {
    let err: Error | undefined;
    try {
      await seedChunksWithFailover([], async () => undefined, silentLog);
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).to.match(/No chunk-distributor nodes configured/);
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
