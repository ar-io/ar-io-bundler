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
import { ArweaveSigner, DataItem, Tag, createData } from "@dha-team/arbundles";
import { JWKInterface } from "arweave/node/lib/wallet";

export interface CreateDataItemOptions {
  data: Buffer;
  tags?: Tag[];
  contentType?: string;
  payerAddress?: string;
  paymentMetadata?: {
    nonce: string;
    validAfter: string;
    validBefore: string;
  };
  x402Payment?: {
    txHash: string;
    paymentId: string;
    network: string;
  };
  target?: string;
  anchor?: string;
}

/**
 * Creates a signed ANS-104 data item from raw data
 * This is used for the raw data upload flow where the server signs on behalf of the user
 */
export async function createDataItemFromRaw(
  options: CreateDataItemOptions,
  wallet: JWKInterface
): Promise<DataItem> {
  const tags: Tag[] = [];

  // Add Content-Type tag if provided
  if (options.contentType) {
    tags.push({ name: "Content-Type", value: options.contentType });
  }

  // Add custom tags from request
  if (options.tags && options.tags.length > 0) {
    tags.push(...options.tags);
  }

  // Add attribution tags for raw data uploads (server-signed)
  // These tags help identify that this is a raw upload processed through the bundler
  tags.push({
    name: "Bundler",
    value: process.env.APP_NAME || "AR.IO Bundler",
  });

  tags.push({
    name: "Upload-Type",
    value: "raw-data-x402",
  });

  // Add payer address for attribution (who actually paid for this upload)
  // This is the Ethereum address that provided the x402 payment
  if (options.payerAddress) {
    tags.push({
      name: "Payer-Address",
      value: options.payerAddress,
    });
  }

  // Add x402 payment authorization metadata (if pre-settlement)
  if (options.paymentMetadata) {
    tags.push({
      name: "X402-Payment-Nonce",
      value: options.paymentMetadata.nonce,
    });
    tags.push({
      name: "X402-Valid-After",
      value: options.paymentMetadata.validAfter,
    });
    tags.push({
      name: "X402-Valid-Before",
      value: options.paymentMetadata.validBefore,
    });
  }

  // Add x402 payment transaction details (if post-settlement)
  if (options.x402Payment) {
    tags.push({
      name: "X402-TX-Hash",
      value: options.x402Payment.txHash,
    });
    tags.push({
      name: "X402-Payment-ID",
      value: options.x402Payment.paymentId,
    });
    tags.push({
      name: "X402-Network",
      value: options.x402Payment.network,
    });
  }

  // Add timestamp for when this was created
  tags.push({
    name: "Upload-Timestamp",
    value: Date.now().toString(),
  });

  // Validate all tags before creating data item
  tags.forEach((tag, index) => {
    if (typeof tag.name !== "string" || typeof tag.value !== "string") {
      throw new Error(
        `Invalid tag at index ${index}: name=${typeof tag.name}(${JSON.stringify(
          tag.name
        )}), value=${typeof tag.value}(${JSON.stringify(tag.value)})`
      );
    }
  });

  // Create signer
  const signer = new ArweaveSigner(wallet);

  // Create data item with options
  const dataItem = createData(options.data, signer, {
    tags,
    target: options.target,
    anchor: options.anchor,
  });

  // Sign the data item
  await dataItem.sign(signer);

  return dataItem;
}

/**
 * Estimate the size of a data item that would be created from raw data
 * Used for price quotes before the data item is actually created
 */
export function estimateDataItemSize(
  rawDataSize: number,
  tagCount = 0
): number {
  // ANS-104 overhead calculation:
  // - Signature: ~512 bytes (Arweave signature)
  // - Owner (public key): ~512 bytes
  // - Target flag: 1 byte
  // - Anchor flag: 1 byte
  // - Tag count: 8 bytes
  // - Tag size: 8 bytes
  // - Tags: ~64 bytes per tag (name + value + encoding)
  // - Other headers: ~50 bytes

  const signatureOverhead = 512;
  const ownerOverhead = 512;
  const headerOverhead = 80;
  const perTagOverhead = 64;
  const tagOverhead = tagCount * perTagOverhead;

  // NOTE: System tags (Bundler, Upload-Type, Payer-Address, X402-*, Upload-Timestamp, Content-Type)
  // are now included in the tagCount parameter by the caller (rawDataPost.ts lines 119-124, 492-497)
  // No additional system tag overhead needed here.

  return (
    rawDataSize +
    signatureOverhead +
    ownerOverhead +
    headerOverhead +
    tagOverhead
  );
}
