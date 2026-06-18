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
  initiateArNSPurchase(p: ArNSPurchase): Promise<MessageResult>;
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
