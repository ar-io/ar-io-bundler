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
  ArweaveNetworkResponse,
  ExponentialBackoffRetryStrategy,
  parseRetryAfterMs,
} from "./retryStrategy";

// A 429 response carrying Retry-After: 0 so the bounded throttle resolves
// instantly (real timers, no fake-timer plumbing) — this isolates the budget /
// termination behavior without making the test sleep 60s per iteration.
const rateLimited = (retryAfter = "0"): ArweaveNetworkResponse => ({
  status: 429,
  statusText: "Too Many Requests",
  headers: { "retry-after": retryAfter },
});

const ok = (): ArweaveNetworkResponse => ({
  status: 200,
  statusText: "OK",
});

describe("ExponentialBackoffRetryStrategy 429 handling", () => {
  it("terminates after the rate-limit budget instead of looping forever", async () => {
    const strategy =
      new ExponentialBackoffRetryStrategy<ArweaveNetworkResponse>({
        maxRateLimitRetries: 3,
      });

    let calls = 0;
    const request = async () => {
      calls++;
      return rateLimited(); // gateway is permanently rate limiting
    };

    let threw = false;
    try {
      await strategy.sendRequest(request);
    } catch (error) {
      threw = true;
      expect((error as Error).message).to.match(/rate limited/i);
    }

    expect(threw, "must throw once the rate-limit budget is exhausted").to.be
      .true;
    // Initial attempt + maxRateLimitRetries (3) throttled re-attempts = 4 calls,
    // then it gives up. The key property: it is BOUNDED (does not loop forever).
    expect(calls).to.equal(4);
  });

  it("recovers when the gateway stops rate limiting within the budget", async () => {
    const strategy =
      new ExponentialBackoffRetryStrategy<ArweaveNetworkResponse>({
        maxRateLimitRetries: 3,
      });

    let calls = 0;
    const request = async () => {
      calls++;
      // 429 twice, then succeed — within the budget.
      return calls <= 2 ? rateLimited() : ok();
    };

    const resp = await strategy.sendRequest(request);
    expect(resp.status).to.equal(200);
    expect(calls).to.equal(3);
  });

  it("honors a bounded Retry-After wait (and counts it toward the budget)", async () => {
    const strategy =
      new ExponentialBackoffRetryStrategy<ArweaveNetworkResponse>({
        maxRateLimitRetries: 1,
      });

    let calls = 0;
    const request = async () => {
      calls++;
      return rateLimited("0.05"); // 50ms Retry-After
    };

    const start = Date.now();
    let threw = false;
    try {
      await strategy.sendRequest(request);
    } catch {
      threw = true;
    }
    const elapsed = Date.now() - start;

    expect(threw, "still terminates after the (1) rate-limit retry").to.be.true;
    // One throttled retry honoring the 50ms Retry-After — so we waited at least
    // ~50ms but nowhere near the fixed 60s fallback (proves Retry-After is used).
    expect(elapsed).to.be.greaterThan(40);
    expect(elapsed).to.be.lessThan(5_000);
    expect(calls).to.equal(2); // initial + 1 retry
  });
});

describe("parseRetryAfterMs", () => {
  it("returns undefined when the header is absent", () => {
    expect(parseRetryAfterMs(undefined)).to.equal(undefined);
    expect(parseRetryAfterMs({})).to.equal(undefined);
  });

  it("parses delta-seconds into milliseconds", () => {
    expect(parseRetryAfterMs({ "retry-after": "120" })).to.equal(120_000);
    expect(parseRetryAfterMs({ "Retry-After": "0" })).to.equal(0);
  });

  it("parses an HTTP-date into a bounded positive delta", () => {
    const fiveSecondsOut = new Date(Date.now() + 5_000).toUTCString();
    const ms = parseRetryAfterMs({ "retry-after": fiveSecondsOut });
    expect(ms).to.be.a("number");
    // Allow for clock skew within the test; should be roughly 5s.
    expect(ms as number).to.be.greaterThan(1_000);
    expect(ms as number).to.be.lessThan(10_000);
  });

  it("clamps a past HTTP-date to 0 rather than a negative wait", () => {
    const inThePast = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfterMs({ "retry-after": inThePast })).to.equal(0);
  });

  it("returns undefined for unparseable values", () => {
    expect(parseRetryAfterMs({ "retry-after": "soon" })).to.equal(undefined);
  });
});
