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
import { ArweaveSigner } from "@dha-team/arbundles";
import { Base64UrlString } from "arweave/node/lib/utils";

import {
  rawDataItemJwk,
  setRawDataItemWalletAddress,
  turboLocalJwk,
} from "../constants";
import logger from "../logger";
import { JWKInterface } from "../types/jwkTypes";
import { jwkToPublicArweaveAddress } from "./base64";

// AWS Secrets Manager integration removed - using local wallet.json only

export async function getArweaveWallet(): Promise<JWKInterface> {
  if (!turboLocalJwk) {
    throw new Error(
      "Local JWK wallet not configured. Please set TURBO_JWK_FILE in .env"
    );
  }
  logger.debug("Using local JWK for Turbo wallet");
  return turboLocalJwk;
}

export async function getRawDataItemWallet(): Promise<JWKInterface> {
  if (!rawDataItemJwk) {
    throw new Error(
      "Raw data item wallet not configured. Please set RAW_DATA_ITEM_JWK_FILE in .env"
    );
  }

  // Automatically add this wallet to the allowlist (one-time initialization)
  const address = jwkToPublicArweaveAddress(rawDataItemJwk);
  setRawDataItemWalletAddress(address);

  logger.debug("Using local JWK for raw data item wallet", { address });
  return rawDataItemJwk;
}

export async function getOpticalWallet(): Promise<JWKInterface> {
  if (!turboLocalJwk) {
    throw new Error(
      "Local JWK wallet not configured. Please set TURBO_JWK_FILE in .env"
    );
  }
  logger.debug("Using local JWK for Turbo optical wallet");
  return turboLocalJwk;
}

export async function getOpticalPubKey(): Promise<Base64UrlString> {
  if (!turboLocalJwk) {
    throw new Error(
      "Local JWK wallet not configured. Please set TURBO_JWK_FILE in .env"
    );
  }
  logger.debug("Using local JWK for Turbo optical pub key");
  return new ArweaveSigner(turboLocalJwk).publicKey.toString("base64url");
}
