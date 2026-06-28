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
import { isValidArweaveBase64URL } from "../utils/base64";

function singleQueryParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Shared auth for ANT-management routes: require a signed request, then confirm
 * the caller owns this ANT in Turbo custody. "Not found" and "not yours" are
 * treated identically (404) so we never reveal an ANT owned by someone else.
 * Returns the authorized owner, or undefined after writing the 401/404 response.
 */
async function authorizeAntManagement(
  ctx: KoaContext,
  processId: string,
): Promise<string | undefined> {
  const owner = ctx.state.walletAddress;
  if (!owner || typeof owner !== "string") {
    throw new Unauthorized("Signed request is required for this route");
  }

  const mapping = await ctx.state.paymentDatabase.getUserAnt(processId);
  if (!mapping || mapping.owner !== owner) {
    ctx.response.status = 404;
    ctx.body = "ANT not found in your Turbo custody";
    return undefined;
  }
  return owner;
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
    const processId = ctx.params.processId;
    if (!processId) {
      throw new BadRequest("Missing required parameter: processId");
    }

    const undername = singleQueryParam(ctx.query.undername) ?? "@";
    const transactionId = singleQueryParam(ctx.query.transactionId);
    if (!transactionId || !isValidArweaveBase64URL(transactionId)) {
      throw new BadRequest(
        "Invalid transactionId: must be an Arweave transaction id",
      );
    }
    const ttlSeconds = Number(singleQueryParam(ctx.query.ttlSeconds));
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new BadRequest("Invalid ttlSeconds: must be a positive integer");
    }

    const owner = await authorizeAntManagement(ctx, processId);
    if (owner === undefined) {
      return next();
    }

    const messageId = await ario.setAntRecord({
      processId,
      undername,
      transactionId,
      ttlSeconds,
    });

    ctx.response.status = 200;
    ctx.response.message = "ArNS Record Set";
    ctx.body = { processId, undername, transactionId, ttlSeconds, messageId };
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
    const processId = ctx.params.processId;
    if (!processId) {
      throw new BadRequest("Missing required parameter: processId");
    }

    const undername = singleQueryParam(ctx.query.undername);
    if (!undername) {
      throw new BadRequest("Missing required parameter: undername");
    }

    const owner = await authorizeAntManagement(ctx, processId);
    if (owner === undefined) {
      return next();
    }

    const messageId = await ario.removeAntRecord({ processId, undername });

    ctx.response.status = 200;
    ctx.response.message = "ArNS Record Removed";
    ctx.body = { processId, undername, messageId };
  } catch (error) {
    handleManageError(ctx, error);
  }

  return next();
}
