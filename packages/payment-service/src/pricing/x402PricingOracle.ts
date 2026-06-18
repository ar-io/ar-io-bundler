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

import { oneARInWinston } from "../constants";
import logger from "../logger";
import { W, Winston } from "../types";

const USDC_DECIMALS = 6; // USDC has 6 decimals
const COINGECKO_API_URL = "https://api.coingecko.com/api/v3/simple/price";
const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

export class X402PricingOracle {
  private cachedArPrice: number | null = null;
  private cacheTimestamp = 0;

  /**
   * Convert Winston credits to USDC atomic units
   * @param winston Winston amount to convert
   * @returns USDC amount in atomic units (6 decimals)
   */
  async getUSDCForWinston(winston: Winston): Promise<string> {
    // 1. Get AR/USD price from oracle
    const arPriceUSD = await this.getARPriceInUSD();

    // 2. Convert Winston to AR
    const ar = Number(winston) / oneARInWinston;

    // 3. Convert AR to USD
    const usd = ar * arPriceUSD;

    // 4. Convert USD to USDC atomic units (6 decimals)
    // Add 1 to round up (always overcharge slightly rather than undercharge)
    const usdc = Math.ceil(usd * Math.pow(10, USDC_DECIMALS));

    logger.debug("Winston to USDC conversion", {
      winston,
      ar,
      arPriceUSD,
      usd,
      usdcAtomicUnits: usdc,
    });

    return usdc.toString();
  }

  /**
   * Convert USDC atomic units to Winston credits
   * @param usdc USDC amount in atomic units (6 decimals)
   * @returns Winston amount
   */
  async getWinstonForUSDC(usdc: string): Promise<Winston> {
    // 1. Get AR/USD price from oracle
    const arPriceUSD = await this.getARPriceInUSD();

    // 2. Convert USDC atomic units to USD
    const usd = Number(usdc) / Math.pow(10, USDC_DECIMALS);

    // 3. Convert USD to AR
    const ar = usd / arPriceUSD;

    // 4. Convert AR to Winston
    const winstonStr = Math.floor(ar * oneARInWinston).toString();
    const winston = W(winstonStr);

    logger.debug("USDC to Winston conversion", {
      usdcAtomicUnits: usdc,
      usd,
      arPriceUSD,
      ar,
      winston: winstonStr,
    });

    return winston;
  }

  /**
   * Get the current AR/USD price from CoinGecko
   * Caches the result for 5 minutes to avoid rate limiting
   */
  private async getARPriceInUSD(): Promise<number> {
    // Check cache
    const now = Date.now();
    if (
      this.cachedArPrice !== null &&
      now - this.cacheTimestamp < CACHE_DURATION_MS
    ) {
      logger.debug("Using cached AR price", {
        price: this.cachedArPrice,
        age: now - this.cacheTimestamp,
      });
      return this.cachedArPrice;
    }

    // Fetch from CoinGecko
    try {
      logger.debug("Fetching AR price from CoinGecko");

      const response = await axios.get(COINGECKO_API_URL, {
        params: {
          ids: "arweave",
          vs_currencies: "usd",
        },
        timeout: 5000,
      });

      const price = response.data.arweave?.usd;

      if (typeof price !== "number" || price <= 0) {
        throw new Error(`Invalid AR price from CoinGecko: ${price}`);
      }

      // Update cache
      this.cachedArPrice = price;
      this.cacheTimestamp = now;

      logger.info("Fetched AR price from CoinGecko", {
        price,
        timestamp: new Date(now).toISOString(),
      });

      return price;
    } catch (error) {
      logger.error("Failed to fetch AR price from CoinGecko", { error });

      // If we have a cached price (even if stale), use it as fallback
      if (this.cachedArPrice !== null) {
        logger.warn("Using stale cached AR price as fallback", {
          price: this.cachedArPrice,
          age: now - this.cacheTimestamp,
        });
        return this.cachedArPrice;
      }

      // No cache available, throw error
      throw new Error(
        "Failed to fetch AR price and no cached price available"
      );
    }
  }

  /**
   * Clear the price cache (useful for testing)
   */
  clearCache(): void {
    this.cachedArPrice = null;
    this.cacheTimestamp = 0;
  }
}

// Singleton instance shared across all requests to enable price caching
// Creating new instances per-request defeats the 5-minute cache
export const x402PricingOracle = new X402PricingOracle();
