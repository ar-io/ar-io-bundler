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

import { ArNSPurchase } from "../database/dbTypes";
import {
  BadRequest,
  InsufficientBalance,
  Unauthorized,
  UserNotFoundWarning,
} from "../database/errors";
import { ArNSRecordSummary } from "../gateway/solana-ario";
import { durableRefundArNSPurchase } from "../jobs/arnsRefund";
import {
  enqueueArNSRefund,
  enqueueStoreArNSMessageId,
} from "../queues/producers";
import { KoaContext } from "../server";
import { W } from "../types";
import { confirmArNSWriteLanded } from "../utils/confirmArNSWriteLanded";
import {
  getSanitizedReferer,
  getValidatedArNSPurchaseParams,
} from "../utils/validators";

export async function initiateArNSPurchase(ctx: KoaContext, next: Next) {
  const { paymentDatabase, logger, gatewayMap, pricingService } = ctx.state;
  const { ario } = gatewayMap;

  let purchaseReceipt: ArNSPurchase | undefined = undefined;
  try {
    const {
      intent,
      name,
      increaseQty,
      type,
      years,
      nonce,
      owner,
      processId,
      paidBy,
    } = getValidatedArNSPurchaseParams(ctx);

    const mARIOQty = await ario.getTokenCost({
      name,
      increaseQty,
      type,
      years,
      intent,
      assertBalance: true,
    });

    const { finalPrice } = await pricingService.getWCForCryptoPayment({
      amount: W(mARIOQty.valueOf()),
      token: "ario",
      // Just a quote for WC to use, don't include fees
      feeMode: "none",
    });
    const { usdArRate, usdArioRate } =
      await pricingService.getUSDPriceForOneARAndOneARIO();

    // Custodial Model A: a Buy without a caller-supplied processId provisions a
    // fresh, Turbo-owned ANT (the treasury pays its SOL rent). Recover that cost
    // from the buyer via a configurable winc surcharge (ANT_SPAWN_WINC_SURCHARGE,
    // default "0" = disabled). It is folded into the single existing debit, so
    // the S1 durable refund covers it on failure.
    const provisionsAnt =
      (intent === "Buy-Name" || intent === "Buy-Record") &&
      processId === undefined;
    const wincQty = provisionsAnt
      ? finalPrice.winc.plus(W(process.env.ANT_SPAWN_WINC_SURCHARGE || "0"))
      : finalPrice.winc;

    purchaseReceipt = await paymentDatabase.createArNSPurchaseReceipt({
      name,
      nonce,
      intent,
      mARIOQty,
      owner,
      wincQty,
      processId,
      increaseQty,
      type,
      years,
      usdArRate,
      usdArioRate,
      paidBy,
      referer: getSanitizedReferer(ctx),
    });

    // For Extend-Lease / Increase-Undername-Limit there is no antId to match on,
    // so capture the current on-chain value BEFORE the write — a thrown-but-landed
    // write is then confirmed by the value having GROWN (endTimestamp /
    // undernameLimit). Read fresh (getArNSRecord bypasses the price-check cache).
    let beforeEndTimestamp: ArNSRecordSummary["endTimestamp"];
    let beforeUndernameLimit: ArNSRecordSummary["undernameLimit"];
    if (intent === "Extend-Lease" || intent === "Increase-Undername-Limit") {
      const beforeRecord = await ario.getArNSRecord(name).catch(() => undefined);
      beforeEndTimestamp = beforeRecord?.endTimestamp;
      beforeUndernameLimit = beforeRecord?.undernameLimit;
    }

    // The buyer's credits are now debited. The on-chain write is the point of
    // no return: if it FAILS, the name was not bought → refund durably. If it
    // SUCCEEDS, the name is paid for on-chain → we must NEVER refund, even if a
    // later step (recording the message_id) fails.
    let arioWriteResult: Awaited<ReturnType<typeof ario.initiateArNSPurchase>>;
    // Captured so a thrown-but-landed buy can be confirmed on-chain below.
    let spawnedAntId: string | undefined;
    try {
      arioWriteResult = await ario.initiateArNSPurchase({
        ...purchaseReceipt,
        // Durably record the spawned antId on the receipt BEFORE the on-chain
        // buy, so a crash/failed buy can never lose it (reclaimable orphan +
        // rebuildable mapping). status: reserved → spawned.
        onAntSpawned: (antId) => {
          spawnedAntId = antId;
          return paymentDatabase.persistSpawnedAntId(nonce, antId);
        },
      });
    } catch (writeError) {
      // The write THREW — but a Solana confirm/RPC timeout can throw AFTER the tx
      // actually landed. Before refunding, confirm the op's effect on-chain
      // (idempotent, per-intent): Buy → name resolves to our antId; Upgrade → now
      // permabuy; Extend → endTimestamp grew; Increase → undernameLimit grew. If
      // it LANDED, mark `bought` and do NOT refund (the client can poll status);
      // otherwise refund durably. This closes the thrown-but-landed gap for the
      // non-buy intents, which previously always refunded a landed write.
      const antId = processId ?? spawnedAntId;
      const landed = await confirmArNSWriteLanded(
        (recordName) => ario.getArNSRecord(recordName),
        { intent, name, antId, beforeEndTimestamp, beforeUndernameLimit },
      );
      if (landed) {
        await paymentDatabase.markArNSPurchaseBought(nonce).catch((markError) =>
          logger.error(
            "ArNS write threw but op LANDED on-chain; failed to mark bought — on-chain reconcile is the backstop",
            {
              nonce,
              error: markError instanceof Error ? markError.message : markError,
            },
          ),
        );
        logger.warn(
          "ArNS write threw but the op LANDED on-chain — marked bought, NOT refunded (client can poll status)",
          { nonce, name, intent, antId },
        );
      } else {
        await durableRefundArNSPurchase(
          { paymentDatabase, logger },
          enqueueArNSRefund,
          nonce,
          "PURCHASE_FAILED",
        );
      }
      throw writeError;
    }

    // The buy is confirmed on-chain — mark it `bought` BEFORE recording the
    // message_id, so the refund/reconcile guard protects this paid name even if
    // message_id storage later fails. If this mark itself fails, the on-chain
    // reconcile (getArNSRecord) is the backstop against an erroneous refund.
    try {
      await paymentDatabase.markArNSPurchaseBought(purchaseReceipt.nonce);
    } catch (markError) {
      logger.error(
        "ArNS buy confirmed on-chain but failed to mark receipt 'bought' — on-chain reconcile must prevent an erroneous refund",
        {
          nonce: purchaseReceipt.nonce,
          error: markError instanceof Error ? markError.message : markError,
        },
      );
    }

    // Custodial Model A: if a fresh Turbo-owned ANT was provisioned, record the
    // user↔ANT mapping. Best-effort and genuinely safe to be so now: the antId
    // was already persisted on the receipt before the buy (onAntSpawned), so a
    // failure here only misses the convenience index — it can be rebuilt from
    // the receipt (owner + name + antId), never permanently lost.
    if (arioWriteResult.spawnedAntId !== undefined) {
      try {
        await paymentDatabase.recordSpawnedAnt({
          nonce: purchaseReceipt.nonce,
          owner: purchaseReceipt.owner,
          processId: arioWriteResult.spawnedAntId,
          name: purchaseReceipt.name,
        });
      } catch (mappingError) {
        logger.error(
          "ArNS name bought + ANT spawned but failed to record user↔ANT mapping index — rebuildable from the receipt's antId",
          {
            nonce: purchaseReceipt.nonce,
            owner: purchaseReceipt.owner,
            antId: arioWriteResult.spawnedAntId,
            name: purchaseReceipt.name,
            error:
              mappingError instanceof Error
                ? mappingError.message
                : mappingError,
          },
        );
      }
    }

    // Write succeeded — name is bought. Recording the message_id must not refund;
    // on failure, durably retry storing it (the reconciler would otherwise treat
    // this paid-for receipt as an orphan).
    try {
      await paymentDatabase.addMessageIdToPurchaseReceipt({
        messageId: arioWriteResult.id,
        nonce: purchaseReceipt.nonce,
      });
    } catch (storeError) {
      logger.error(
        "ArNS write succeeded but storing message_id failed — enqueuing durable retry (NOT refunding)",
        {
          nonce: purchaseReceipt.nonce,
          messageId: arioWriteResult.id,
          error: storeError instanceof Error ? storeError.message : storeError,
        },
      );
      await enqueueStoreArNSMessageId({
        nonce: purchaseReceipt.nonce,
        messageId: arioWriteResult.id,
      }).catch((enqueueError) => {
        logger.error(
          "CRITICAL: failed to enqueue ArNS store-message-id retry — receipt risks being reconciled despite a paid name; manual check required",
          {
            nonce: purchaseReceipt?.nonce,
            messageId: arioWriteResult.id,
            error:
              enqueueError instanceof Error
                ? enqueueError.message
                : enqueueError,
          },
        );
      });
    }

    ctx.response.status = 200;
    ctx.response.message = "ArNS Purchase Successful";

    ctx.body = {
      purchaseReceipt: {
        ...purchaseReceipt,
        messageId: arioWriteResult.id,
        // The antId this name resolves to — the provisioned one (if spawned) or
        // the buyer-supplied (BYO) one.
        antId: arioWriteResult.spawnedAntId ?? purchaseReceipt.processId,
      },
      arioWriteResult,
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
    } else if (
      error instanceof InsufficientBalance ||
      error instanceof UserNotFoundWarning
    ) {
      ctx.response.status = 402;
      ctx.body = error.message;
    } else {
      logger.error("Error initiating ArNS Purchase", error, {
        query: ctx.query,
        params: ctx.params,
      });
      ctx.response.status = 503;
      ctx.body =
        error instanceof Error ? error.message : "Internal server error";
    }

    // NOTE: the refund is NOT issued here. A debited purchase is refunded
    // durably on the on-chain-write failure path above (durableRefundArNSPurchase
    // → inline refund, else the arns-refund queue). Errors that reach here
    // before the debit (validation / pricing / insufficient balance) created no
    // receipt, so there is nothing to refund. Issuing a refund here too would
    // risk double-handling a receipt already refunded on the write path.
  }

  return next();
}
