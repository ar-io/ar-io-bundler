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

import { batchOpticalHeaders } from "./unbundle-bdi";

// Correction 4: BDI optical fan-out is enqueued in batches (addBulk) instead of
// one job per child, so a large BDI can't flood the optical queue.
describe("batchOpticalHeaders (correction 4: BDI optical fan-out batching)", () => {
  it("returns no batches for an empty input", () => {
    expect(batchOpticalHeaders([], 50)).to.deep.equal([]);
  });

  it("keeps a sub-batch-size set in a single batch", () => {
    expect(batchOpticalHeaders([1, 2, 3], 50)).to.deep.equal([[1, 2, 3]]);
  });

  it("splits into contiguous order-preserving batches of at most batchSize", () => {
    const items = Array.from({ length: 125 }, (_, i) => i);
    const batches = batchOpticalHeaders(items, 50);
    expect(batches.length).to.equal(3);
    expect(batches[0].length).to.equal(50);
    expect(batches[1].length).to.equal(50);
    expect(batches[2].length).to.equal(25);
    // order preserved + complete coverage
    expect(batches.flat()).to.deep.equal(items);
  });

  it("emits an exact number of full batches with no trailing remainder", () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const batches = batchOpticalHeaders(items, 50);
    expect(batches.length).to.equal(2);
    expect(batches.every((b) => b.length === 50)).to.equal(true);
  });

  it("never produces an empty batch even for a degenerate batchSize", () => {
    const batches = batchOpticalHeaders([1, 2, 3], 0);
    expect(batches.every((b) => b.length >= 1)).to.equal(true);
    expect(batches.flat()).to.deep.equal([1, 2, 3]);
  });
});
