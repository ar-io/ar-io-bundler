#!/bin/bash

###############################################################################
# Zero-downtime(-ish) deploy for AR.IO Bundler
#
# Rolling-reloads the CLUSTER HTTP APIs (upload-api ×N, payment-service ×N) with
# `pm2 reload`, so the listening socket is held by the cluster master the whole
# time and nginx never sees a refused connection — no client-facing outage.
# The FORK workers (upload-workers, payment-workers, admin-dashboard) cannot be
# cluster-reloaded, so they are restarted: that is SAFE and invisible to clients
# — they shut down gracefully (SIGTERM handler, 30s kill_timeout) and BullMQ
# persists every job in Redis, so the pipeline resumes mid-flight with no loss.
#
# Env is re-read: the canonical ecosystem loads `.env` at eval time AND via
# env_file, and we pass `--update-env`, so .env changes take effect on reload
# (a bare `pm2 reload <name>` would NOT re-read .env — that's why we pass the
# ecosystem file here).
#
# Usage:
#   ./scripts/deploy.sh                # build upload+payment, then reload ALL (rolling APIs + restart workers)
#   ./scripts/deploy.sh --api-only     # reload ONLY upload-api + payment-service; leave workers running untouched
#   ./scripts/deploy.sh --no-build     # skip `yarn build` (artifacts already built)
#   ./scripts/deploy.sh --api-only --no-build
#
# When NOT to use this (use ./scripts/start.sh instead):
#   - first boot, or Docker infra (Postgres/Redis/MinIO) is down
#   - the PM2 apps are not currently running
#
# This script is READ-ONLY with respect to BullMQ queues — it never triggers,
# drains, retries, or mutates any job/queue.
###############################################################################

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ECOSYSTEM="ecosystem.config.js"   # root shim → infrastructure/pm2/ecosystem.config.js
CLUSTER_APPS="upload-api,payment-service"
UPLOAD_HEALTH="http://localhost:${UPLOAD_SERVICE_PORT:-3001}/v1/info"
PAYMENT_HEALTH="http://localhost:${PAYMENT_SERVICE_PORT:-4001}/v1/info"

API_ONLY=false
DO_BUILD=true
for arg in "$@"; do
  case "$arg" in
    --api-only) API_ONLY=true ;;
    --no-build) DO_BUILD=false ;;
    -h|--help) sed -n '3,33p' "$0"; exit 0 ;;
    *) echo -e "${RED}✗${NC} Unknown arg: $arg (see --help)"; exit 1 ;;
  esac
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  AR.IO Bundler — rolling deploy"
echo "  mode: $([ "$API_ONLY" = true ] && echo 'API-only (upload-api + payment-service)' || echo 'all apps')  build: $DO_BUILD"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ---- pre-flight ----------------------------------------------------------
[ -f "$PROJECT_ROOT/.env" ] || { echo -e "${RED}✗${NC} .env not found — use ./scripts/start.sh for first boot."; exit 1; }

command -v pm2 >/dev/null 2>&1 || { echo -e "${RED}✗${NC} pm2 not on PATH (run as the deploy user that owns the daemon)."; exit 1; }

# Must already be running — reload is for an UP stack, not a cold start.
if ! pm2 jlist 2>/dev/null | grep -q '"name":"upload-api"'; then
  echo -e "${RED}✗${NC} upload-api is not running under this pm2 daemon."
  echo "   This is a reload, not a cold start. Use ./scripts/start.sh, or check you are the deploy user."
  exit 1
fi

# Infra sanity (reload onto down infra = crash loop). Warn, don't hard-block.
if command -v docker >/dev/null 2>&1; then
  unhealthy="$(docker ps --filter 'name=ar-io-bundler-' --format '{{.Names}} {{.Status}}' 2>/dev/null | grep -ivE 'healthy|Up ' || true)"
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q 'ar-io-bundler-postgres'; then
    [ -n "$unhealthy" ] && echo -e "${YELLOW}⚠${NC}  some infra containers look unhealthy:\n$unhealthy"
  else
    echo -e "${YELLOW}⚠${NC}  ar-io-bundler infra containers not found via docker — ensure Postgres/Redis/MinIO are up before reloading."
  fi
fi
echo -e "${GREEN}✓${NC} pre-flight ok (.env present, pm2 up, apps online)"

# ---- build ---------------------------------------------------------------
if [ "$DO_BUILD" = true ]; then
  echo "→ building payment-service…"
  ( cd "$PROJECT_ROOT/packages/payment-service" && yarn build )
  echo "→ building upload-service…"
  ( cd "$PROJECT_ROOT/packages/upload-service" && yarn build )
  for p in payment-service upload-service; do
    [ -f "$PROJECT_ROOT/packages/$p/lib/index.js" ] || { echo -e "${RED}✗${NC} build produced no lib/index.js for $p — aborting before reload."; exit 1; }
  done
  echo -e "${GREEN}✓${NC} builds present"
else
  echo -e "${YELLOW}⚠${NC}  --no-build: reloading existing lib/ artifacts"
fi

# ---- reload --------------------------------------------------------------
# `--update-env` + passing the ecosystem file re-reads .env (env_file + eval-time
# dotenv) so config/env changes are applied. Cluster apps roll one instance at a
# time (zero downtime); fork apps restart (safe).
if [ "$API_ONLY" = true ]; then
  echo "→ rolling reload: $CLUSTER_APPS (workers left running)…"
  pm2 reload "$ECOSYSTEM" --only "$CLUSTER_APPS" --update-env
else
  echo "→ rolling reload APIs + restart workers (all apps)…"
  pm2 reload "$ECOSYSTEM" --update-env
fi

# ---- post-reload health gate --------------------------------------------
echo "→ waiting for APIs to report healthy…"
ok=false
for i in $(seq 1 30); do
  if curl -sf -m 4 "$UPLOAD_HEALTH" >/dev/null 2>&1 && curl -sf -m 4 "$PAYMENT_HEALTH" >/dev/null 2>&1; then
    ok=true; break
  fi
  sleep 1
done

echo ""
pm2 list 2>/dev/null | grep -E 'name|upload-api|payment-service|upload-workers|payment-workers|admin-dashboard' || true
echo ""
if [ "$ok" = true ]; then
  echo -e "${GREEN}✓ deploy complete${NC} — upload + payment APIs healthy."
  echo "   verify: curl -s $UPLOAD_HEALTH | jq .arweave"
else
  echo -e "${RED}✗ APIs did NOT report healthy within 30s${NC}"
  echo "   check: pm2 logs upload-api --err   |   pm2 logs payment-service --err"
  echo "   rollback: git checkout <prev>, rebuild, ./scripts/deploy.sh --no-build (or ./scripts/start.sh)"
  exit 1
fi
