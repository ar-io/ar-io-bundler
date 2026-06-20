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

import { x402FraudTolerancePercent } from "../constants";
import { DataItemId, X402PaymentStatus } from "../database/dbTypes";
import { BadRequest, X402PaymentError } from "../database/errors";
import { KoaContext } from "../server";
import { ByteCount } from "../types/byteCount";
import { W } from "../types/winston";

/**
 * Finalize an x402 payment after upload validation
 * POST /v1/x402/finalize
 */
export async function x402FinalizeRoute(ctx: KoaContext, next: Next) {
  const logger = ctx.state.logger;
  const { paymentDatabase } = ctx.state;

  const {
    dataItemId,
    actualByteCount: actualByteCountParam,
  } = (ctx.request as any).body as {
    dataItemId: string;
    actualByteCount: number;
  };

  // Validate parameters
  if (!dataItemId || !actualByteCountParam) {
    throw new X402PaymentError(
      "Missing dataItemId or actualByteCount"
    );
  }

  // A non-positive / non-integer byte count is invalid client input → typed
  // BadRequest (→ 400). Without this, ByteCount(-1) throws a generic error → 500.
  if (!Number.isInteger(actualByteCountParam) || actualByteCountParam <= 0) {
    throw new X402PaymentError("actualByteCount must be a positive integer");
  }

  const actualByteCount = ByteCount(actualByteCountParam);

  logger.info("Finalizing x402 payment", {
    dataItemId,
    actualByteCount,
  });

  try {
    // Get the payment
    const payment = await paymentDatabase.getX402PaymentByDataItemId(
      dataItemId as DataItemId
    );

    if (!payment) {
      ctx.status = 404;
      ctx.body = { error: "X402 payment not found for data item" };
      return next();
    }

    if (payment.status !== "pending_validation") {
      ctx.status = 400;
      ctx.body = {
        error: `Payment already finalized with status: ${payment.status}`,
      };
      return next();
    }

    const declaredByteCount = payment.declaredByteCount || ByteCount(0);
    const tolerancePercent = x402FraudTolerancePercent / 100;

    // Calculate tolerance bounds
    const lowerBound = declaredByteCount.valueOf() * (1 - tolerancePercent);
    const upperBound = declaredByteCount.valueOf() * (1 + tolerancePercent);

    let status: X402PaymentStatus;
    let refundWinc = W("0");

    // Fraud detection: actual > declared by more than tolerance
    if (actualByteCount.valueOf() > upperBound) {
      status = "fraud_penalty";
      logger.warn("X402 fraud detected - keeping payment as penalty", {
        dataItemId,
        declared: declaredByteCount,
        actual: actualByteCount,
        tolerance: tolerancePercent,
        userAddress: payment.userAddress,
      });
    }
    // Overpayment: actual < declared by more than tolerance
    else if (actualByteCount.valueOf() < lowerBound) {
      status = "refunded";

      // Calculate the actual cost based on actual bytes
      // TODO: Get actual pricing - for now, proportional refund
      const overpaymentRatio = 1 - actualByteCount.valueOf() / declaredByteCount.valueOf();
      refundWinc = W(
        Math.floor(Number(payment.wincAmount) * overpaymentRatio).toString()
      );

      logger.info("X402 overpayment detected - issuing refund", {
        dataItemId,
        declared: declaredByteCount,
        actual: actualByteCount,
        refundWinc,
      });
    }
    // Within tolerance
    else {
      status = "confirmed";
      logger.info("X402 payment confirmed - within tolerance", {
        dataItemId,
        declared: declaredByteCount,
        actual: actualByteCount,
      });
    }

    // Finalize the payment
    await paymentDatabase.finalizeX402Payment({
      dataItemId: dataItemId as DataItemId,
      actualByteCount,
      status,
      refundWinc: refundWinc.isGreaterThan(W(0)) ? refundWinc : undefined,
    });

    logger.info("X402 payment finalized", {
      dataItemId,
      status,
      actualByteCount,
      refundWinc,
    });

    ctx.status = 200;
    ctx.body = {
      success: true,
      status,
      actualByteCount,
      refundWinc: refundWinc.toString(),
    };
  } catch (error) {
    // Malformed/invalid finalize input (X402PaymentError extends BadRequest) is a
    // client error → 400, not 500.
    if (error instanceof BadRequest) {
      ctx.status = 400;
      ctx.body = { error: error.message };
    } else {
      logger.error("X402 payment finalization failed", { error });
      ctx.status = 500;
      ctx.body = {
        error: "Finalization failed",
        details: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  return next();
}
