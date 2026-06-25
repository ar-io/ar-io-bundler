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
// Load .env file from repository root BEFORE importing anything else that uses process.env
import { config } from "dotenv";
import * as path from "path";
// NOTE: .env must load HERE, before the local imports below that read process.env
// at module-eval (db config, wallet utils). Keep config() above them — do not let
// a formatter hoist the imports above it (breaks local non-PM2 `yarn start`).
config({ path: path.join(__dirname, "../../../.env") });

import { startMetricsServer } from "./arch/metricsServer";
import logger from "./logger";
import { createServer } from "./server";

// Here is our server 🙌
createServer({})
  .then(() => {
    // Per-instance Prometheus endpoint (basePort + NODE_APP_INSTANCE). upload-api
    // runs in PM2 cluster mode, so each instance exposes its own port and the
    // collector scrapes all of them (Prometheus sum()s across instances).
    startMetricsServer({
      basePort:
        Number.parseInt(process.env.UPLOAD_API_METRICS_PORT ?? "9301", 10) ||
        9301,
      name: "upload-api",
    });
  })
  .catch((error) => {
    logger.error("Failed to start server.", error);
    process.exit(1);
  });
