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
import { Next } from "koa";

import { KoaContext } from "../server";

// Build wallet addresses from environment variables
// Only include addresses that are actually configured
function buildWalletAddresses(): Record<string, string> {
  const addresses: Record<string, string> = {};

  if (process.env.ARWEAVE_ADDRESS) {
    addresses.arweave = process.env.ARWEAVE_ADDRESS;
  }
  if (process.env.ETHEREUM_ADDRESS) {
    addresses.ethereum = process.env.ETHEREUM_ADDRESS;
  }
  if (process.env.SOLANA_ADDRESS) {
    addresses.solana = process.env.SOLANA_ADDRESS;
    addresses.ed25519 = process.env.SOLANA_ADDRESS; // Alias for Solana
  }
  // As of PE-9070, ARIO is a Solana-native SPL token. Its payment recipient is
  // the bundler's own Solana address (override with ARIO_ADDRESS). We do NOT
  // fall back to a hardcoded default: an unset recipient fails closed so we
  // never validate ARIO payments against a wallet the operator doesn't control.
  const arioAddress = process.env.ARIO_ADDRESS ?? process.env.SOLANA_ADDRESS;
  if (arioAddress) {
    addresses.ario = arioAddress;
  }
  if (process.env.MATIC_ADDRESS) {
    addresses.matic = process.env.MATIC_ADDRESS;
    addresses.pol = process.env.MATIC_ADDRESS; // Alias for Polygon
  }
  if (process.env.BASE_ETH_ADDRESS) {
    addresses["base-eth"] = process.env.BASE_ETH_ADDRESS;
  }
  if (process.env.KYVE_ADDRESS) {
    addresses.kyve = process.env.KYVE_ADDRESS;
  }

  return addresses;
}

// Export for use by other modules (gateway validation, etc.)
export const walletAddresses = buildWalletAddresses();

export async function rootResponse(ctx: KoaContext, next: Next) {
  // Get public-facing gateway FQDNs from environment
  const gateways = process.env.PUBLIC_GATEWAY_FQDNS
    ? process.env.PUBLIC_GATEWAY_FQDNS.split(",").map((url) => url.trim())
    : [ctx.state.gatewayMap.arweave.endpoint];

  ctx.body = {
    version: "0.2.0",
    addresses: walletAddresses,
    gateway: gateways[0], // Primary gateway
    gateways: gateways, // All gateways
  };
  return next();
}
