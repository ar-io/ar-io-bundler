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
import type { Server as HttpServer } from "node:http";

import Koa, { DefaultState, Next, ParameterizedContext } from "koa";
import bodyParser from "koa-bodyparser";
import jwt from "koa-jwt";
import Stripe from "stripe";
import { Logger } from "winston";

import { Architecture } from "./architecture";
import {
  defaultPort,
  isGiftingEnabled,
  migrateOnStartup,
  x402Networks,
} from "./constants";
import { BadRequest } from "./database/errors";
import { PostgresDatabase } from "./database/postgres";
import { MandrillEmailProvider } from "./emailProvider";
import {
  ArweaveGateway,
  EthereumGateway,
  GatewayMap,
  KyveGateway,
  MaticGateway,
  SolanaGateway,
} from "./gateway";
import { ARIOGateway } from "./gateway/ario";
import { BaseEthGateway } from "./gateway/base-eth";
import logger from "./logger";
import { MetricRegistry } from "./metricRegistry";
import { architectureMiddleware, loggerMiddleware } from "./middleware";
import {
  stripeWebhookRawBodyGuard,
  turboSdkJsonBodyFix,
} from "./middleware/bodyParsing";
import { TurboPricingService } from "./pricing/pricing";
import router from "./router";
import { JWKInterface } from "./types/jwkTypes";
import { resolveBodyParserLimits } from "./utils/bodyLimits";
import { loadSecretsToEnv } from "./utils/loadSecretsToEnv";
import { resolvePrivateRouteSecret } from "./utils/privateRouteSecret";
import { resolveServerTimeouts } from "./utils/serverTimeouts";
import { X402Service } from "./x402/x402Service";

type KoaState = DefaultState & Architecture & { logger: Logger };
export type KoaContext = ParameterizedContext<KoaState>;

logger.info(`Starting server with node environment ${process.env.NODE_ENV}...`);

process.on("uncaughtException", (error) => {
  MetricRegistry.uncaughtExceptionCounter.inc();
  logger.error("Uncaught exception:", error);
});

// NOTE: graceful SIGTERM/SIGINT shutdown (drain in-flight HTTP, then exit) is
// registered inside createServer() once the http server handle exists, so
// `pm2 reload` is drop-free. Do not add bare process.exit(0) handlers here —
// they would fire first and skip the drain.

// Registered-once graceful shutdown used by createServer(). On SIGTERM/SIGINT
// (pm2 cluster reload sends SIGINT to the OLD instance once the new one is
// listening) it stops accepting new connections, lets in-flight requests finish,
// then exits — so `pm2 reload` drops zero in-flight requests. Bounded by
// SHUTDOWN_DRAIN_MS (validated; default 4s; MUST stay under the 5s pm2
// kill_timeout or the OS SIGKILLs the drain mid-flight). The logger is flushed
// before exit so the final line is actually written (a bare process.exit() races
// winston's async file transport and silently drops it). Handlers are bound once
// even if createServer() is called repeatedly (e.g. in tests).
let drainServer: HttpServer | undefined;
let drainHandlersBound = false;
let draining = false;
function registerGracefulShutdown(server: HttpServer, log: Logger): void {
  drainServer = server; // always drain the latest server instance
  if (drainHandlersBound) return;
  drainHandlersBound = true;

  let finalizing = false;
  const finalize = (level: "info" | "warn", message: string) => {
    if (finalizing) return;
    finalizing = true;
    log[level](message);
    // Delay the hard exit briefly so this final line flushes through winston's
    // async Console transport (and, under pm2 cluster mode, the log IPC to the
    // pm2 daemon) before the event loop is torn down — a bare process.exit()
    // truncates it. Only the already-draining instance waits; the cluster peer
    // keeps serving, so there is no client impact.
    setTimeout(() => process.exit(0), 250);
  };

  const drainAndExit = (signal: string) => {
    if (draining) return;
    draining = true;
    const parsed = Number(process.env.SHUTDOWN_DRAIN_MS);
    const drainMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 4000;
    log.info(
      `${signal} received — draining HTTP connections (max ${drainMs}ms)...`
    );
    const force = setTimeout(
      () => finalize("warn", "Drain timeout exceeded — forcing exit."),
      drainMs
    );
    force.unref();
    drainServer?.close(() => {
      clearTimeout(force);
      finalize("info", "HTTP server closed — exiting cleanly.");
    });
    // Drop idle keep-alive sockets so server.close() can complete promptly.
    drainServer?.closeIdleConnections?.();
  };

  process.on("SIGTERM", () => drainAndExit("SIGTERM"));
  process.on("SIGINT", () => drainAndExit("SIGINT"));
}

export async function createServer(
  arch: Partial<Architecture>,
  port: number = defaultPort
) {
  const app = new Koa();

  await loadSecretsToEnv();
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const MANDRILL_API_KEY = process.env.MANDRILL_API_KEY;
  // SECURITY: fail closed if PRIVATE_ROUTE_SECRET is unset outside tests — never
  // authenticate protected routes with the public hard-coded test secret.
  const sharedSecret = resolvePrivateRouteSecret();

  if (!STRIPE_SECRET_KEY) {
    throw new Error("Stripe secret key or webhook secret not set");
  }

  // While draining (SIGTERM/SIGINT during a rolling reload) tell keepalive
  // clients (incl. the upload service's inter-service HTTP pool) to retire this
  // connection after the current response instead of reusing a socket we are
  // about to close — reduces ECONNRESET on the next pooled request.
  app.use(async (ctx: KoaContext, next: Next) => {
    if (draining) ctx.set("Connection", "close");
    await next();
  });

  // Outermost error handler: map domain errors that propagate out of a route
  // to proper HTTP status codes. Several routes (e.g. x402) validate input and
  // `throw new BadRequest(...)` BEFORE their own try/catch, so without this they
  // surfaced as Koa's default 500 instead of a 4xx. Routes that set ctx.status
  // explicitly or catch their own errors are unaffected — this only sees what
  // escapes them.
  app.use(async (ctx: KoaContext, next: Next) => {
    try {
      await next();
    } catch (error) {
      const httpStatus = (error as { status?: number; statusCode?: number })
        ?.status ?? (error as { statusCode?: number })?.statusCode;
      if (error instanceof BadRequest) {
        ctx.status = 400;
        ctx.body = { error: error.message };
      } else if (
        typeof httpStatus === "number" &&
        httpStatus >= 400 &&
        httpStatus < 500
      ) {
        // http-errors thrown by middleware carry a client-error status — e.g.
        // koa-bodyparser's 413 "request entity too large" when a body exceeds
        // the configured limit. Surface the real 4xx instead of masking it as a
        // generic 500 (which misreports a client mistake as a server fault and
        // pollutes the error log).
        ctx.status = httpStatus;
        ctx.body = {
          error: error instanceof Error ? error.message : "Request error",
        };
      } else {
        logger.error("Unhandled route error", {
          method: ctx.method,
          path: ctx.path,
          error: error instanceof Error ? error.message : String(error),
        });
        ctx.status = 500;
        ctx.body = { error: "Internal server error" };
      }
    }
  });

  app.use(loggerMiddleware);

  // Bug 3: reserve the Stripe webhook's raw body for signature verification.
  app.use(stripeWebhookRawBodyGuard());

  // CORS handled by nginx reverse proxy
  // app.use(cors({ allowMethods: ["GET", "POST"] }));

  // Request-body size limits — kept small to bound how much an unauthenticated
  // client can make the process buffer before JWT/route validation (see
  // resolveBodyParserLimits). Used by both the Content-Type fix middleware below
  // and the global body parser.
  const bodyLimits = resolveBodyParserLimits();

  // Bug 4: turbo-sdk posts JSON with a form-urlencoded or absent Content-Type;
  // sniff and populate ctx.request.body before bodyParser. (Skips the webhook.)
  app.use(turboSdkJsonBodyFix(bodyLimits));

  // Support both JSON and form-urlencoded request bodies. Limits intentionally
  // small (resolveBodyParserLimits) — bodyParser buffers the whole body in
  // memory before auth, so a large limit on these public, tiny-payload endpoints
  // is a pre-auth memory-amplification DoS vector.
  app.use(bodyParser({
    enableTypes: ['json', 'form', 'text'],
    formLimit: bodyLimits.formLimit,
    jsonLimit: bodyLimits.jsonLimit,
    textLimit: bodyLimits.textLimit,
  }));

  // NOTE: Middleware that use the JWT must handle ctx.state.user being undefined and throw
  // an error if the user is not authenticated
  app.use(jwt({ secret: sharedSecret, passthrough: true }));

  const pricingService = arch.pricingService ?? new TurboPricingService();
  const paymentDatabase =
    arch.paymentDatabase ?? new PostgresDatabase({ migrate: migrateOnStartup });
  const stripe =
    arch.stripe ?? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

  const jwk: JWKInterface =
    process.env.ARIO_SIGNING_JWK
      ? JSON.parse(process.env.ARIO_SIGNING_JWK)
      : undefined;

  const gatewayMap: GatewayMap = arch.gatewayMap ?? {
    arweave: new ArweaveGateway(),
    ario: new ARIOGateway({ jwk, logger }),
    ethereum: new EthereumGateway(),
    solana: new SolanaGateway(),
    ed25519: new SolanaGateway(),
    kyve: new KyveGateway(),
    matic: new MaticGateway(),
    pol: new MaticGateway(),
    "base-eth": new BaseEthGateway(),
  };

  const emailProvider = (() => {
    if (!isGiftingEnabled) {
      return undefined;
    }
    if (arch.emailProvider) {
      return arch.emailProvider;
    }
    if (!MANDRILL_API_KEY) {
      throw new Error(
        "MANDRILL_API_KEY environment variable is not set! Please set the key and restart the server or set GIFTING_ENABLED=false to disable gifting by email on top ups flow."
      );
    }
    return new MandrillEmailProvider(MANDRILL_API_KEY, logger);
  })();

  const x402Service = arch.x402Service ?? new X402Service(x402Networks);

  app.use((ctx: KoaContext, next: Next) =>
    architectureMiddleware(ctx, next, {
      pricingService,
      paymentDatabase,
      stripe,
      emailProvider,
      gatewayMap,
      x402Service,
    })
  );

  app.use(router.routes());

  // Bind address is env-driven: BIND_ADDRESS=127.0.0.1 keeps the API loopback-only
  // (co-located nginx proxies from localhost). Defaults to 0.0.0.0 for a separate-server nginx.
  const server = app.listen(port, process.env.BIND_ADDRESS || '0.0.0.0');

  // Timeout configuration for payment operations (faster than uploads). Uses
  // PAYMENT_-prefixed env vars so the payment service never inherits the upload
  // service's large generic timeout values from a shared .env file. All stay
  // short — headersTimeout in particular is a slowloris guard.
  const { requestTimeout, keepAliveTimeout, headersTimeout } =
    resolveServerTimeouts();

  // requestTimeout (not the legacy server.timeout) is the total request timeout;
  // server.timeout is retained as a socket-inactivity guard.
  server.requestTimeout = requestTimeout;
  server.timeout = requestTimeout;
  server.keepAliveTimeout = keepAliveTimeout;
  server.headersTimeout = headersTimeout;

  // Handle timeout events
  server.on('timeout', (socket) => {
    logger.warn('Server timeout - closing socket', {
      remoteAddress: socket.remoteAddress,
      remotePort: socket.remotePort,
    });
    socket.destroy();
  });

  server.on('clientError', (err, socket) => {
    logger.error('Client error', { error: err });
    if (!socket.destroyed) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
  });

  logger.info(`Listening on port ${port}...`);
  logger.info("Server timeout configuration", {
    requestTimeout,
    keepAliveTimeout,
    headersTimeout,
  });

  // Graceful drain on reload/shutdown (see registerGracefulShutdown above).
  registerGracefulShutdown(server, logger);

  return server;
}
