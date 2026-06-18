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
  rateLimitTtlSeconds * 1_000
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
          getElasticacheRateLimitKey(ipAddress)
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
          { error: normalizeCacheError(error) }
        );
        return backupCache.read(ipAddress) ?? null;
      });

    logger.debug(
      `READ THROUGH: Rate limit data for IP ${ipAddress}:`,
      fireResult
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
            newUsageData
          );
          return cacheService.set(
            getElasticacheRateLimitKey(ipAddress),
            JSON.stringify(newUsageData),
            "EX",
            rateLimitTtlSeconds
          );
        });
      } catch (error) {
        logger.error(
          `Error while updating rate limit data for IP ${ipAddress}!`,
          { error: normalizeCacheError(error) }
        );
        // Don't throw - we have local cache as backup
      }

      return newUsageData;
    })()
  );

  return newUsageData;
}

/**
 * Extract the client IP from an incoming request, honoring the
 * X-Forwarded-For proxy header (first hop) when present and falling back to
 * the socket's remote address. IPv4-mapped IPv6 addresses are normalized.
 */
export function extractClientIp(request: IncomingMessage): string {
  const forwardedFor = request.headers["x-forwarded-for"];

  const raw =
    typeof forwardedFor === "string"
      ? forwardedFor
      : Array.isArray(forwardedFor)
      ? forwardedFor[0]
      : undefined;

  if (raw) {
    return raw.split(",")[0].trim();
  }

  const remote = request.socket?.remoteAddress || "unknown";

  // Optional: normalize IPv4-mapped IPv6 addresses like ::ffff:208.123.24.44
  return remote.startsWith("::ffff:") ? remote.slice(7) : remote;
}
