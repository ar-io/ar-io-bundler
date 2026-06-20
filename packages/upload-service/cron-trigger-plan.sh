#!/bin/bash
# MANUAL bundle-planning trigger (dev/ops convenience).
#
# NOTE: bundle planning is now scheduled IN-PROCESS by the always-running
# upload-workers process (BullMQ job scheduler, default every 5 min; see
# src/workers/allWorkers.ts, tunable via PLAN_SCHEDULE_CRON). You no longer
# need a crontab entry — adding one just double-enqueues (the plan job is
# idempotent, so harmless but wasteful). Use this to kick a plan run on demand.
#
# Portable: resolves its own directory and uses `node` from PATH.
# Override the node binary if needed: NODE_BIN=/path/to/node ./cron-trigger-plan.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${NODE_BIN:-node}"

cd "$SCRIPT_DIR"
"$NODE_BIN" trigger-plan.js
