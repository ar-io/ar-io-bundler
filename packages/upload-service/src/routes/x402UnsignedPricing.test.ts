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

import { applyX402FeeAndFloor } from "./rawDataPost";
import { MINIMUM_USDC_PRICE } from "./x402Pricing";

describe("applyX402FeeAndFloor (unsigned x402 pricing consistency)", () => {
  const originalFee = process.env.X402_FEE_PERCENT;
  const originalBuffer = process.env.X402_PRICING_BUFFER_PERCENT;

  afterEach(() => {
    // Restore env between cases so each test sets its own scenario.
    if (originalFee === undefined) {
      delete process.env.X402_FEE_PERCENT;
    } else {
      process.env.X402_FEE_PERCENT = originalFee;
    }
    if (originalBuffer === undefined) {
      delete process.env.X402_PRICING_BUFFER_PERCENT;
    } else {
      process.env.X402_PRICING_BUFFER_PERCENT = originalBuffer;
    }
  });

  it("charges using X402_FEE_PERCENT (primary fee var)", () => {
    process.env.X402_FEE_PERCENT = "15";
    delete process.env.X402_PRICING_BUFFER_PERCENT;

    // 1_000_000 * 1.15 = 1_150_000 (above the floor, so floor is a no-op).
    expect(applyX402FeeAndFloor("1000000")).to.equal("1150000");
  });

  it("applies the shared MINIMUM_USDC_PRICE floor for tiny amounts", () => {
    process.env.X402_FEE_PERCENT = "15";
    delete process.env.X402_PRICING_BUFFER_PERCENT;

    // 1 * 1.15 = 1.15 -> ceil 2, which is below the 1000 floor.
    expect(applyX402FeeAndFloor("1")).to.equal(MINIMUM_USDC_PRICE.toString());
    expect(MINIMUM_USDC_PRICE).to.equal(1000);
  });

  it("falls back to X402_PRICING_BUFFER_PERCENT when X402_FEE_PERCENT is unset", () => {
    delete process.env.X402_FEE_PERCENT;
    process.env.X402_PRICING_BUFFER_PERCENT = "25";

    // 1_000_000 * 1.25 = 1_250_000 using the deprecated buffer var.
    expect(applyX402FeeAndFloor("1000000")).to.equal("1250000");
  });

  it("prefers X402_FEE_PERCENT over X402_PRICING_BUFFER_PERCENT when both are set", () => {
    process.env.X402_FEE_PERCENT = "10";
    process.env.X402_PRICING_BUFFER_PERCENT = "50";

    // Uses the 10% fee, not the 50% buffer: 1_000_000 * 1.10 = 1_100_000.
    expect(applyX402FeeAndFloor("1000000")).to.equal("1100000");
  });

  it("defaults to 15% when neither var is set", () => {
    delete process.env.X402_FEE_PERCENT;
    delete process.env.X402_PRICING_BUFFER_PERCENT;

    expect(applyX402FeeAndFloor("1000000")).to.equal("1150000");
  });

  it("treats an empty-string X402_FEE_PERCENT as unset (compose ${VAR:-} passthrough)", () => {
    // Regression guard: with ?? this would parseInt("") -> NaN. With || it
    // falls through to the buffer var (or the 15% default).
    process.env.X402_FEE_PERCENT = "";
    process.env.X402_PRICING_BUFFER_PERCENT = "20";

    expect(applyX402FeeAndFloor("1000000")).to.equal("1200000");
  });
});
