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
// Load .env from the repository root BEFORE importing anything that reads
// process.env at module-eval time. constants.ts throws at import if
// X402_PAYMENT_ADDRESS is unset, and the worker imports below pull it in
// transitively. The API entry (src/index.ts) loads dotenv the same way;
// PM2's env_file injection is not reliable enough to satisfy import-time
// config validation, so the worker process must self-load its env first.
import { config as loadEnvFile } from "dotenv";
import * as path from "path";

import globalLogger from "../logger";
import {
  scheduleArNSReconcile,
  schedulePendingTxCheck,
} from "../queues/producers";
import { loadSecretsToEnv } from "../utils/loadSecretsToEnv";
import { createAdminCreditWorker } from "./adminCreditTool.worker";
import { createArNSRefundWorker } from "./arnsRefund.worker";
import { createPendingTxWorker } from "./creditPendingTx.worker";

// MUST run before the imports below — constants.ts throws at module-eval if X402
// is set without an address, and the worker imports pull it in transitively.
// CommonJS preserves textual order, so this statement runs before the require()s
// that follow (same pattern as src/index.ts). Do NOT move it back under them.
loadEnvFile({ path: path.join(__dirname, "../../../../.env") });

async function main() {
  globalLogger.info("Starting payment service workers");

  // Load secrets from environment (AWS Secrets Manager, etc.)
  await loadSecretsToEnv();

  // Create workers
  const workers = [
    createAdminCreditWorker(),
    createPendingTxWorker(),
    createArNSRefundWorker(),
  ];

  globalLogger.info(`Started ${workers.length} workers`);

  // Schedule the recurring pending TX check job
  await schedulePendingTxCheck();

  // Schedule the ArNS orphaned-debit reconcile backstop
  await scheduleArNSReconcile();

  // Graceful shutdown
  const shutdown = async () => {
    globalLogger.info("Shutting down workers gracefully");

    await Promise.all(workers.map((worker) => worker.close()));

    globalLogger.info("All workers closed");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((error) => {
  globalLogger.error("Failed to start workers", { error });
  process.exit(1);
});
