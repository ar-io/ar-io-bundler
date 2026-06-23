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
import { EphemeralCache } from "@alexsasharegan/simple-cache";
import { ReadThroughPromiseCache } from "@ardrive/ardrive-promise-cache";
import { IncomingMessage } from "http";
import winston from "winston";

import { CacheService } from "../arch/cacheServiceTypes";
import { getElasticacheService } from "../arch/elasticacheService";
import globalLogger from "../logger";
import { MetricRegistry } from "../metricRegistry";
import { ByteCount } from "../types/types";
import {
  breakerForCache,
  normalizeCacheError,
} from "../utils/cacheServiceUtils";

export interface IpUsageData {
  bytesUsed: number;
  lastUpdated: number; // timestamp of last update
}

/**
 * IP Rate Limit Cache (PE-9011 backport):
 *
 * Tracks per-IP byte usage for free upload limits. Bytes-used are stored per
 * IP address in a Redis (Elasticache) key with a fixed TTL window (24h by
 * default). The window is a fixed TTL window: the first write for an IP creates
 * the key with `EX <ttl>` and each subsequent write within the window
 * accumulates onto the running total while resetting the TTL. Once the key
 * expires the IP's counter starts fresh.
 *
 * Uses our Redis/Elasticache cacheService as primary storage with an in-memory
 * fallback when Elasticache is unavailable, gated by a circuit breaker. All
 * remote operations are fail-open: callers treat cache errors as "no usage
 * recorded" so uploads are never blocked by cache outages.
 */

const elasticacheRateLimitPrefix = "rl_ip_";
function getElasticacheRateLimitKey(ipAddress: string) {
  return `${elasticacheRateLimitPrefix}${ipAddress}`;
}

const rateLimitTtlSeconds = +(process.env.FREE_BYTES_PER_IP_TTL_SECS ?? 86_400); // Default to 24 hours in seconds

// In-memory cache for fallback scenarios
const backupCache = EphemeralCache<string, IpUsageData>(
  10000, // Store up to 10k IPs in memory
  rateLimitTtlSeconds * 1_000,
);

const ipUsageCache = new ReadThroughPromiseCache<
  string,
  IpUsageData | null,
  {
    cacheService: CacheService;
    logger: winston.Logger;
  }
>({
  cacheParams: {
    cacheCapacity: 10000,
    cacheTTLMillis: rateLimitTtlSeconds * 1000, // 24 hours
  },
  metricsConfig: {
    cacheName: "ip_rate_limit_cache",
    registry: MetricRegistry.getInstance().getRegistry(),
    labels: {
      env: process.env.NODE_ENV || "local",
    },
  },
  readThroughFunction: async (ipAddress, { cacheService, logger }) => {
    logger.debug(`READ THROUGH: Checking rate limit for IP ${ipAddress}...`);

    const fireResult: IpUsageData | null = await breakerForCache(cacheService)
      .fire(async () => {
        logger.debug(`REMOTE: Getting rate limit data for IP ${ipAddress}...`);
        const val = await cacheService.get(
          getElasticacheRateLimitKey(ipAddress),
        );

        if (val === null) {
          logger.debug(`REMOTE: No rate limit data found for IP ${ipAddress}`);
          return null;
        }

        try {
          const parsed = JSON.parse(val) as IpUsageData;
          logger.debug(`REMOTE: Rate limit data for IP ${ipAddress}:`, parsed);
          return parsed;
        } catch (error) {
          logger.error(`Failed to parse rate limit data for IP ${ipAddress}`, {
            error,
          });
          return null;
        }
      })
      .then((data) => {
        // Write back to local cache if necessary
        if (data && backupCache.get(ipAddress) === undefined) {
          backupCache.write(ipAddress, data);
        }
        return data;
      })
      .catch((error) => {
        logger.error(
          `Falling back to in-memory cache for rate limit check of IP ${ipAddress}...`,
          { error: normalizeCacheError(error) },
        );
        return backupCache.read(ipAddress) ?? null;
      });

    logger.debug(
      `READ THROUGH: Rate limit data for IP ${ipAddress}:`,
      fireResult,
    );
    return fireResult;
  },
});

export async function getIpUsage({
  ipAddress,
  cacheService = getElasticacheService(),
  logger = globalLogger,
}: {
  ipAddress: string;
  cacheService?: CacheService;
  logger?: winston.Logger;
}): Promise<IpUsageData | null> {
  return ipUsageCache.get(ipAddress, { cacheService, logger });
}

export async function updateIpUsage({
  ipAddress,
  bytesToAdd,
  cacheService = getElasticacheService(),
  logger = globalLogger,
}: {
  ipAddress: string;
  bytesToAdd: ByteCount;
  cacheService?: CacheService;
  logger?: winston.Logger;
}): Promise<IpUsageData> {
  const now = Date.now();

  // Get current usage
  const currentUsage = await getIpUsage({ ipAddress, cacheService, logger });

  const newUsageData: IpUsageData = {
    bytesUsed: (currentUsage?.bytesUsed || 0) + bytesToAdd,
    lastUpdated: now,
  };

  // Update local backup cache
  backupCache.write(ipAddress, newUsageData);

  // Update in Elasticache
  await ipUsageCache.put(
    ipAddress,
    (async () => {
      try {
        await breakerForCache(cacheService).fire(() => {
          logger.debug(
            `REMOTE: Updating rate limit data for IP ${ipAddress}...`,
            newUsageData,
          );
          return cacheService.set(
            getElasticacheRateLimitKey(ipAddress),
            JSON.stringify(newUsageData),
            "EX",
            rateLimitTtlSeconds,
          );
        });
      } catch (error) {
        logger.error(
          `Error while updating rate limit data for IP ${ipAddress}!`,
          { error: normalizeCacheError(error) },
        );
        // Don't throw - we have local cache as backup
      }

      return newUsageData;
    })(),
  );

  return newUsageData;
}

/**
 * Number of trusted reverse-proxy hops in front of this service.
 *
 * `X-Forwarded-For` grows left-to-right: each proxy APPENDS the address of the
 * peer that connected to it. A remote client can pre-populate the header with
 * arbitrary values, but it can only ever control entries to the LEFT of what the
 * outermost trusted proxy appends — so the real client IP is the Nth value
 * counting from the RIGHT, where N is the number of trusted hops.
 *
 * Default 1 matches the standard production topology: a single co-located nginx
 * that sets `X-Forwarded-For $proxy_add_x_forwarded_for`, appending the client's
 * socket address. Set `TRUSTED_PROXY_COUNT=0` for a directly-exposed deployment
 * (no trusted proxy): `X-Forwarded-For` is then fully untrusted and only the
 * socket peer address is used. Set it to 2+ when additional trusted proxies
 * (e.g. a cloud load balancer in front of nginx) each append a hop.
 *
 * Taking the trusted-appended entry — rather than the leftmost, client-supplied
 * value — is what makes the per-IP free-upload metering identity non-spoofable:
 * a caller cannot rotate identities to dodge their quota, nor forge a victim IP
 * to exhaust someone else's allowance.
 */
const trustedProxyCount = Math.max(
  0,
  Math.trunc(+(process.env.TRUSTED_PROXY_COUNT ?? 1)),
);

// Normalize IPv4-mapped IPv6 addresses like ::ffff:208.123.24.44.
function normalizeIp(ip: string | undefined): string {
  if (!ip) {
    return "unknown";
  }
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

/**
 * Extract the client IP from an incoming request. When `TRUSTED_PROXY_COUNT` > 0
 * the IP appended by the outermost trusted proxy is taken from `X-Forwarded-For`
 * (the Nth entry from the right, ignoring any values a client prepended);
 * otherwise — and whenever the header is absent — the socket's remote address is
 * used. Falls back to `"unknown"` when no address is available.
 */
export function extractClientIp(request: IncomingMessage): string {
  const socketIp = normalizeIp(request.socket?.remoteAddress);

  if (trustedProxyCount <= 0) {
    // No trusted proxy: X-Forwarded-For is attacker-controlled, so never trust it.
    return socketIp;
  }

  const forwardedFor = request.headers["x-forwarded-for"];
  const parts = (
    Array.isArray(forwardedFor) ? forwardedFor.join(",") : (forwardedFor ?? "")
  )
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length === 0) {
    return socketIp;
  }

  // Count from the right: the outermost trusted proxy's appended entry. Clamp to
  // the leftmost when the chain is shorter than the configured hop count.
  const index = Math.max(0, parts.length - trustedProxyCount);
  return normalizeIp(parts[index]);
}
