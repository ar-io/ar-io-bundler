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
import { X402NetworkConfig, x402Networks } from "../arch/x402Service";

/**
 * Parse a token string into currency, network, and network config
 *
 * Token format: {currency}-{network} OR {network}-{currency} (both supported)
 * Examples: "usdc-base", "base-usdc", "usdc-base-sepolia", "base-sepolia-usdc"
 *
 * @param token - Token string to parse (e.g., "usdc-base" or "base-usdc")
 * @returns Parsed token info or null if invalid
 */
export function parseToken(token: string): {
  currency: string;
  network: string;
  networkConfig: X402NetworkConfig;
} | null {
  // Validate input
  if (!token || typeof token !== "string" || token.trim().length === 0) {
    return null;
  }

  // Try parsing as {currency}-{network} (e.g., "usdc-base")
  const parts = token.split("-");
  const firstPart = parts[0];
  const remainingParts = parts.slice(1);

  // Try format 1: {currency}-{network}
  if (firstPart === "usdc") {
    const network = remainingParts.join("-");
    if (network && network.trim().length > 0) {
      const networkConfig = x402Networks[network];
      if (networkConfig && networkConfig.enabled) {
        return { currency: "usdc", network, networkConfig };
      }
    }
  }

  // Try format 2: {network}-{currency} (e.g., "base-usdc")
  const lastPart = parts[parts.length - 1];
  if (lastPart === "usdc" && parts.length >= 2) {
    const network = parts.slice(0, -1).join("-");
    if (network && network.trim().length > 0) {
      const networkConfig = x402Networks[network];
      if (networkConfig && networkConfig.enabled) {
        return { currency: "usdc", network, networkConfig };
      }
    }
  }

  return null;
}

/**
 * Get list of valid tokens for error messages
 * Returns both {currency}-{network} and {network}-{currency} formats
 */
export function getValidTokens(): string[] {
  const enabledNetworks = Object.keys(x402Networks).filter(
    (network) => x402Networks[network].enabled
  );

  // Return both formats for better UX
  const tokens: string[] = [];
  enabledNetworks.forEach((network) => {
    tokens.push(`usdc-${network}`);
    tokens.push(`${network}-usdc`);
  });

  return tokens;
}
