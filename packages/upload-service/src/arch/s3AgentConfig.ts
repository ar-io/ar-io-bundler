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
import { NodeHttpHandler } from "@smithy/node-http-handler";
import * as http from "http";
import * as https from "https";

// S3/MinIO connection-pool size.
//
// NOTE: @smithy/node-http-handler already defaults BOTH agents to
// { keepAlive: true, maxSockets: 50 } even when only one is passed, so keepAlive
// was never the problem. The bottleneck is the *cap*: a single upload-workers
// process assembling bundles issues many concurrent getObject reads against MinIO
// (cache-miss data items + several in-flight bundles), and 50 sockets is too few —
// excess reads queue past the pool and time out as "Failed to fetch data item",
// aborting prepare-bundle and stalling bundling under load.
//
// A/B confirmed on a 40 item/s soak: maxSockets=50 → ~65 prepare failures and no
// bundles seed; maxSockets=256 → 0 failures. We pass explicit agents purely to
// raise that cap (S3_MAX_SOCKETS, default 256). Both http and https are set for
// portability — MinIO is http://, production S3 is typically https://.
export const s3MaxSockets = Number(process.env.S3_MAX_SOCKETS ?? 256);

export const s3AgentOptions = {
  keepAlive: true,
  timeout: 60_000,
  maxSockets: s3MaxSockets,
};

export const s3HttpAgent = new http.Agent(s3AgentOptions);
export const s3HttpsAgent = new https.Agent(s3AgentOptions);

/** Build a NodeHttpHandler that pools connections for both http and https S3 endpoints. */
export const buildS3RequestHandler = (): NodeHttpHandler =>
  new NodeHttpHandler({
    httpAgent: s3HttpAgent,
    httpsAgent: s3HttpsAgent,
    connectionTimeout: 5_000,
  });
