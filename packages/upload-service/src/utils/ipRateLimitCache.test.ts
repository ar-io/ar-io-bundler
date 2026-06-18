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
import { randomUUID } from "crypto";
import { IncomingMessage } from "http";
import { describe, it } from "mocha";

import { CacheService } from "../arch/cacheServiceTypes";
import {
  extractClientIp,
  getIpUsage,
  updateIpUsage,
} from "./ipRateLimitCache";

/**
 * Minimal in-memory CacheService double that records the values written by the
 * IP rate limit counter. It implements only the methods exercised by
 * ipRateLimitCache (`get`/`set`) plus the `status` flag required by the cache
 * circuit breaker.
 */
function fakeCacheService(): CacheService & {
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  const fake = {
    store,
    status: "ready",
    isCluster: false,
    get: async (key: string) => store.get(key) ?? null,
    // Signature mirrors ioredis set(key, value, "EX", seconds)
    set: async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    },
  };
  return fake as unknown as CacheService & { store: Map<string, string> };
}

// Use a fresh random IP per assertion so the process-wide read-through cache
// in ipRateLimitCache never serves a stale entry from a previous test.
function randomIp(): string {
  return `10.${randomUUID().slice(0, 8)}`;
}

function fakeRequest(
  headers: Record<string, string | string[] | undefined>,
  remoteAddress?: string
): IncomingMessage {
  return {
    headers,
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

describe("ipRateLimitCache - IP byte counter", () => {
  it("returns null usage for an IP that has never uploaded", async () => {
    const cacheService = fakeCacheService();
    const usage = await getIpUsage({ ipAddress: randomIp(), cacheService });
    expect(usage).to.equal(null);
  });

  it("records bytes used on first update", async () => {
    const cacheService = fakeCacheService();
    const ipAddress = randomIp();

    const result = await updateIpUsage({
      ipAddress,
      bytesToAdd: 1024,
      cacheService,
    });

    expect(result.bytesUsed).to.equal(1024);
    expect(result.lastUpdated).to.be.a("number");

    const usage = await getIpUsage({ ipAddress, cacheService });
    expect(usage?.bytesUsed).to.equal(1024);
  });

  it("accumulates bytes across multiple updates within the window", async () => {
    const cacheService = fakeCacheService();
    const ipAddress = randomIp();

    await updateIpUsage({ ipAddress, bytesToAdd: 1000, cacheService });
    await updateIpUsage({ ipAddress, bytesToAdd: 2500, cacheService });
    const third = await updateIpUsage({
      ipAddress,
      bytesToAdd: 500,
      cacheService,
    });

    expect(third.bytesUsed).to.equal(4000);

    const usage = await getIpUsage({ ipAddress, cacheService });
    expect(usage?.bytesUsed).to.equal(4000);
  });

  it("persists the counter to the backing cache with the rate-limit prefix", async () => {
    const cacheService = fakeCacheService();
    const ipAddress = randomIp();

    await updateIpUsage({ ipAddress, bytesToAdd: 777, cacheService });

    const key = `rl_ip_${ipAddress}`;
    const raw = cacheService.store.get(key);
    expect(raw, "expected the counter to be written to the backing cache").to.be
      .a("string");
    expect(JSON.parse(raw as string).bytesUsed).to.equal(777);
  });

  it("tracks usage independently per IP address", async () => {
    const cacheService = fakeCacheService();
    const ipA = randomIp();
    const ipB = randomIp();

    await updateIpUsage({ ipAddress: ipA, bytesToAdd: 100, cacheService });
    await updateIpUsage({ ipAddress: ipB, bytesToAdd: 999, cacheService });

    expect((await getIpUsage({ ipAddress: ipA, cacheService }))?.bytesUsed).to.equal(
      100
    );
    expect((await getIpUsage({ ipAddress: ipB, cacheService }))?.bytesUsed).to.equal(
      999
    );
  });
});

describe("ipRateLimitCache - extractClientIp", () => {
  it("uses the first hop of x-forwarded-for when present", () => {
    const req = fakeRequest(
      { "x-forwarded-for": "203.0.113.5, 70.41.3.18, 150.172.238.178" },
      "10.0.0.1"
    );
    expect(extractClientIp(req)).to.equal("203.0.113.5");
  });

  it("handles an array-valued x-forwarded-for header", () => {
    const req = fakeRequest(
      { "x-forwarded-for": ["198.51.100.7", "203.0.113.5"] },
      "10.0.0.1"
    );
    expect(extractClientIp(req)).to.equal("198.51.100.7");
  });

  it("falls back to the socket remote address when no proxy header", () => {
    const req = fakeRequest({}, "192.0.2.44");
    expect(extractClientIp(req)).to.equal("192.0.2.44");
  });

  it("normalizes IPv4-mapped IPv6 remote addresses", () => {
    const req = fakeRequest({}, "::ffff:208.123.24.44");
    expect(extractClientIp(req)).to.equal("208.123.24.44");
  });

  it("returns 'unknown' when no IP information is available", () => {
    const req = fakeRequest({}, undefined);
    expect(extractClientIp(req)).to.equal("unknown");
  });
});
