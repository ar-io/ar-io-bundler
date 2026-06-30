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
import { expect } from "chai";
import winston from "winston";

import { Gateway } from "../arch/arweaveGateway";
import { TransactionStatus } from "../types/txStatus";
import {
  ChunkBroadcastGateConfig,
  decideChunkBroadcastGate,
  getChunkBroadcastGateConfig,
  isTxConfirmed,
} from "./chunkBroadcastGate";

const silentLogger = winston.createLogger({
  silent: true,
  transports: [new winston.transports.Console()],
});

const enabledConfig = (
  overrides: Partial<ChunkBroadcastGateConfig> = {}
): ChunkBroadcastGateConfig => ({
  enabled: true,
  minConfirmations: 1,
  pollMs: 5000,
  maxMs: 600000,
  ...overrides,
});

const gatewayWithStatus = (
  status: TransactionStatus
): Pick<Gateway, "getTransactionStatus"> => ({
  getTransactionStatus: async () => status,
});

describe("getChunkBroadcastGateConfig", () => {
  it("defaults to OFF with sane poll/cap when env is unset", () => {
    const config = getChunkBroadcastGateConfig({} as NodeJS.ProcessEnv);
    expect(config.enabled).to.equal(false);
    expect(config.minConfirmations).to.equal(1);
    expect(config.pollMs).to.equal(5000);
    expect(config.maxMs).to.equal(600000);
  });

  it("enables only on the exact string 'true' and parses overrides", () => {
    const config = getChunkBroadcastGateConfig({
      CHUNK_BROADCAST_TX_CONFIRM_GATE: "true",
      CHUNK_BROADCAST_GATE_MIN_CONFIRMATIONS: "3",
      CHUNK_BROADCAST_GATE_POLL_MS: "1000",
      CHUNK_BROADCAST_GATE_MAX_MS: "120000",
    } as unknown as NodeJS.ProcessEnv);
    expect(config.enabled).to.equal(true);
    expect(config.minConfirmations).to.equal(3);
    expect(config.pollMs).to.equal(1000);
    expect(config.maxMs).to.equal(120000);
  });

  it("does not enable on truthy-but-not-'true' values", () => {
    expect(
      getChunkBroadcastGateConfig({
        CHUNK_BROADCAST_TX_CONFIRM_GATE: "1",
      } as unknown as NodeJS.ProcessEnv).enabled
    ).to.equal(false);
  });

  it("floors poll interval and clamps bad numbers to defaults", () => {
    const config = getChunkBroadcastGateConfig({
      CHUNK_BROADCAST_GATE_POLL_MS: "10", // below the 250ms floor
      CHUNK_BROADCAST_GATE_MAX_MS: "not-a-number",
    } as unknown as NodeJS.ProcessEnv);
    expect(config.pollMs).to.equal(250);
    expect(config.maxMs).to.equal(600000);
  });
});

describe("isTxConfirmed", () => {
  it("is true when the TX is found with enough confirmations", async () => {
    const gateway = gatewayWithStatus({
      status: "found",
      transactionStatus: {
        block_height: 100,
        block_indep_hash: "hash",
        number_of_confirmations: 1,
      },
    });
    expect(await isTxConfirmed(gateway, "tx-id", 1)).to.equal(true);
  });

  it("is false when found but below the confirmation threshold", async () => {
    const gateway = gatewayWithStatus({
      status: "found",
      transactionStatus: {
        block_height: 100,
        block_indep_hash: "hash",
        number_of_confirmations: 2,
      },
    });
    expect(await isTxConfirmed(gateway, "tx-id", 5)).to.equal(false);
  });

  it("is false when pending or not found", async () => {
    expect(
      await isTxConfirmed(gatewayWithStatus({ status: "pending" }), "tx", 1)
    ).to.equal(false);
    expect(
      await isTxConfirmed(gatewayWithStatus({ status: "not found" }), "tx", 1)
    ).to.equal(false);
  });
});

describe("decideChunkBroadcastGate", () => {
  const baseParams = {
    transactionId: "tx-id",
    nowMs: 1_000_000,
    logger: silentLogger,
  };

  it("proceeds immediately (disabled) without probing when the gate is off", async () => {
    let probed = false;
    const decision = await decideChunkBroadcastGate({
      ...baseParams,
      deadlineMs: undefined,
      config: enabledConfig({ enabled: false }),
      isConfirmed: async () => {
        probed = true;
        return false;
      },
    });
    expect(decision).to.deep.equal({ action: "proceed", reason: "disabled" });
    expect(probed, "must not probe when disabled").to.equal(false);
  });

  it("proceeds (confirmed) once the TX is confirmed", async () => {
    const decision = await decideChunkBroadcastGate({
      ...baseParams,
      deadlineMs: undefined,
      config: enabledConfig(),
      isConfirmed: async () => true,
    });
    expect(decision.action).to.equal("proceed");
    if (decision.action === "proceed") {
      expect(decision.reason).to.equal("confirmed");
    }
  });

  it("requeues with the poll delay and a fresh cap deadline when unconfirmed", async () => {
    const decision = await decideChunkBroadcastGate({
      ...baseParams,
      deadlineMs: undefined,
      config: enabledConfig({ pollMs: 5000, maxMs: 600000 }),
      isConfirmed: async () => false,
    });
    expect(decision.action).to.equal("requeue");
    if (decision.action === "requeue") {
      expect(decision.delayMs).to.equal(5000);
      // deadline established as now + maxMs and carried forward
      expect(decision.deadlineMs).to.equal(baseParams.nowMs + 600000);
    }
  });

  it("carries an existing deadline forward across polls", async () => {
    const existingDeadline = baseParams.nowMs + 120000;
    const decision = await decideChunkBroadcastGate({
      ...baseParams,
      deadlineMs: existingDeadline,
      config: enabledConfig(),
      isConfirmed: async () => false,
    });
    expect(decision.action).to.equal("requeue");
    if (decision.action === "requeue") {
      expect(decision.deadlineMs).to.equal(existingDeadline);
    }
  });

  it("never overshoots the cap: the final poll delay shrinks to the remaining time", async () => {
    // 2s left before the deadline, poll interval is 5s → delay should clamp to 2s.
    const decision = await decideChunkBroadcastGate({
      ...baseParams,
      deadlineMs: baseParams.nowMs + 2000,
      config: enabledConfig({ pollMs: 5000 }),
      isConfirmed: async () => false,
    });
    expect(decision.action).to.equal("requeue");
    if (decision.action === "requeue") {
      expect(decision.delayMs).to.equal(2000);
    }
  });

  it("proceeds (cap_reached) once the deadline has passed, even if never confirmed", async () => {
    const decision = await decideChunkBroadcastGate({
      ...baseParams,
      deadlineMs: baseParams.nowMs - 1, // already past the cap
      config: enabledConfig(),
      isConfirmed: async () => false,
    });
    expect(decision.action).to.equal("proceed");
    if (decision.action === "proceed") {
      expect(decision.reason).to.equal("cap_reached");
    }
  });

  it("treats a probe failure as unconfirmed (keeps waiting, never throws)", async () => {
    const decision = await decideChunkBroadcastGate({
      ...baseParams,
      deadlineMs: undefined,
      config: enabledConfig(),
      isConfirmed: async () => {
        throw new Error("gateway unreachable");
      },
    });
    expect(decision.action).to.equal("requeue");
  });

  it("still broadcasts at the cap even if the probe keeps throwing", async () => {
    const decision = await decideChunkBroadcastGate({
      ...baseParams,
      deadlineMs: baseParams.nowMs - 1,
      config: enabledConfig(),
      isConfirmed: async () => {
        throw new Error("gateway unreachable");
      },
    });
    expect(decision.action).to.equal("proceed");
    if (decision.action === "proceed") {
      expect(decision.reason).to.equal("cap_reached");
    }
  });
});
