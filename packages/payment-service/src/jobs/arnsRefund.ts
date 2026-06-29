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
import winston from "winston";

import { Database } from "../database/database";
import { ArNSPurchaseNotFound } from "../database/errors";

export interface ArNSRefundJobDeps {
  paymentDatabase: Database;
  logger: winston.Logger;
}

/**
 * Refund a debited-but-failed ArNS purchase. Idempotent: `updateFailedArNSPurchase`
 * only deletes a receipt that has NO message_id, so once the refund has happened
 * (or the purchase actually succeeded) the receipt is gone / protected and the DB
 * throws `ArNSPurchaseNotFound`. We treat that as a TERMINAL no-op — never an
 * error to retry — so a duplicate/stale refund job can't double-credit and can't
 * spin forever. Any other error is rethrown so BullMQ retries.
 */
export async function processArNSRefundJob(
  { paymentDatabase, logger }: ArNSRefundJobDeps,
  data: { nonce: string; reason: string },
): Promise<void> {
  const { nonce, reason } = data;
  try {
    await paymentDatabase.updateFailedArNSPurchase(nonce, reason);
    logger.info("Refunded failed ArNS purchase", { nonce, reason });
  } catch (error) {
    if (error instanceof ArNSPurchaseNotFound) {
      // Receipt already resolved: already refunded (failed-purchase row exists)
      // OR the purchase succeeded and recorded a message_id (protected by the
      // whereNull guard in updateFailedArNSPurchase). Either way: do not retry.
      logger.info("ArNS refund no-op — receipt already resolved", { nonce });
      return;
    }
    throw error;
  }
}

/**
 * Critical-path refund used by the request handler when the on-chain ArNS write
 * fails. Tries the refund inline; if the inline refund itself fails (DB/payment
 * hiccup), enqueues a durable retry so the buyer is ALWAYS credited back, even
 * through an extended outage. A last-resort enqueue failure is logged loudly for
 * manual intervention. `ArNSPurchaseNotFound` means the receipt is already
 * resolved — a no-op, not an error.
 */
export async function durableRefundArNSPurchase(
  { paymentDatabase, logger }: ArNSRefundJobDeps,
  enqueueRefund: (data: { nonce: string; reason: string }) => Promise<string>,
  nonce: string,
  reason: string,
): Promise<void> {
  try {
    await paymentDatabase.updateFailedArNSPurchase(nonce, reason);
    logger.info("Refunded failed ArNS purchase (inline)", { nonce, reason });
    return;
  } catch (error) {
    if (error instanceof ArNSPurchaseNotFound) {
      logger.info("ArNS inline refund no-op — receipt already resolved", {
        nonce,
      });
      return;
    }
    logger.error("Inline ArNS refund failed — enqueuing durable retry", {
      nonce,
      reason,
      error: error instanceof Error ? error.message : error,
    });
  }

  try {
    await enqueueRefund({ nonce, reason });
  } catch (enqueueError) {
    logger.error(
      "CRITICAL: failed to enqueue durable ArNS refund — manual credit required",
      {
        nonce,
        reason,
        error:
          enqueueError instanceof Error ? enqueueError.message : enqueueError,
      },
    );
  }
}

/**
 * Store the on-chain message_id for a purchase whose write SUCCEEDED but whose
 * message_id update failed. The name is already bought on-chain, so this must
 * NEVER refund — it just (durably) records the message_id. Rethrows on failure
 * so BullMQ retries.
 */
export async function processStoreArNSMessageIdJob(
  { paymentDatabase, logger }: ArNSRefundJobDeps,
  data: { nonce: string; messageId: string },
): Promise<void> {
  const { nonce, messageId } = data;
  await paymentDatabase.addMessageIdToPurchaseReceipt({ nonce, messageId });
  logger.info("Stored ArNS message_id (durable retry)", { nonce, messageId });
}

/**
 * Backstop reconciler: find debits stuck in `reserved`/`spawned` past the stale
 * threshold (the request died between the debit and confirming the buy). For
 * each, CONFIRM ON-CHAIN before acting — a name that actually landed is promoted
 * to `bought` (never refunded); only genuinely-unbought debits are refunded.
 */
export async function reconcileStaleArNSPurchases(
  { paymentDatabase, logger }: ArNSRefundJobDeps,
  enqueueRefund: (data: { nonce: string; reason: string }) => Promise<string>,
  staleThresholdMs: number,
  // Live on-chain confirm: the name's current ArNS record (undefined if
  // unregistered). The reconciler NEVER refunds without checking this first.
  confirmOnChain: (name: string) => Promise<{ antId?: string } | undefined>,
): Promise<{ refunded: number; confirmedBought: number }> {
  const stale =
    await paymentDatabase.getStalePendingArNSPurchases(staleThresholdMs);

  let refunded = 0;
  let confirmedBought = 0;

  for (const purchase of stale) {
    // If the name landed and resolves to the antId this receipt paid for, the
    // buy actually succeeded (we just never recorded it) → promote to `bought`,
    // do NOT refund.
    let record: { antId?: string } | undefined;
    try {
      record = await confirmOnChain(purchase.name);
    } catch (error) {
      // Fail SAFE: on a transient gateway error, never refund a possibly-bought
      // name. Skip; the next reconcile pass retries.
      logger.warn(
        "ArNS reconcile: on-chain confirm failed — skipping (no refund this pass)",
        {
          nonce: purchase.nonce,
          name: purchase.name,
          error: error instanceof Error ? error.message : error,
        },
      );
      continue;
    }

    if (record && purchase.processId && record.antId === purchase.processId) {
      await paymentDatabase.markArNSPurchaseBought(purchase.nonce);
      confirmedBought++;
      logger.warn(
        "ArNS reconcile: name confirmed on-chain — promoted to bought, NOT refunded",
        { nonce: purchase.nonce, name: purchase.name, antId: record.antId },
      );
      continue;
    }

    await enqueueRefund({
      nonce: purchase.nonce,
      reason: "RECONCILE_ORPHANED",
    });
    refunded++;
  }

  if (stale.length > 0) {
    logger.warn("Reconciled stale ArNS purchases", {
      stale: stale.length,
      refunded,
      confirmedBought,
      staleThresholdMs,
    });
  }

  return { refunded, confirmedBought };
}
