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
import { isValidSolanaAddress } from "../utils/base64";

/**
 * Self-custody exit (custodial Model A). A credit-authenticated owner moves a
 * Turbo-custodied ANT to a Solana pubkey they designate; Turbo (the on-chain
 * owner) signs the transfer. The request must carry an ACTION-BOUND, single-use
 * signature (over the antId + target), so a captured signature can't be replayed
 * to move the ANT elsewhere.
 */
export async function transferArNSAnt(ctx: KoaContext, next: Next) {
  const { paymentDatabase, logger, gatewayMap } = ctx.state;
  const { ario } = gatewayMap;

  try {
    const antId = ctx.params.antId;
    if (!antId) {
      throw new BadRequest("Missing required parameter: antId");
    }

    const rawTarget = ctx.query.target;
    const target = Array.isArray(rawTarget) ? rawTarget[0] : rawTarget;
    if (!target || !isValidSolanaAddress(target)) {
      throw new BadRequest(
        "Missing or invalid target: must be a Solana address",
      );
    }

    // Verify the action-bound, single-use signature over (antId, target).
    const owner = await verifyArNSCustodySignature(ctx, {
      action: "transfer",
      antId,
      target,
    });

    // Authorize: the caller must own this ANT in Turbo custody. "Not found" and
    // "not yours" are treated identically (404) so we never reveal that an ANT
    // exists under another owner.
    const mapping = await paymentDatabase.getUserAnt(antId);
    if (!mapping || mapping.owner !== owner) {
      ctx.response.status = 404;
      ctx.body = "ANT not found in your Turbo custody";
      return next();
    }

    // The on-chain transfer can be "thrown-but-landed": the tx confirms on-chain
    // but the RPC fails on the confirmation read (e.g. a 429). If we treated that
    // 503 as a plain failure, the custody mapping would be left behind even
    // though the ANT already moved — and a retry can NEVER clear it, because the
    // signer is no longer the owner (the chain returns NotCurrentOwner). So on a
    // transfer error, confirm the on-chain owner: if it is already the target,
    // the transfer DID land and we reconcile custody as success; otherwise it
    // genuinely failed and we surface the error (leaving the mapping for retry).
    let messageId: string | undefined;
    let confirmed = true;
    try {
      messageId = await ario.transferAnt({ antId, target });
    } catch (transferError) {
      const onChainOwner = await ario.getAntOwner(antId).catch(() => undefined);
      if (onChainOwner !== target) {
        throw transferError;
      }
      confirmed = false;
      logger.warn(
        "ArNS transfer RPC failed but the ANT is already owned by the target on-chain — reconciling custody (thrown-but-landed)",
        {
          antId,
          target,
          error:
            transferError instanceof Error
              ? transferError.message
              : transferError,
        },
      );
    }

    // Transfer succeeded (or was confirmed landed on-chain) — the ANT left
    // Turbo's control. Drop the custody mapping (best-effort: a stale row only
    // causes a later exit to fail on the on-chain owner check, never a
    // double-transfer).
    try {
      await paymentDatabase.deleteUserAnt(antId);
    } catch (deleteError) {
      logger.error(
        "ANT transferred but failed to remove custody mapping — stale row, manual cleanup may be needed",
        {
          antId,
          owner,
          error:
            deleteError instanceof Error ? deleteError.message : deleteError,
        },
      );
    }

    ctx.response.status = 200;
    ctx.response.message = "ArNS ANT Transferred";
    ctx.body = {
      antId,
      target,
      owner,
      name: mapping.name,
      // null when the transfer landed on-chain but the confirming RPC call
      // failed, so no message id was returned. `confirmed: false` flags that.
      messageId: messageId ?? null,
      confirmed,
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
