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
import { isValidSolanaAddress } from "../utils/base64";

/**
 * Self-custody exit (custodial Model A). A credit-authenticated owner moves a
 * Turbo-custodied ANT to a Solana pubkey they designate; Turbo (the on-chain
 * owner) signs the transfer. No escrow contract — just a cooperative transfer
 * gated by the same signature the user already uses.
 */
export async function transferArNSAnt(ctx: KoaContext, next: Next) {
  const { paymentDatabase, logger, gatewayMap } = ctx.state;
  const { ario } = gatewayMap;

  try {
    const owner = ctx.state.walletAddress;
    if (!owner || typeof owner !== "string") {
      throw new Unauthorized("Signed request is required for this route");
    }

    const processId = ctx.params.processId;
    if (!processId) {
      throw new BadRequest("Missing required parameter: processId");
    }

    const rawTarget = ctx.query.target;
    const target = Array.isArray(rawTarget) ? rawTarget[0] : rawTarget;
    if (!target || !isValidSolanaAddress(target)) {
      throw new BadRequest(
        "Missing or invalid target: must be a Solana address",
      );
    }

    // Authorize: the caller must own this ANT in Turbo custody. "Not found" and
    // "not yours" are treated identically (404) so we never reveal that an ANT
    // exists under another owner.
    const mapping = await paymentDatabase.getUserAnt(processId);
    if (!mapping || mapping.owner !== owner) {
      ctx.response.status = 404;
      ctx.body = "ANT not found in your Turbo custody";
      return next();
    }

    const messageId = await ario.transferAnt({ processId, target });

    // Transfer succeeded — the ANT left Turbo's control. Drop the custody
    // mapping (best-effort: a stale row only causes a later exit to fail on the
    // on-chain owner check, never a double-transfer).
    try {
      await paymentDatabase.deleteUserAnt(processId);
    } catch (deleteError) {
      logger.error(
        "ANT transferred but failed to remove custody mapping — stale row, manual cleanup may be needed",
        {
          processId,
          owner,
          error:
            deleteError instanceof Error ? deleteError.message : deleteError,
        },
      );
    }

    ctx.response.status = 200;
    ctx.response.message = "ArNS ANT Transferred";
    ctx.body = {
      processId,
      target,
      owner,
      name: mapping.name,
      messageId,
    };
  } catch (error) {
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
      logger.error("Error transferring ArNS ANT", error, {
        params: ctx.params,
        query: ctx.query,
      });
      ctx.response.status = 503;
      ctx.body =
        error instanceof Error ? error.message : "Internal server error";
    }
  }

  return next();
}
