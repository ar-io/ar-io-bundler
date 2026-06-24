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
import { Tag } from "@dha-team/arbundles";
import { SignatureConfig } from "../types/types";

/**
 * Checks if a buffer contains a valid ANS-104 data item
 * ANS-104 data items start with a 2-byte little-endian signature type
 */
export function isANS104DataItem(buffer: Buffer): boolean {
  if (buffer.length < 2) {
    return false;
  }

  // Read signature type as 16-bit little-endian
  const signatureType = buffer.readUInt16LE(0);

  // Valid ANS-104 signature types (from SignatureConfig enum)
  const validSignatureTypes = [
    SignatureConfig.ARWEAVE,        // 1
    SignatureConfig.ED25519,        // 2
    SignatureConfig.ETHEREUM,       // 3
    SignatureConfig.SOLANA,         // 4
    SignatureConfig.INJECTEDAPTOS,  // 5
    SignatureConfig.MULTIAPTOS,     // 6
    SignatureConfig.TYPEDETHEREUM,  // 7
    SignatureConfig.KYVE,           // 8
  ];

  return validSignatureTypes.includes(signatureType);
}

/**
 * Convert kebab-case to proper case for tag names
 * Examples:
 *   "will" -> "Will"
 *   "app-name" -> "App-Name"
 *   "user-id" -> "User-Id"
 */
function kebabCaseToProperCase(str: string): string {
  return str
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('-');
}

/**
 * Extract tags from HTTP headers with X-Tag-* prefix
 * Example: X-Tag-App-Name: MyApp -> { name: "App-Name", value: "MyApp" }
 *
 * Note: HTTP headers are case-insensitive and often normalized to lowercase.
 * We convert the tag name from kebab-case to proper case (e.g., "will" -> "Will")
 */
export function extractTagsFromHeaders(headers: Record<string, string | string[] | undefined>): Tag[] {
  const tags: Tag[] = [];

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();

    if (lowerKey.startsWith("x-tag-")) {
      const rawTagName = key.substring(6); // Remove 'x-tag-' prefix
      const tagName = kebabCaseToProperCase(rawTagName); // Convert to proper case
      const tagValue = Array.isArray(value) ? value[0] : value;

      if (tagValue) {
        tags.push({ name: tagName, value: tagValue });
      }
    }
  }

  return tags;
}

/**
 * Parse raw data request body and headers
 * Supports both:
 * 1. Binary upload with X-Tag-* headers
 * 2. JSON envelope with data and tags
 */
export interface ParsedRawDataRequest {
  data: Buffer;
  tags: Tag[];
  contentType?: string;
}

export function parseRawDataRequest(
  rawBody: Buffer,
  contentType?: string,
  headers?: Record<string, string | string[] | undefined>
): ParsedRawDataRequest {
  // Try JSON envelope format first
  if (contentType?.includes("application/json")) {
    try {
      const json = JSON.parse(rawBody.toString("utf8"));

      if (json.data) {
        // JSON envelope format: { data: "base64...", tags: [...] }
        return {
          data: Buffer.from(json.data, "base64"),
          tags: json.tags || [],
          contentType: json.contentType,
        };
      }
    } catch (error) {
      // Not valid JSON or doesn't have expected structure
      // Fall through to binary handling
    }
  }

  // Binary upload with X-Tag-* headers
  return {
    data: rawBody,
    tags: headers ? extractTagsFromHeaders(headers) : [],
    contentType: contentType && contentType !== "application/octet-stream" ? contentType : undefined,
  };
}

/**
 * Validate that raw data meets requirements
 */
export function validateRawData(data: Buffer, maxSize: number): { valid: boolean; error?: string } {
  if (data.length === 0) {
    return { valid: false, error: "Data cannot be empty" };
  }

  if (data.length > maxSize) {
    return { valid: false, error: `Data size ${data.length} exceeds maximum of ${maxSize} bytes` };
  }

  return { valid: true };
}

/** Thrown by bufferRequestBodyWithLimit when a body exceeds the allowed size. */
export class RawBodyTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(
      `Request body exceeds the maximum allowed size of ${maxBytes} bytes`
    );
    this.name = "RawBodyTooLargeError";
  }
}

/**
 * Buffer a request body into memory, bounded by `maxBytes`.
 *
 * SECURITY: raw uploads must read the WHOLE body (to inspect / sign it), unlike
 * the streaming signed-data-item path. Without a bound, an unauthenticated
 * client could force unbounded allocation before any size/payment check. This
 * caps allocation two ways: it rejects by the declared Content-Length BEFORE
 * reading, and tracks the running size DURING reading — covering chunked or
 * Content-Length-lying requests — throwing RawBodyTooLargeError rather than
 * continuing to buffer.
 */
export async function bufferRequestBodyWithLimit(
  req: AsyncIterable<Buffer> & {
    headers?: Record<string, string | string[] | undefined>;
  },
  maxBytes: number
): Promise<Buffer> {
  const declared = Number(req.headers?.["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RawBodyTooLargeError(maxBytes);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new RawBodyTooLargeError(maxBytes);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
