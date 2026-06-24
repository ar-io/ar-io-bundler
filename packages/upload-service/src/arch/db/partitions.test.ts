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

import { tableNames } from "./dbConstants";
import {
  halfMonthPartitionSpecs,
  halfMonthPartitionSpecsForMonth,
} from "./partitions";

const base = tableNames.permanentDataItems;

describe("permanent_data_items partition specs", () => {
  it("produces two half-month partitions per month matching the existing scheme", () => {
    const [first, second] = halfMonthPartitionSpecsForMonth(2025, 12);
    expect(first).to.deep.equal({
      name: `${base}_12_2025_01`,
      from: "2025-12-01",
      to: "2025-12-15",
    });
    expect(second).to.deep.equal({
      name: `${base}_12_2025_02`,
      from: "2025-12-15",
      to: "2026-01-01",
    });
  });

  it("zero-pads single-digit months", () => {
    const [first] = halfMonthPartitionSpecsForMonth(2026, 1);
    expect(first.name).to.equal(`${base}_01_2026_01`);
    expect(first.from).to.equal("2026-01-01");
  });

  it("rolls the year over correctly at December", () => {
    const [, second] = halfMonthPartitionSpecsForMonth(2027, 12);
    expect(second.to).to.equal("2028-01-01");
  });

  it("generates contiguous, non-overlapping bounds across a 24-month span", () => {
    const specs = halfMonthPartitionSpecs(2026, 1, 24);
    expect(specs).to.have.length(48); // 24 months × 2 half-months
    expect(specs[0].from).to.equal("2026-01-01");
    expect(specs[specs.length - 1].to).to.equal("2028-01-01");

    // Each partition's upper bound must equal the next's lower bound (no gaps,
    // no overlaps).
    for (let i = 1; i < specs.length; i++) {
      expect(specs[i].from, `gap/overlap at index ${i}`).to.equal(
        specs[i - 1].to,
      );
    }

    // Names must be unique.
    const names = new Set(specs.map((s) => s.name));
    expect(names.size).to.equal(specs.length);
  });
});
