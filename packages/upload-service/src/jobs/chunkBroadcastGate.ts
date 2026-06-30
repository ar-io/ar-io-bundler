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
import { Logger } from "winston";

import { Gateway } from "../arch/arweaveGateway";
import { TransactionId } from "../types/types";

/**
 * TX-confirmation gate for chunk broadcasting (defense-in-depth against the
 * data_root-propagation race).
 *
 * Background: `seed` stages a bundle's chunks and enqueues `broadcast-chunks`
 * ~0.38s after `post` puts the bundle TX header on a gateway. A chunk is only
 * accepted by a node that already knows the TX's `data_root`; if the chunk-quorum
 * nodes haven't received the TX yet (gossip lag / disjoint gateway node-sets),
 * they 400. The data still lands via retries, but it's noisy churn.
 *
 * This gate makes us immune to any gateway's peer-set behavior: before staging +
 * broadcasting a bundle's chunks, wait until the TX is confirmed network-wide
 * (mined → `data_root` universally known), then broadcast. It is implemented as a
 * BullMQ re-queue (the `seed-bundle` job re-delays itself), NOT a blocking sleep,
 * so it never ties up worker concurrency. The wait is HARD-CAPPED so a slow or
 * never-confirming TX still broadcasts (today's behavior) rather than stalling.
 *
 * Default-OFF: with `CHUNK_BROADCAST_TX_CONFIRM_GATE` unset/false the decision is
 * always `proceed`, so behavior is byte-for-byte the current immediate-seed path.
 */
export interface ChunkBroadcastGateConfig {
  /** Master switch. Default false (unchanged immediate-seed behavior). */
  enabled: boolean;
  /**
   * Block confirmations required to treat the TX as known network-wide. Default
   * 1 ("mined" — `GET /tx/<id>/status` returns 200). We poll `/status`, so a
   * value of 0 is still effectively "mined" (a 202/404 is never "found").
   */
  minConfirmations: number;
  /** Delay between confirmation polls. Default 5000ms. */
  pollMs: number;
  /** Hard cap on the total wait; broadcast anyway once exceeded. Default 600000ms (10 min). */
  maxMs: number;
}

function parseIntEnv(
  value: string | undefined,
  fallback: number,
  min: number
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, parsed);
}

export function getChunkBroadcastGateConfig(
  env: NodeJS.ProcessEnv = process.env
): ChunkBroadcastGateConfig {
  return {
    enabled: env.CHUNK_BROADCAST_TX_CONFIRM_GATE === "true",
    minConfirmations: parseIntEnv(
      env.CHUNK_BROADCAST_GATE_MIN_CONFIRMATIONS,
      1,
      0
    ),
    pollMs: parseIntEnv(env.CHUNK_BROADCAST_GATE_POLL_MS, 5000, 250),
    maxMs: parseIntEnv(env.CHUNK_BROADCAST_GATE_MAX_MS, 600000, 0),
  };
}

/**
 * Returns true iff the gateway reports the TX as found (mined) with at least
 * `minConfirmations` confirmations. A `pending`/`not found` status — or any
 * value below the threshold — is "not yet confirmed". Throws on transport
 * failure; `decideChunkBroadcastGate` treats a throw as "not confirmed" so a
 * transient gateway hiccup just keeps us waiting (bounded by the cap).
 */
export async function isTxConfirmed(
  gateway: Pick<Gateway, "getTransactionStatus">,
  transactionId: TransactionId,
  minConfirmations: number
): Promise<boolean> {
  const status = await gateway.getTransactionStatus(transactionId);
  if (status.status !== "found") {
    return false;
  }
  return status.transactionStatus.number_of_confirmations >= minConfirmations;
}

export type ChunkBroadcastGateDecision =
  | {
      action: "proceed";
      reason: "disabled" | "confirmed" | "cap_reached";
      /** The (possibly newly-established) cap deadline, for logging. */
      deadlineMs?: number;
    }
  | {
      action: "requeue";
      /** Delay before the next confirmation poll. */
      delayMs: number;
      /** Absolute cap deadline to carry forward in the re-enqueued job data. */
      deadlineMs: number;
    };

export interface DecideChunkBroadcastGateParams {
  transactionId: TransactionId;
  /** Cap deadline carried from a prior poll; undefined on first entry. */
  deadlineMs: number | undefined;
  /** Current wall-clock time (injected for testability). */
  nowMs: number;
  config: ChunkBroadcastGateConfig;
  /** Confirmation probe; should resolve true once the TX is known network-wide. */
  isConfirmed: () => Promise<boolean>;
  logger?: Logger;
}

/**
 * Pure-ish gate decision. The only side effect is the injected `isConfirmed`
 * probe; everything else is deterministic given (nowMs, deadlineMs, config), so
 * it is straightforward to unit-test the confirm / cap-fallback / re-queue paths.
 */
export async function decideChunkBroadcastGate({
  transactionId,
  deadlineMs,
  nowMs,
  config,
  isConfirmed,
  logger,
}: DecideChunkBroadcastGateParams): Promise<ChunkBroadcastGateDecision> {
  if (!config.enabled) {
    return { action: "proceed", reason: "disabled" };
  }

  // Establish (or carry forward) the hard cap so a slow/never-confirming TX can
  // never stall seeding indefinitely.
  const effectiveDeadline = deadlineMs ?? nowMs + config.maxMs;

  // The hard cap takes precedence over the probe: once we're at/past the
  // deadline we broadcast regardless, so DON'T issue a confirm call we'd ignore.
  // (This also guards a hung gateway from blocking past the cap, and makes
  // maxMs=0 a clean "proceed immediately" with no probe.)
  if (nowMs >= effectiveDeadline) {
    return {
      action: "proceed",
      reason: "cap_reached",
      deadlineMs: effectiveDeadline,
    };
  }

  let confirmed = false;
  try {
    confirmed = await isConfirmed();
  } catch (error) {
    // A transient gateway failure must not fail the seed job — treat it as
    // "not yet confirmed" and keep waiting (still bounded by the cap).
    logger?.warn(
      "chunk-broadcast gate: confirmation check failed; treating as unconfirmed",
      {
        transactionId,
        error: error instanceof Error ? error.message : "Unknown error",
      }
    );
    confirmed = false;
  }

  if (confirmed) {
    return {
      action: "proceed",
      reason: "confirmed",
      deadlineMs: effectiveDeadline,
    };
  }

  // Not confirmed and still within the cap: re-delay (never overshoot the cap).
  const remaining = effectiveDeadline - nowMs;
  const delayMs = Math.min(config.pollMs, remaining);
  return { action: "requeue", delayMs, deadlineMs: effectiveDeadline };
}
