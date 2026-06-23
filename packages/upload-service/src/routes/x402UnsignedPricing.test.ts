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

import {
  MINIMUM_USDC_PRICE,
  applyX402FeeAndFloor,
  perItemSurchargeUsdcAtomic,
} from "../utils/x402Pricing";

const originalSurcharge = process.env.USD_PRICE_PER_DATA_ITEM;

function restoreEnv(key: string, original: string | undefined) {
  if (original === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = original;
  }
}

describe("applyX402FeeAndFloor (unsigned x402 pricing consistency)", () => {
  const originalFee = process.env.X402_FEE_PERCENT;
  const originalBuffer = process.env.X402_PRICING_BUFFER_PERCENT;

  beforeEach(() => {
    // These cases isolate the fee/floor math; pin the surcharge to 0 so the
    // exact expectations below are unaffected by the per-item surcharge (its own
    // behavior is covered in the surcharge describe block).
    process.env.USD_PRICE_PER_DATA_ITEM = "0";
  });

  afterEach(() => {
    // Restore env between cases so each test sets its own scenario.
    restoreEnv("X402_FEE_PERCENT", originalFee);
    restoreEnv("X402_PRICING_BUFFER_PERCENT", originalBuffer);
    restoreEnv("USD_PRICE_PER_DATA_ITEM", originalSurcharge);
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

// Regression: the unsigned/raw x402 path must charge the flat per-data-item
// surcharge (USD_PRICE_PER_DATA_ITEM) like the signed/credit paths do — earlier
// it priced bytes only and bypassed the fee. Because both the quote route
// (x402RawDataPricing) and the upload charge (rawDataPost) now go through
// applyX402FeeAndFloor, testing it here proves quote == charge for the surcharge.
describe("applyX402FeeAndFloor / perItemSurchargeUsdcAtomic (per-item surcharge)", () => {
  const originalFee = process.env.X402_FEE_PERCENT;
  const originalBuffer = process.env.X402_PRICING_BUFFER_PERCENT;

  afterEach(() => {
    restoreEnv("X402_FEE_PERCENT", originalFee);
    restoreEnv("X402_PRICING_BUFFER_PERCENT", originalBuffer);
    restoreEnv("USD_PRICE_PER_DATA_ITEM", originalSurcharge);
  });

  it("perItemSurchargeUsdcAtomic converts USD/item to USDC atomic units (6 decimals)", () => {
    process.env.USD_PRICE_PER_DATA_ITEM = "0.00002"; // default
    expect(perItemSurchargeUsdcAtomic()).to.equal(20); // 0.00002 * 1e6

    process.env.USD_PRICE_PER_DATA_ITEM = "0.1";
    expect(perItemSurchargeUsdcAtomic()).to.equal(100_000);
  });

  it("treats unset/zero/invalid surcharge as 0 (no charge, no NaN)", () => {
    process.env.USD_PRICE_PER_DATA_ITEM = "0";
    expect(perItemSurchargeUsdcAtomic()).to.equal(0);

    process.env.USD_PRICE_PER_DATA_ITEM = "";
    // empty -> falls back to the 0.00002 default
    expect(perItemSurchargeUsdcAtomic()).to.equal(20);

    process.env.USD_PRICE_PER_DATA_ITEM = "not-a-number";
    expect(perItemSurchargeUsdcAtomic()).to.equal(0);
  });

  it("adds the surcharge to the base BEFORE the fee markup", () => {
    process.env.X402_FEE_PERCENT = "15";
    delete process.env.X402_PRICING_BUFFER_PERCENT;
    process.env.USD_PRICE_PER_DATA_ITEM = "0.1"; // 100_000 atomic units

    // (1_000_000 base + 100_000 surcharge) * 1.15 = 1_265_000
    expect(applyX402FeeAndFloor("1000000")).to.equal("1265000");
  });

  it("includes the default surcharge for an above-floor amount", () => {
    process.env.X402_FEE_PERCENT = "15";
    delete process.env.X402_PRICING_BUFFER_PERCENT;
    process.env.USD_PRICE_PER_DATA_ITEM = "0.00002"; // 20 atomic units

    // (1_000_000 + 20) * 1.15 = ceil(1_150_023) = 1_150_023 (vs 1_150_000 without)
    expect(applyX402FeeAndFloor("1000000")).to.equal("1150023");
  });

  it("a meaningful surcharge can lift a near-floor amount above the floor", () => {
    process.env.X402_FEE_PERCENT = "0";
    delete process.env.X402_PRICING_BUFFER_PERCENT;
    process.env.USD_PRICE_PER_DATA_ITEM = "0.005"; // 5_000 atomic units

    // (1 + 5_000) * 1.0 = 5_001, above the 1_000 floor -> surcharge is not masked.
    expect(applyX402FeeAndFloor("1")).to.equal("5001");
  });
});
