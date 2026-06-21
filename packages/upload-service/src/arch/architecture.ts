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
import { JWKInterface } from "@dha-team/arbundles";
import { Tracer } from "@opentelemetry/api";
import knex from "knex";
import winston from "winston";

import { migrateOnStartup } from "../constants";
import globalLogger from "../logger";
import { getArweaveWallet, getRawDataItemWallet } from "../utils/getArweaveWallet";
import { getS3ObjectStore } from "../utils/objectStoreUtils";
import { ArweaveGateway, MultiGatewayArweaveGateway } from "./arweaveGateway";
import { CacheService } from "./cacheServiceTypes";
import { Database } from "./db/database";
import { DataItemOffsetsDB } from "./db/dataItemOffsets";
import { getReaderConfig, getWriterConfig } from "./db/knexConfig";
import { PostgresDatabase } from "./db/postgres";
import { getElasticacheService } from "./elasticacheService";
import { ObjectStore } from "./objectStore";
import { PaymentService, TurboPaymentService } from "./payment";
import { X402Service, x402Networks } from "./x402Service";

export interface Architecture {
  objectStore: ObjectStore;
  database: Database;
  dataItemOffsetsDB: DataItemOffsetsDB;
  cacheService: CacheService;
  paymentService: PaymentService;
  x402Service: X402Service;
  logger: winston.Logger;
  arweaveGateway: ArweaveGateway;
  getArweaveWallet: () => Promise<JWKInterface>;
  getRawDataItemWallet: () => Promise<JWKInterface>;
  tracer?: Tracer;
}

const writerKnex = knex(getWriterConfig());

export const defaultArchitecture: Architecture = {
  database: new PostgresDatabase({
    migrate: migrateOnStartup,
    writer: writerKnex,
    reader: knex(getReaderConfig()),
  }),
  dataItemOffsetsDB: new DataItemOffsetsDB(writerKnex, globalLogger),
  objectStore: getS3ObjectStore(),
  cacheService: getElasticacheService(),
  paymentService: new TurboPaymentService(),
  x402Service: new X402Service(x402Networks),
  logger: globalLogger,
  getArweaveWallet: () => getArweaveWallet(),
  getRawDataItemWallet: () => getRawDataItemWallet(),
  // Multi-gateway by default: redundant core reads + tx-header POST across the
  // `ARWEAVE_GATEWAYS` list. With that env unset the list is just [ARWEAVE_GATEWAY],
  // so this behaves exactly like a single ArweaveGateway.
  arweaveGateway: new MultiGatewayArweaveGateway(),
};
