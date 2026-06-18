#!/bin/bash
# Cron trigger for bundle planning job.
# Add to crontab with: crontab -e
# Example (every 5 min): */5 * * * * /path/to/cron-trigger-plan.sh >> /tmp/bundle-plan-cron.log 2>&1
#
# Portable: resolves its own directory and uses `node` from PATH.
# Override the node binary if needed: NODE_BIN=/path/to/node ./cron-trigger-plan.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${NODE_BIN:-node}"

cd "$SCRIPT_DIR"
"$NODE_BIN" trigger-plan.js
