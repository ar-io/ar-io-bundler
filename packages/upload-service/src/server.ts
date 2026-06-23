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
// import cors from "@koa/cors"; // CORS handled by nginx
import Koa, { DefaultState, Next, ParameterizedContext } from "koa";

import { Architecture, defaultArchitecture } from "./arch/architecture";
import { OTELExporter } from "./arch/tracing";
import { port as defaultPort } from "./constants";
import globalLogger from "./logger";
import { MetricRegistry } from "./metricRegistry";
import {
  architectureMiddleware,
  loggerMiddleware,
  requestMiddleware,
} from "./middleware";
import router from "./router";
import { getErrorCodeFromErrorObject } from "./utils/common";
import { loadConfig } from "./utils/config";
import { resolveServerTimeouts } from "./utils/serverTimeouts";

type KoaState = DefaultState & Architecture;
export type KoaContext = ParameterizedContext<KoaState>;

globalLogger.info(
  `Starting server with node environment ${process.env.NODE_ENV}...`
);

// global error handler
process.on("uncaughtException", (error) => {
  // Determine error code for metrics
  const errorCode = getErrorCodeFromErrorObject(error);

  // Always increment the counter with appropriate error_code label
  MetricRegistry.uncaughtExceptionCounter.inc({ error_code: errorCode });

  globalLogger.error("Uncaught exception:", error);
});

/**
 * Validate required x402 environment variables
 */
function validateX402Config(): void {
  const x402PaymentAddress =
    process.env.X402_PAYMENT_ADDRESS ||
    process.env.ETHEREUM_ADDRESS ||
    process.env.BASE_ETH_ADDRESS;

  if (!x402PaymentAddress) {
    const errorMsg =
      "FATAL: x402 payment address not configured. Set X402_PAYMENT_ADDRESS (or legacy ETHEREUM_ADDRESS/BASE_ETH_ADDRESS) in .env file.";
    globalLogger.error(errorMsg);
    throw new Error(errorMsg);
  }

  globalLogger.info("x402 configuration validated", {
    x402PaymentAddress,
    uploadServicePublicUrl:
      process.env.UPLOAD_SERVICE_PUBLIC_URL || "http://localhost:3001",
    x402FeePercent: process.env.X402_FEE_PERCENT || "15",
  });
}

export async function createServer(
  arch: Partial<Architecture>,
  port: number = defaultPort
) {
  // load ssm parameters
  await loadConfig();

  // Validate x402 configuration
  validateX402Config();

  const app = new Koa();
  const uploadDatabase = arch.database ?? defaultArchitecture.database;
  const dataItemOffsetsDB =
    arch.dataItemOffsetsDB ?? defaultArchitecture.dataItemOffsetsDB;
  const objectStore = arch.objectStore ?? defaultArchitecture.objectStore;
  const paymentService =
    arch.paymentService ?? defaultArchitecture.paymentService;
  const x402Service = arch.x402Service ?? defaultArchitecture.x402Service;
  const cacheService = arch.cacheService ?? defaultArchitecture.cacheService;

  const getArweaveWallet =
    arch.getArweaveWallet ?? defaultArchitecture.getArweaveWallet;
  const getRawDataItemWallet =
    arch.getRawDataItemWallet ?? defaultArchitecture.getRawDataItemWallet;
  const arweaveGateway =
    arch.arweaveGateway ?? defaultArchitecture.arweaveGateway;
  const tracer =
    arch.tracer ??
    new OTELExporter({
      apiKey: process.env.HONEYCOMB_API_KEY,
    }).getTracer("upload-service");

  // attach logger to context including trace id
  app.use(loggerMiddleware);
  // attaches listeners related to request streams for debugging
  app.use(requestMiddleware);
  // CORS handled by nginx reverse proxy
  // app.use(cors({ credentials: true }));
  // attach our primary architecture
  app.use((ctx: KoaContext, next: Next) =>
    architectureMiddleware(ctx, next, {
      database: uploadDatabase,
      dataItemOffsetsDB,
      objectStore,
      cacheService,
      paymentService,
      x402Service,
      arweaveGateway,
      getArweaveWallet,
      getRawDataItemWallet,
      tracer,
    })
  );
  app.use(router.routes());
  // Bind to 0.0.0.0 to accept connections from nginx proxy on separate server
  const server = app.listen(port, '0.0.0.0');

  // Timeout configuration for large file uploads (up to 10 GiB). NOTE:
  // headersTimeout is kept SHORT — headers are tiny and a long header timeout is
  // a slowloris vector; only the request BODY needs the long requestTimeout.
  const { requestTimeout, keepAliveTimeout, headersTimeout } =
    resolveServerTimeouts();

  // requestTimeout (not the legacy server.timeout) is the total request timeout
  // covering headers + body; server.timeout is retained as a socket-inactivity
  // guard so stalled connections are reaped.
  server.requestTimeout = requestTimeout;
  server.timeout = requestTimeout;
  server.keepAliveTimeout = keepAliveTimeout;
  server.headersTimeout = headersTimeout;

  // Handle timeout events
  server.on('timeout', (socket) => {
    globalLogger.warn('Server timeout - closing socket', {
      remoteAddress: socket.remoteAddress,
      remotePort: socket.remotePort,
    });
    socket.destroy();
  });

  server.on('clientError', (err, socket) => {
    globalLogger.error('Client error', { error: err });
    if (!socket.destroyed) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
  });

  globalLogger.info(`Listening on port ${port}...`);
  globalLogger.info(
    `Communicating with payment service at ${paymentService.paymentServiceURL}...`
  );
  globalLogger.info("Server timeout configuration", {
    requestTimeout,
    keepAliveTimeout,
    headersTimeout,
  });
  return server;
}
