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

const DEFAULT_PUBLIC_URL = "http://localhost:3001";

/** Minimal structural view of the request — Koa's `ctx` satisfies this. */
export interface RequestHostCarrier {
  /** The request Host header value (Koa `ctx.host`). */
  host?: string;
}

/**
 * Resolve the canonical public base URL to advertise in x402 payment
 * requirements (the `resource` field), e.g. `https://upload.ardrive.io`.
 *
 * A single box can serve more than one public hostname (e.g. `upload.ardrive.io`
 * AND `upload.services.ar.io`), but an x402 quote carries only ONE `resource`.
 * So we echo the request's own hostname — but ONLY when it is in the
 * operator-configured allowlist `UPLOAD_SERVICE_PUBLIC_HOSTS` (comma-separated
 * hostnames). Any unknown or spoofed `Host` falls back to the canonical
 * `UPLOAD_SERVICE_PUBLIC_URL`. With the allowlist unset, behavior is unchanged:
 * always the canonical URL.
 *
 * The 402 quote and the settle/verify step build this from the same request, so
 * the `resource` stays consistent across the pair (required by the facilitator).
 *
 * Safe regardless of `Host`: the payment recipient (`payTo`) is bound to
 * `X402_PAYMENT_ADDRESS`, never to the host — so `resource` is metadata and can
 * never redirect funds.
 */
export function publicUrlForRequest(ctx: RequestHostCarrier): string {
  const fallback = process.env.UPLOAD_SERVICE_PUBLIC_URL || DEFAULT_PUBLIC_URL;

  const allowlist = (process.env.UPLOAD_SERVICE_PUBLIC_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);

  if (allowlist.length === 0) {
    return fallback;
  }

  // nginx forwards the public host via `proxy_set_header Host $host`, so
  // `ctx.host` is the client-facing hostname. Strip any port before matching.
  const hostname = (ctx.host ?? "").toLowerCase().split(":")[0];

  if (hostname.length > 0 && allowlist.includes(hostname)) {
    // Allowlisted public hosts are always served over HTTPS.
    return `https://${hostname}`;
  }

  return fallback;
}
