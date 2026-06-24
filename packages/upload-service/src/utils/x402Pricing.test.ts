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
import axios from "axios";
import { expect } from "chai";
import { SinonStub, stub, useFakeTimers } from "sinon";

import { X402PricingOracle } from "./x402Pricing";

// Regression: the upload-service x402 oracle's fetch-failure fallback used to (a)
// return the cached AR/USD price with NO maximum staleness and (b) fall back to a
// hardcoded $20 when there was no cache — both of which silently mis-price paid
// x402 uploads. It must instead reuse a cached price only within a bounded window
// and otherwise fail CLOSED.
describe("X402PricingOracle (upload) stale-price safety", () => {
  let oracle: X402PricingOracle;
  let axiosStub: SinonStub;

  beforeEach(() => {
    oracle = new X402PricingOracle();
    axiosStub = stub(axios, "get");
  });

  afterEach(() => {
    axiosStub.restore();
  });

  const callPrice = () =>
    (
      oracle as unknown as { getArPriceInUSD(): Promise<number> }
    ).getArPriceInUSD();

  it("fetches and caches the AR price from CoinGecko", async () => {
    axiosStub.resolves({ data: { arweave: { usd: 25.5 } } });
    expect(await callPrice()).to.equal(25.5);
  });

  it("reuses a stale cached price within the stale cap when CoinGecko fails", async () => {
    const clock = useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    try {
      axiosStub.resolves({ data: { arweave: { usd: 25.5 } } });
      expect(await callPrice()).to.equal(25.5); // seed

      // Past the 1-min cache window, well within the 1h stale cap.
      clock.tick(10 * 60 * 1000);
      axiosStub.rejects(new Error("CoinGecko 500"));

      expect(await callPrice()).to.equal(25.5);
    } finally {
      clock.restore();
    }
  });

  it("fails closed (throws, NOT a $20 guess) when the cache is older than the cap", async () => {
    const clock = useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    try {
      axiosStub.resolves({ data: { arweave: { usd: 25.5 } } });
      await callPrice(); // seed

      clock.tick(2 * 60 * 60 * 1000); // > 1h
      axiosStub.rejects(new Error("CoinGecko 500"));

      let threw = false;
      try {
        await callPrice();
      } catch (error) {
        threw = true;
        expect((error as Error).message).to.include(
          "no sufficiently-fresh cached price"
        );
      }
      expect(
        threw,
        "must fail closed, not return a stale/guessed price"
      ).to.equal(true);
    } finally {
      clock.restore();
    }
  });

  it("fails closed (throws, NOT $20) when there is no cache and the fetch fails", async () => {
    axiosStub.rejects(new Error("CoinGecko 500"));

    let result: number | undefined;
    let threw = false;
    try {
      result = await callPrice();
    } catch {
      threw = true;
    }
    expect(threw, "no cache + fetch failure must throw").to.equal(true);
    expect(result, "must never silently return the old hardcoded $20").to.equal(
      undefined
    );
  });
});
