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
import { stub, SinonStub, useFakeTimers } from "sinon";
import axios from "axios";

import { W } from "../types";
import { X402PricingOracle } from "./x402PricingOracle";

describe("X402PricingOracle", () => {
  let oracle: X402PricingOracle;
  let axiosStub: SinonStub;

  beforeEach(() => {
    oracle = new X402PricingOracle();
    // Stub axios.get instead of fetch
    axiosStub = stub(axios, "get");
  });

  afterEach(() => {
    axiosStub.restore();
    // Clear the oracle cache between tests
    oracle.clearCache();
  });

  describe("getARPriceInUSD", () => {
    it("fetches and caches AR price from CoinGecko", async () => {
      const mockResponse = {
        data: { arweave: { usd: 25.5 } },
      };
      axiosStub.resolves(mockResponse);

      const price = await (oracle as any).getARPriceInUSD();

      expect(price).to.equal(25.5);
      expect(axiosStub.calledOnce).to.be.true;
    });

    it("returns cached price on subsequent calls within cache window", async () => {
      const mockResponse = {
        data: { arweave: { usd: 25.5 } },
      };
      axiosStub.resolves(mockResponse);

      const price1 = await (oracle as any).getARPriceInUSD();
      const price2 = await (oracle as any).getARPriceInUSD();

      expect(price1).to.equal(25.5);
      expect(price2).to.equal(25.5);
      expect(axiosStub.calledOnce).to.be.true; // Only called once due to cache
    });

    it("throws error when CoinGecko API fails", async () => {
      axiosStub.rejects(new Error("Request failed with status code 500"));

      try {
        await (oracle as any).getARPriceInUSD();
        expect.fail("Should have thrown error");
      } catch (error: any) {
        expect(error.message).to.include("Failed to fetch AR price");
      }
    });

    it("throws error when AR price is missing from response", async () => {
      const mockResponse = {
        data: {},
      };
      axiosStub.resolves(mockResponse);

      try {
        await (oracle as any).getARPriceInUSD();
        expect.fail("Should have thrown error");
      } catch (error: any) {
        expect(error.message).to.include("Failed to fetch AR price");
      }
    });

    // Regression: the stale fallback must be BOUNDED. After a prior successful
    // fetch, a CoinGecko failure may reuse the cached price only within
    // MAX_STALE_AR_PRICE_MS; past that the oracle must fail closed rather than
    // pricing payments off an arbitrarily old AR/USD value.
    it("reuses a stale cached price when CoinGecko fails but it is within the stale cap", async () => {
      const clock = useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
      try {
        axiosStub.resolves({ data: { arweave: { usd: 25.5 } } });
        expect(await (oracle as any).getARPriceInUSD()).to.equal(25.5); // seed

        // Past the 5-min fresh window, well within the 1h stale cap.
        clock.tick(10 * 60 * 1000);
        axiosStub.rejects(new Error("Request failed with status code 500"));

        expect(await (oracle as any).getARPriceInUSD()).to.equal(25.5);
      } finally {
        clock.restore();
      }
    });

    it("fails closed (throws) when the cached price is older than the stale cap", async () => {
      const clock = useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
      try {
        axiosStub.resolves({ data: { arweave: { usd: 25.5 } } });
        await (oracle as any).getARPriceInUSD(); // seed

        // Beyond the 1h stale cap.
        clock.tick(2 * 60 * 60 * 1000);
        axiosStub.rejects(new Error("Request failed with status code 500"));

        try {
          await (oracle as any).getARPriceInUSD();
          expect.fail(
            "Should have thrown — cached price too stale to price payments"
          );
        } catch (error: any) {
          expect(error.message).to.include("too stale");
        }
      } finally {
        clock.restore();
      }
    });
  });

  describe("getUSDCForWinston", () => {
    beforeEach(() => {
      const mockResponse = {
        data: { arweave: { usd: 20.0 } },
      };
      axiosStub.resolves(mockResponse);
    });

    it("converts winston to USDC correctly for 1 AR", async () => {
      // 1 AR = 1,000,000,000,000 Winston
      // 1 AR = $20
      // Expected USDC (6 decimals) = 20,000,000
      const winston = W("1000000000000");
      const usdc = await oracle.getUSDCForWinston(winston);

      expect(usdc).to.equal("20000000");
    });

    it("converts winston to USDC correctly for 0.1 AR", async () => {
      // 0.1 AR = 100,000,000,000 Winston
      // 0.1 AR = $2
      // Expected USDC (6 decimals) = 2,000,000
      const winston = W("100000000000");
      const usdc = await oracle.getUSDCForWinston(winston);

      expect(usdc).to.equal("2000000");
    });

    it("converts winston to USDC correctly for 0.01 AR", async () => {
      // 0.01 AR = 10,000,000,000 Winston
      // 0.01 AR = $0.20
      // Expected USDC (6 decimals) = 200,000
      const winston = W("10000000000");
      const usdc = await oracle.getUSDCForWinston(winston);

      expect(usdc).to.equal("200000");
    });

    it("rounds up fractional USDC amounts", async () => {
      // Very small winston amount that results in fractional USDC
      const winston = W("1000000"); // 0.000001 AR
      const usdc = await oracle.getUSDCForWinston(winston);

      // Even a tiny amount should round up to at least 1
      expect(Number(usdc)).to.be.greaterThanOrEqual(1);
    });

    it("handles large winston amounts correctly", async () => {
      // 1000 AR = 1,000,000,000,000,000 Winston
      // 1000 AR = $20,000
      // Expected USDC (6 decimals) = 20,000,000,000
      const winston = W("1000000000000000");
      const usdc = await oracle.getUSDCForWinston(winston);

      expect(usdc).to.equal("20000000000");
    });
  });

  describe("getWinstonForUSDC", () => {
    beforeEach(() => {
      const mockResponse = {
        data: { arweave: { usd: 20.0 } },
      };
      axiosStub.resolves(mockResponse);
    });

    it("converts USDC to winston correctly for $20", async () => {
      // $20 USDC = 20,000,000 (6 decimals)
      // $20 = 1 AR = 1,000,000,000,000 Winston
      const usdc = "20000000";
      const winston = await oracle.getWinstonForUSDC(usdc);

      expect(winston.toString()).to.equal("1000000000000");
    });

    it("converts USDC to winston correctly for $2", async () => {
      // $2 USDC = 2,000,000 (6 decimals)
      // $2 = 0.1 AR = 100,000,000,000 Winston
      const usdc = "2000000";
      const winston = await oracle.getWinstonForUSDC(usdc);

      expect(winston.toString()).to.equal("100000000000");
    });

    it("converts USDC to winston correctly for $0.20", async () => {
      // $0.20 USDC = 200,000 (6 decimals)
      // $0.20 = 0.01 AR = 10,000,000,000 Winston
      const usdc = "200000";
      const winston = await oracle.getWinstonForUSDC(usdc);

      expect(winston.toString()).to.equal("10000000000");
    });

    it("handles large USDC amounts correctly", async () => {
      // $20,000 USDC = 20,000,000,000 (6 decimals)
      // $20,000 = 1000 AR = 1,000,000,000,000,000 Winston
      const usdc = "20000000000";
      const winston = await oracle.getWinstonForUSDC(usdc);

      expect(winston.toString()).to.equal("1000000000000000");
    });

    it("rounds winston amounts correctly", async () => {
      // Odd USDC amount that may result in fractional winston
      const usdc = "1";
      const winston = await oracle.getWinstonForUSDC(usdc);

      // Should be a valid winston amount (integer)
      expect(winston.toString()).to.match(/^\d+$/);
    });
  });

  describe("price conversion round-trip", () => {
    beforeEach(() => {
      const mockResponse = {
        data: { arweave: { usd: 20.0 } },
      };
      axiosStub.resolves(mockResponse);
    });

    it("maintains precision in round-trip conversion", async () => {
      const originalWinston = W("1000000000000"); // 1 AR

      // Convert to USDC and back
      const usdc = await oracle.getUSDCForWinston(originalWinston);
      const winstonBack = await oracle.getWinstonForUSDC(usdc);

      expect(winstonBack.toString()).to.equal(originalWinston.toString());
    });
  });
});
