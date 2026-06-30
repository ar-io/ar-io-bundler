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
import { ArNSPurchase } from "../database/dbTypes";
import { ArNSRecordSummary } from "../gateway/solana-ario";

export type ArNSConfirmParams = {
  intent: ArNSPurchase["intent"];
  name: string;
  // Buy-Name/Buy-Record: the antId the name must resolve to.
  antId?: string;
  // Extend-Lease / Increase-Undername-Limit: the on-chain value read BEFORE the
  // write, so "landed" = the value grew. Undefined ⇒ cannot confirm ⇒ not landed.
  beforeEndTimestamp?: ArNSRecordSummary["endTimestamp"];
  beforeUndernameLimit?: ArNSRecordSummary["undernameLimit"];
};

/**
 * Confirm whether an ArNS on-chain write actually landed, for use when the write
 * THREW — a Solana confirm/RPC timeout can throw AFTER the tx is on-chain. Each
 * intent has an idempotent on-chain check, so a thrown-but-landed write is
 * recognized as success (NOT refunded) while a genuinely-failed one is refunded:
 *   - Buy-Name / Buy-Record:      the name now resolves to our antId.
 *   - Upgrade-Name:               the record is now a permabuy.
 *   - Extend-Lease:               the lease endTimestamp grew past the pre-write value.
 *   - Increase-Undername-Limit:   the undernameLimit grew past the pre-write value.
 *
 * Reads are retried so a transient RPC error doesn't fail into a refund-of-a-
 * landed write. If EVERY read fails we return false (fail-safe): the refund path
 * runs, and for Buy-Name the reconciler re-confirms later. This is far narrower
 * than the prior behavior, which refunded EVERY thrown non-buy write regardless
 * of whether it landed.
 */
export async function confirmArNSWriteLanded(
  getArNSRecord: (name: string) => Promise<ArNSRecordSummary | undefined>,
  params: ArNSConfirmParams,
  { tries = 3, delayMs = 2000 }: { tries?: number; delayMs?: number } = {},
): Promise<boolean> {
  const { intent, name, antId, beforeEndTimestamp, beforeUndernameLimit } =
    params;

  const readRecord = async (): Promise<ArNSRecordSummary | undefined> => {
    let lastErr: unknown;
    for (let i = 0; i < tries; i++) {
      try {
        return await getArNSRecord(name);
      } catch (error) {
        lastErr = error;
        if (i < tries - 1) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    throw lastErr;
  };

  let record: ArNSRecordSummary | undefined;
  try {
    record = await readRecord();
  } catch {
    return false; // chain unreadable for the whole retry window — fail-safe
  }

  switch (intent) {
    case "Buy-Name":
    case "Buy-Record":
      return antId !== undefined && record?.antId === antId;
    case "Upgrade-Name":
      return record?.type === "permabuy";
    case "Extend-Lease":
      return (
        beforeEndTimestamp !== undefined &&
        record?.endTimestamp !== undefined &&
        Number(record.endTimestamp) > Number(beforeEndTimestamp)
      );
    case "Increase-Undername-Limit":
      return (
        beforeUndernameLimit !== undefined &&
        record?.undernameLimit !== undefined &&
        Number(record.undernameLimit) > Number(beforeUndernameLimit)
      );
    default:
      return false;
  }
}
