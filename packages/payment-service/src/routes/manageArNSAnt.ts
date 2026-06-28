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

import { BadRequest, Unauthorized } from "../database/errors";
import { KoaContext } from "../server";
import { verifyArNSCustodySignature } from "../utils/arnsCustodySignature";
import { isValidArweaveBase64URL } from "../utils/base64";

function singleQueryParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// ArNS record bounds (validate at the edge so bad input is a 400, not a 503
// echoing a raw SDK/chain error). Tunable via env if the contract changes.
const MIN_TTL_SECONDS = Number(process.env.ARNS_MIN_TTL_SECONDS || "60");
const MAX_TTL_SECONDS = Number(process.env.ARNS_MAX_TTL_SECONDS || "86400");
const UNDERNAME_REGEX = /^(@|[a-zA-Z0-9_-]{1,61})$/;

function isValidUndername(undername: string): boolean {
  return UNDERNAME_REGEX.test(undername);
}

/**
 * Confirm the (already signature-authenticated) caller owns this ANT in Turbo
 * custody. "Not found" and "not yours" are treated identically (404) so we never
 * reveal an ANT owned by someone else. Returns false after writing the 404.
 */
async function authorizeAntOwnership(
  ctx: KoaContext,
  antId: string,
  owner: string,
): Promise<boolean> {
  const mapping = await ctx.state.paymentDatabase.getUserAnt(antId);
  if (!mapping || mapping.owner !== owner) {
    ctx.response.status = 404;
    ctx.body = "ANT not found in your Turbo custody";
    return false;
  }
  return true;
}

function handleManageError(ctx: KoaContext, error: unknown): void {
  const { logger } = ctx.state;
  if (
    error instanceof BadRequest ||
    (error instanceof Error && error.name === "BadRequest")
  ) {
    ctx.response.status = 400;
    ctx.body = error.message;
  } else if (error instanceof Unauthorized) {
    ctx.response.status = 401;
    ctx.body = error.message;
  } else {
    logger.error("Error managing ArNS ANT", error, {
      params: ctx.params,
      query: ctx.query,
    });
    ctx.response.status = 503;
    ctx.body = error instanceof Error ? error.message : "Internal server error";
  }
}

/**
 * Set a resolution record on a custodied ANT (custodial Model A: Turbo, the
 * owner, writes the record on the credit-authenticated user's behalf).
 * `undername` defaults to "@" (the base name record). v1 does not charge a
 * per-op fee — the on-chain write is gas-only and paid by the treasury.
 */
export async function setArNSRecord(ctx: KoaContext, next: Next) {
  const { gatewayMap } = ctx.state;
  const { ario } = gatewayMap;

  try {
    const antId = ctx.params.antId;
    if (!antId) {
      throw new BadRequest("Missing required parameter: antId");
    }

    const undername = singleQueryParam(ctx.query.undername) ?? "@";
    if (!isValidUndername(undername)) {
      throw new BadRequest(
        "Invalid undername: must be '@' or [a-zA-Z0-9_-] up to 61 chars",
      );
    }
    const transactionId = singleQueryParam(ctx.query.transactionId);
    if (!transactionId || !isValidArweaveBase64URL(transactionId)) {
      throw new BadRequest(
        "Invalid transactionId: must be an Arweave transaction id",
      );
    }
    // Bound the TTL to the ANT contract's accepted range so an out-of-range
    // value is rejected at the edge (a clean 400) instead of reaching the chain
    // and surfacing as an opaque 503.
    const ttlSeconds = Number(singleQueryParam(ctx.query.ttlSeconds));
    if (
      !Number.isInteger(ttlSeconds) ||
      ttlSeconds < MIN_TTL_SECONDS ||
      ttlSeconds > MAX_TTL_SECONDS
    ) {
      throw new BadRequest(
        `Invalid ttlSeconds: must be an integer between ${MIN_TTL_SECONDS} and ${MAX_TTL_SECONDS}`,
      );
    }

    // Verify the action-bound, single-use signature over the exact record op.
    const owner = await verifyArNSCustodySignature(ctx, {
      action: "set-record",
      antId,
      undername,
      transactionId,
      ttlSeconds,
    });
    if (!(await authorizeAntOwnership(ctx, antId, owner))) {
      return next();
    }

    const messageId = await ario.setAntRecord({
      antId,
      undername,
      transactionId,
      ttlSeconds,
    });

    ctx.response.status = 200;
    ctx.response.message = "ArNS Record Set";
    ctx.body = { antId, undername, transactionId, ttlSeconds, messageId };
  } catch (error) {
    handleManageError(ctx, error);
  }

  return next();
}

/** Remove a resolution record (an undername) from a custodied ANT. */
export async function removeArNSRecord(ctx: KoaContext, next: Next) {
  const { gatewayMap } = ctx.state;
  const { ario } = gatewayMap;

  try {
    const antId = ctx.params.antId;
    if (!antId) {
      throw new BadRequest("Missing required parameter: antId");
    }

    const undername = singleQueryParam(ctx.query.undername);
    if (!undername || !isValidUndername(undername)) {
      throw new BadRequest("Missing or invalid required parameter: undername");
    }

    const owner = await verifyArNSCustodySignature(ctx, {
      action: "remove-record",
      antId,
      undername,
    });
    if (!(await authorizeAntOwnership(ctx, antId, owner))) {
      return next();
    }

    const messageId = await ario.removeAntRecord({ antId, undername });

    ctx.response.status = 200;
    ctx.response.message = "ArNS Record Removed";
    ctx.body = { antId, undername, messageId };
  } catch (error) {
    handleManageError(ctx, error);
  }

  return next();
}
