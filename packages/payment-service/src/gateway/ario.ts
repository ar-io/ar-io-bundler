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
import { MessageResult, mARIOToken } from "@ar.io/sdk";
import winston from "winston";

import { GatewayParams } from ".";
import { ArNSPurchase, ArNSTokenCostParams } from "../database/dbTypes";
import { JWKInterface } from "../types/jwkTypes";
import { SolanaARIOGateway, SolanaARIOGatewayParams } from "./solana-ario";

export interface ARIOInterface {
  getTokenCost(p: ArNSTokenCostParams): Promise<mARIOToken>;
  // `spawnedAntId` is set only when the purchase provisioned a fresh,
  // Turbo-owned ANT (custodial Model A) because no antId was supplied.
  // `onAntSpawned` durably persists the antId BEFORE the on-chain buy.
  initiateArNSPurchase(
    p: ArNSPurchase & { onAntSpawned?: (antId: string) => Promise<void> },
  ): Promise<MessageResult & { spawnedAntId?: string }>;
  // Live on-chain ArNS record for a name (undefined if unregistered). Lets the
  // reconciler confirm a buy landed before refunding.
  getArNSRecord(name: string): Promise<{ antId?: string } | undefined>;
  // Self-custody exit: transfer a Turbo-owned ANT to a user-designated Solana
  // pubkey. Returns the on-chain message id.
  transferAnt(p: { antId: string; target: string }): Promise<string>;
  // Live on-chain owner of an ANT (undefined if unreadable). Lets the transfer
  // route confirm a "thrown-but-landed" transfer (the RPC failed on
  // confirmation but the tx actually landed) so it can reconcile custody
  // instead of stranding a stale user_ant row.
  getAntOwner(antId: string): Promise<string | undefined>;
  // Manage a custodied ANT's resolution records. Returns the on-chain message id.
  setAntRecord(p: {
    antId: string;
    undername: string;
    transactionId: string;
    ttlSeconds: number;
  }): Promise<string>;
  removeAntRecord(p: { antId: string; undername: string }): Promise<string>;
}

export type ARIOConstructorParams = GatewayParams &
  SolanaARIOGatewayParams & {
    jwk?: JWKInterface;
    processId?: string;
    logger?: winston.Logger;
    cuUrl?: string; // Custom URL for the AO Compute Unit
    arioLeaseNameDustAmount?: number;
    arioPermaBuyNameDustAmount?: number;
  };

export class ARIOGateway extends SolanaARIOGateway implements ARIOInterface {
  constructor({
    jwk: _jwk,
    processId: _processId,
    cuUrl: _cuUrl,
    arioLeaseNameDustAmount: _arioLeaseNameDustAmount,
    arioPermaBuyNameDustAmount: _arioPermaBuyNameDustAmount,
    ...gatewayParams
  }: ARIOConstructorParams = {}) {
    super(gatewayParams);
  }
}
