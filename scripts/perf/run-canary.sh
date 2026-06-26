#!/usr/bin/env bash
#
# AR.IO Bundler — canary cron wrapper
# ===================================
# Runs the upload-pipeline canary (scripts/perf/canary.mjs) against a named
# target and posts Slack alerts on failure/recovery. Built to be invoked from
# cron every 10 minutes — it hard-codes nothing the cron environment can't be
# trusted to provide:
#   • uses an ABSOLUTE node 22 path (cron's default PATH finds the box's node 12,
#     which can't run the ESM canary)
#   • cd's to the repo root (the canary resolves targets.json / results/ from
#     its own dir, but .env and relative paths need a stable cwd)
#   • sources the repo-root .env so SLACK_OAUTH_TOKEN / SLACK_ALERT_CHANNEL_ID
#     (and any signer/env knobs) are present
#   • appends to a size-capped logfile so a 10-min cadence can't fill the disk
#
# Usage:  run-canary.sh [target]      (default target: legacy = upload.ardrive.io)
# Cron:   */10 * * * * /home/vilenarios/ar-io-bundler/scripts/perf/run-canary.sh >> ... 2>&1
#
# Exit code mirrors the canary: 0 = PASS, 1 = FAIL, 2 = fatal. (Cron ignores it;
# the Slack alert + logfile are the signal.)

set -uo pipefail

TARGET="${1:-legacy}"

# Resolve repo root from this script's location (scripts/perf/ -> repo root).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Absolute node 22 (the canary is ESM + needs Node 22; cron's PATH has node 12).
NODE_BIN="${CANARY_NODE_BIN:-$HOME/.nvm/versions/node/v22.17.0/bin/node}"
if [[ ! -x "$NODE_BIN" ]]; then
  # Fall back to the newest installed nvm node 22.x.
  NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/v22.*/bin/node 2>/dev/null | sort -V | tail -1)"
fi

LOG_DIR="$SCRIPT_DIR/results"
LOG_FILE="$LOG_DIR/canary-$TARGET.log"
OUT_FILE="$LOG_DIR/canary-$TARGET-latest.json"
mkdir -p "$LOG_DIR"

cd "$REPO_ROOT" || exit 2

# Load env from the repo-root .env (for SLACK_OAUTH_TOKEN / SLACK_ALERT_CHANNEL_ID
# and any CANARY_*/ALERT_* knobs). Parse line-by-line instead of `source`-ing it:
# .env holds values with spaces/special chars (e.g. "AR.IO Bundler") that the
# shell would try to EXECUTE if sourced. This only sets KEY=VALUE pairs.
if [[ -f "$REPO_ROOT/.env" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue          # comment
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue # not a KEY=VALUE line
    key="${line%%=*}"
    val="${line#*=}"
    val="${val%\"}"; val="${val#\"}"                      # strip surrounding quotes
    val="${val%\'}"; val="${val#\'}"
    export "$key=$val"
  done < "$REPO_ROOT/.env"
fi

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "$(date -u +%FT%TZ) FATAL: node 22 not found (set CANARY_NODE_BIN)" >> "$LOG_FILE"
  exit 2
fi

# Run the fast canary: one tiny free upload, walked end-to-end, Slack on
# fail/recover (anti-flap: pages only after 2 consecutive fails, resolves once).
"$NODE_BIN" "$SCRIPT_DIR/canary.mjs" \
  --target "$TARGET" \
  --slack \
  --out "$OUT_FILE" \
  >> "$LOG_FILE" 2>&1
rc=$?

echo "$(date -u +%FT%TZ) target=$TARGET exit=$rc" >> "$LOG_FILE"

# Cap the logfile to the last 5000 lines so the 10-min cadence can't grow it
# without bound (≈144 runs/day).
if [[ -f "$LOG_FILE" ]]; then
  tail -n 5000 "$LOG_FILE" > "$LOG_FILE.tmp" 2>/dev/null && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi

exit $rc
