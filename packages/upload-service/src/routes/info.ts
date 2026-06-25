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

import {
  advertisedFreeUploadLimitBytes,
  publicAccessGatewayUrl,
  receiptVersion,
} from "../constants";
import { KoaContext } from "../server";
import { jwkToPublicArweaveAddress } from "../utils/base64";

export async function rootResponse(ctx: KoaContext, next: Next) {
  const signingWalletAddress = jwkToPublicArweaveAddress(
    await ctx.state.getArweaveWallet()
  );

  // Get public-facing gateway FQDNs from environment
  const gateways = process.env.PUBLIC_GATEWAY_FQDNS
    ? process.env.PUBLIC_GATEWAY_FQDNS.split(",").map((url) => url.trim())
    : [publicAccessGatewayUrl.origin];

  ctx.body = {
    version: receiptVersion,
    addresses: {
      arweave: signingWalletAddress,
      ethereum: process.env.ETHEREUM_ADDRESS,
      solana: process.env.SOLANA_ADDRESS,
      matic: process.env.MATIC_ADDRESS,
      kyve: process.env.KYVE_ADDRESS,
    },
    gateway: gateways[0], // Primary gateway
    gateways: gateways, // All gateways
    freeUploadLimitBytes: advertisedFreeUploadLimitBytes,
  };
  return next();
}
