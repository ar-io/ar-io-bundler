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

import logger from "../logger";
import { W, Winston } from "../types/types";

// Hard ceiling on how stale a cached AR/USD price may be and still be used to
// price x402 payments when CoinGecko is failing. Past this, fail CLOSED rather
// than charging off an arbitrarily old price. Mirrors the payment-service oracle.
const MAX_STALE_AR_PRICE_MS = +(
  process.env.MAX_STALE_AR_PRICE_MS || 60 * 60 * 1000
);

/**
 * Simple x402 pricing oracle for converting Winston to USDC
 *
 * NOTE: This oracle provides EXACT conversions without any markup.
 * Pricing buffers/fees should be applied by the caller BEFORE calling these methods.
 */
export class X402PricingOracle {
  private arPriceCache: { price: number; timestamp: number } | null = null;
  private cacheDuration = 60000; // 1 minute cache

  /**
   * Get current AR price in USD from CoinGecko
   */
  private async getArPriceInUSD(): Promise<number> {
    // Check cache
    if (
      this.arPriceCache &&
      Date.now() - this.arPriceCache.timestamp < this.cacheDuration
    ) {
      return this.arPriceCache.price;
    }

    try {
      const response = await axios.get(
        "https://api.coingecko.com/api/v3/simple/price?ids=arweave&vs_currencies=usd",
        { timeout: 5000 }
      );

      const price = response.data?.arweave?.usd;
      if (!price || typeof price !== "number") {
        throw new Error("Invalid price response from CoinGecko");
      }

      // Update cache
      this.arPriceCache = { price, timestamp: Date.now() };
      logger.debug("Fetched AR price from CoinGecko", { price });

      return price;
    } catch (error) {
      logger.error("Failed to fetch AR price from CoinGecko", { error });

      // Bounded stale fallback: ride out a SHORT oracle outage with the last good
      // price, but fail CLOSED once it is too stale. Pricing x402 payments off an
      // unbounded-stale (or, previously, a hardcoded $20) price can materially
      // under/over-charge as the market moves.
      if (this.arPriceCache) {
        const staleAge = Date.now() - this.arPriceCache.timestamp;
        if (staleAge <= MAX_STALE_AR_PRICE_MS) {
          logger.warn("Using stale AR price from cache", {
            price: this.arPriceCache.price,
            age: staleAge,
            maxStaleMs: MAX_STALE_AR_PRICE_MS,
          });
          return this.arPriceCache.price;
        }
        logger.error("Cached AR price is too stale to price payments", {
          price: this.arPriceCache.price,
          age: staleAge,
          maxStaleMs: MAX_STALE_AR_PRICE_MS,
        });
      }

      // No usable cached price → fail closed. (Previously fell back to a hardcoded
      // $20, which silently mis-priced uploads whenever AR != $20.)
      throw new Error(
        "Failed to fetch AR price and no sufficiently-fresh cached price available"
      );
    }
  }

  /**
   * Convert Winston to USDC atomic units (6 decimals)
   *
   * Returns EXACT conversion with NO markup/buffer.
   * Caller should apply pricing buffer (X402_PRICING_BUFFER_PERCENT) separately.
   *
   * @param winston - Amount in Winston (10^-12 AR)
   * @returns USDC amount in atomic units (10^-6 USDC)
   */
  async getUSDCForWinston(winston: Winston): Promise<string> {
    const arPriceUSD = await this.getArPriceInUSD();

    // Convert Winston to AR (1 AR = 10^12 Winston)
    const arAmount = Number(winston.toString()) / 1e12;

    // Convert AR to USD (EXACT, no markup)
    const usdAmount = arAmount * arPriceUSD;

    // Convert USD to USDC atomic units (1 USDC = 10^6 atomic units)
    const usdcAtomicUnits = Math.ceil(usdAmount * 1e6);

    // Ensure minimum of 0.1 cent (1000 atomic units = 0.001 USDC)
    const minUsdcAtomicUnits = 1000;
    const finalAmount = Math.max(usdcAtomicUnits, minUsdcAtomicUnits);

    logger.debug("Converted Winston to USDC (exact, no buffer)", {
      winston: winston.toString(),
      arAmount,
      arPriceUSD,
      usdAmount,
      usdcAtomicUnits: finalAmount,
    });

    return finalAmount.toString();
  }

  /**
   * Convert USDC atomic units to Winston
   * @param usdcAtomicUnits - USDC amount in atomic units (10^-6 USDC)
   * @returns Winston amount
   */
  async getWinstonForUSDC(usdcAtomicUnits: string): Promise<Winston> {
    const arPriceUSD = await this.getArPriceInUSD();

    // Convert USDC atomic units to USD (1 USDC = 10^6 atomic units)
    const usdAmount = Number(usdcAtomicUnits) / 1e6;

    // Convert USD to AR
    const arAmount = usdAmount / arPriceUSD;

    // Convert AR to Winston (1 AR = 10^12 Winston)
    const winstonAmount = Math.floor(arAmount * 1e12);

    logger.debug("Converted USDC to Winston", {
      usdcAtomicUnits,
      usdAmount,
      arPriceUSD,
      arAmount,
      winstonAmount,
    });

    return W(winstonAmount.toString());
  }
}

// Singleton instance shared across all requests to enable price caching
// Creating new instances per-request defeats the 1-minute cache
export const x402PricingOracle = new X402PricingOracle();

// Minimum x402 price (0.001 USDC in atomic units with 6 decimals). Lives here
// (the shared pricing util) so the quote route and the unsigned-upload handler
// apply the SAME floor — divergence here means quote != actual charge.
export const MINIMUM_USDC_PRICE = 1000;

/**
 * Flat per-data-item surcharge (USD_PRICE_PER_DATA_ITEM, default $0.00002) in
 * USDC atomic units (6 decimals; USDC is treated 1:1 with USD, matching the
 * payment-service x402 oracle). The unsigned/raw x402 flow always produces
 * exactly ONE bundler-signed data item, so this is added once.
 *
 * Mirrors the per-data-item surcharge the payment-service applies for
 * credit/signed-x402 uploads (getWCForDataItem / getTxAttributesForDataItems);
 * without it, the local-priced unsigned x402 path underpays that fee. Read live
 * from the env so it stays a no-rebuild config knob (and is testable).
 */
export function perItemSurchargeUsdcAtomic(): number {
  const usdPerItem = +(process.env.USD_PRICE_PER_DATA_ITEM || 0.00002);
  if (!Number.isFinite(usdPerItem) || usdPerItem <= 0) {
    return 0;
  }
  return Math.ceil(usdPerItem * 1e6);
}

/**
 * Apply the x402 fee markup and minimum-price floor to an exact USDC amount,
 * including the flat per-data-item surcharge.
 *
 * Single source of truth for the unsigned/raw x402 path: the price-quote route
 * (x402RawDataPricing) and the actual upload charge (rawDataPost) BOTH call this,
 * so the amount a client is quoted always matches what it is charged.
 * - Surcharge: perItemSurchargeUsdcAtomic(), added to the base before the fee
 *   (so the markup applies on top of it, matching the signed/credit path where
 *   the x402 buffer multiplies byte-price + surcharge).
 * - Fee: X402_FEE_PERCENT is primary; X402_PRICING_BUFFER_PERCENT is the
 *   deprecated fallback (back-compat with existing deployments).
 * - Floor: MINIMUM_USDC_PRICE (0.001 USDC).
 *
 * @param exactUsdcAmount exact USDC atomic units (no markup) from the oracle
 * @returns final USDC atomic units (string) including surcharge + fee + floor
 */
export function applyX402FeeAndFloor(exactUsdcAmount: string): string {
  // Use || (not ??) so an empty-string env var (common with compose
  // `${VAR:-}` passthrough) falls through instead of yielding NaN. "0" is a
  // non-empty string so a 0% fee is still honored.
  const x402FeePercent = parseInt(
    process.env.X402_FEE_PERCENT ||
      process.env.X402_PRICING_BUFFER_PERCENT ||
      "15",
    10
  );
  const baseWithSurcharge =
    Number(exactUsdcAmount) + perItemSurchargeUsdcAtomic();
  const withFee = Math.ceil(baseWithSurcharge * (1 + x402FeePercent / 100));
  return Math.max(withFee, MINIMUM_USDC_PRICE).toString();
}
