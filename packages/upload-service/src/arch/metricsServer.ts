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
import * as http from "node:http";
import * as promClient from "prom-client";

import logger from "../logger";
import { MetricRegistry } from "../metricRegistry";

let serverStarted = false;

/**
 * Start a dedicated HTTP server that exposes THIS process's prom-client registry
 * for Prometheus scraping, on `basePort + NODE_APP_INSTANCE`.
 *
 * Why a separate per-process server (vs. only the Koa `/bundler_metrics` route):
 *  - **upload-workers** (the BullMQ bundle pipeline) increments most of the
 *    interesting metrics — `fulfillment_job_*`, `archive_copy_total`,
 *    `chunk_seed_post_total`, `posted_bundle_*` — but, as a fork process, it
 *    exposed none of them over HTTP. The Koa route lives only in the API process,
 *    whose registry reports those worker counters as 0.
 *  - **upload-api** runs in PM2 CLUSTER mode (N instances behind one `:3001`
 *    load balancer), so a scrape of `:3001/bundler_metrics` lands on a random
 *    instance and flip-flops. prom-client's `AggregatorRegistry` cannot aggregate
 *    here because under PM2 the cluster *primary* is the PM2 daemon, not our code,
 *    so there is no process of ours to call `clusterMetrics()`. Instead each
 *    instance exposes its own port (`basePort + NODE_APP_INSTANCE`, which PM2 sets
 *    to 0..N-1) and Prometheus `sum()`s the per-instance series. That summation is
 *    the cluster-aggregation layer.
 *
 * Disabled with `METRICS_SERVER_ENABLED=false`; never binds under `NODE_ENV=test`.
 */
export function startMetricsServer(opts: {
  basePort: number;
  name: string;
}): void {
  if (process.env.METRICS_SERVER_ENABLED === "false") return;
  if (process.env.NODE_ENV === "test") return;
  if (serverStarted) return;
  serverStarted = true;

  const instance =
    Number.parseInt(process.env.NODE_APP_INSTANCE ?? "0", 10) || 0;
  const port = opts.basePort + instance;
  const bindAddress = process.env.METRICS_BIND_ADDRESS || "0.0.0.0";
  const registry = MetricRegistry.getInstance().getRegistry();

  // Node/process default metrics. Idempotent on purpose: in the API process the
  // Koa router already calls collectDefaultMetrics() on this same registry, so a
  // second call throws "already registered" and is safely ignored. In the workers
  // process nothing else collects them, so this is where they get registered.
  try {
    promClient.collectDefaultMetrics({ register: registry });
  } catch {
    /* default metrics already registered on this registry */
  }

  const server = http.createServer((req, res) => {
    if (
      req.method === "GET" &&
      (req.url === "/metrics" || req.url === "/bundler_metrics")
    ) {
      registry
        .metrics()
        .then((body) => {
          res.writeHead(200, { "Content-Type": registry.contentType });
          res.end(body);
        })
        .catch((error: unknown) => {
          res.writeHead(500);
          res.end(error instanceof Error ? error.message : String(error));
        });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on("error", (error) => {
    logger.error("Metrics server error", {
      name: opts.name,
      port,
      error: error.message,
    });
  });

  server.listen(port, bindAddress, () => {
    logger.info("Metrics server listening", {
      name: opts.name,
      port,
      instance,
      bindAddress,
    });
  });
}
