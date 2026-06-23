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

export interface ServerTimeouts {
  /** Total request time (headers + body). Generous for up-to-10 GiB uploads. */
  requestTimeout: number;
  /** Idle keep-alive socket timeout. */
  keepAliveTimeout: number;
  /** Time allowed to receive the COMPLETE request headers. */
  headersTimeout: number;
}

/** Parse a positive-integer env var, falling back to a safe default. */
function parsePositiveInt(
  raw: string | undefined,
  defaultValue: number
): number {
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : defaultValue;
}

/**
 * Hard ceiling on headersTimeout. Header parsing never legitimately needs more
 * than this; enforcing it keeps the slowloris guard FAIL-CLOSED even if a stale
 * or misconfigured env (e.g. a pre-existing HEADERS_TIMEOUT_MS=630000 left over
 * from before this fix) tries to set a long value.
 */
const MAX_HEADERS_TIMEOUT_MS = 60000;

/**
 * Resolve HTTP server timeouts for the upload service.
 *
 * SECURITY: headersTimeout must stay SHORT regardless of body size. Headers are
 * tiny and complete in well under a second; a long headersTimeout lets a
 * low-bandwidth client hold many connections open by dribbling incomplete
 * headers (slowloris). Large-body upload duration is governed by requestTimeout
 * (the total request timeout), NOT headersTimeout.
 *
 * These read the generic REQUEST_/KEEPALIVE_/HEADERS_TIMEOUT_MS vars (the
 * upload service's documented scale knobs). The payment service deliberately
 * uses PAYMENT_-prefixed vars so it never inherits these upload-sized values
 * from a shared .env file.
 */
export function resolveServerTimeouts(): ServerTimeouts {
  return {
    requestTimeout: parsePositiveInt(process.env.REQUEST_TIMEOUT_MS, 600000),
    keepAliveTimeout: parsePositiveInt(
      process.env.KEEPALIVE_TIMEOUT_MS,
      620000
    ),
    // Clamped to MAX_HEADERS_TIMEOUT_MS so an override can only make it shorter.
    headersTimeout: Math.min(
      parsePositiveInt(process.env.HEADERS_TIMEOUT_MS, MAX_HEADERS_TIMEOUT_MS),
      MAX_HEADERS_TIMEOUT_MS
    ),
  };
}
