#!/bin/bash

#############################
# Verify AR.IO Bundler System Health
# Checks all services and infrastructure
#############################

# NOTE: deliberately NOT `set -e`. This is a tally-style health check — `check()`
# returns non-zero on a failed check, and under `set -e` the first failing check
# would abort the whole script before the summary/exit-code logic runs. We run
# every check, count pass/fail, and exit based on FAILED_CHECKS at the end.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Counters
TOTAL_CHECKS=0
PASSED_CHECKS=0
FAILED_CHECKS=0

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  🔍 AR.IO Bundler System Health Check"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Function to check and report
check() {
  local name="$1"
  local command="$2"
  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))

  if eval "$command" > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} $name"
    PASSED_CHECKS=$((PASSED_CHECKS + 1))
    return 0
  else
    echo -e "${RED}✗${NC} $name"
    FAILED_CHECKS=$((FAILED_CHECKS + 1))
    return 1
  fi
}

# Function to check with output
check_with_output() {
  local name="$1"
  local command="$2"
  local expected="$3"
  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))

  local output=$(eval "$command" 2>&1)
  if echo "$output" | grep -q "$expected"; then
    echo -e "${GREEN}✓${NC} $name"
    PASSED_CHECKS=$((PASSED_CHECKS + 1))
    return 0
  else
    echo -e "${RED}✗${NC} $name (got: ${output:0:50})"
    FAILED_CHECKS=$((FAILED_CHECKS + 1))
    return 1
  fi
}

# Section: Docker Infrastructure
echo -e "${BLUE}━━━ Docker Infrastructure ━━━${NC}"
check "PostgreSQL container running" "docker ps | grep -q ar-io-bundler-postgres"
check "PostgreSQL is healthy" "docker ps | grep ar-io-bundler-postgres | grep -q '(healthy)'"
check "Redis Cache container running" "docker ps | grep -q ar-io-bundler-redis-cache"
check "Redis Cache is healthy" "docker ps | grep ar-io-bundler-redis-cache | grep -q '(healthy)'"
check "Redis Queues container running" "docker ps | grep -q ar-io-bundler-redis-queues"
check "Redis Queues is healthy" "docker ps | grep ar-io-bundler-redis-queues | grep -q '(healthy)'"
check "MinIO container running" "docker ps | grep -q ar-io-bundler-minio"
check "MinIO is healthy" "docker ps | grep ar-io-bundler-minio | grep -q '(healthy)'"

# Two-tier MinIO: only relevant when the HDD archive tier is enabled via ARCHIVE_*.
# SSD-only deployments leave ARCHIVE_DATA_ITEM_BUCKET unset → these checks are skipped.
if [ -f "$PROJECT_ROOT/.env" ] && grep -qE '^ARCHIVE_DATA_ITEM_BUCKET=.+' "$PROJECT_ROOT/.env"; then
  check "Archive (HDD) MinIO container running" "docker ps | grep -q ar-io-bundler-minio-hdd"
  check "Archive (HDD) MinIO is healthy" "docker ps | grep ar-io-bundler-minio-hdd | grep -q '(healthy)'"
fi
echo ""

# Section: PM2 Processes
echo -e "${BLUE}━━━ PM2 Services ━━━${NC}"
check "PM2 is running" "pm2 list > /dev/null 2>&1"
check "payment-service process exists" "pm2 list | grep -q payment-service"
check "payment-service is online" "pm2 list | grep payment-service | grep -q online"
check "payment-workers process exists" "pm2 list | grep -q payment-workers"
check "payment-workers is online" "pm2 list | grep payment-workers | grep -q online"
check "upload-api process exists" "pm2 list | grep -q upload-api"
check "upload-api is online" "pm2 list | grep upload-api | grep -q online"
check "upload-workers process exists" "pm2 list | grep -q upload-workers"
check "upload-workers is online" "pm2 list | grep upload-workers | grep -q online"
check "admin-dashboard process exists" "pm2 list | grep -q admin-dashboard"
check "admin-dashboard is online" "pm2 list | grep admin-dashboard | grep -q online"
echo ""

# Section: HTTP Endpoints
echo -e "${BLUE}━━━ HTTP Endpoints ━━━${NC}"
check_with_output "Payment service health endpoint" "curl -s http://localhost:4001/health" "OK"
check_with_output "Upload service health endpoint" "curl -s http://localhost:3001/health" "OK"
check_with_output "Payment service pricing endpoint" "curl -s http://localhost:4001/v1/price/bytes/1000000" "winc"
# Auth-gated: since the dashboard overhaul (#86) an unauthenticated request
# redirects (302) to /admin/login rather than returning 401. Accept either as
# "protected" — a 200 here would mean the dashboard is wide open.
check "Admin dashboard is auth-protected (302→login or 401)" "curl -s -o /dev/null -w '%{http_code}' http://localhost:3002/admin/dashboard | grep -qE '302|401'"
check "Payment service port 4001 listening" "ss -tlnp 2>/dev/null | grep -q ':4001' || netstat -tln 2>/dev/null | grep -q ':4001'"
check "Upload service port 3001 listening" "ss -tlnp 2>/dev/null | grep -q ':3001' || netstat -tln 2>/dev/null | grep -q ':3001'"
check "Admin dashboard port 3002 listening" "ss -tlnp 2>/dev/null | grep -q ':3002' || netstat -tln 2>/dev/null | grep -q ':3002'"
echo ""

# Section: Service Connectivity
echo -e "${BLUE}━━━ Service Connectivity ━━━${NC}"
check "Upload service connected to Redis" "pm2 logs upload-api --lines 50 --nostream 2>&1 | grep -q 'Connected to Elasticache at localhost'"
check "Upload service listening on port" "pm2 logs upload-api --lines 50 --nostream 2>&1 | grep -q 'Listening on port 3001'"
check "Upload → Payment communication configured" "pm2 logs upload-api --lines 50 --nostream 2>&1 | grep -q 'Communicating with payment service'"
echo ""

# Section: Background Jobs (in-process BullMQ schedulers — NOT crontab)
echo -e "${BLUE}━━━ Background Jobs ━━━${NC}"
# Bundle planning, tiered cleanup, and posted-bundle redrive are registered as
# in-process BullMQ repeatable schedulers by upload-workers at startup (since the
# cron→scheduler migration). The real "is planning scheduled" signal is a repeat
# key in the queues Redis — NOT a crontab entry. A stale `trigger-plan` crontab
# entry would actually be a BUG (it double-fires alongside the in-process scheduler).
check "Bundle-planning scheduler registered (BullMQ, not crontab)" \
  "docker exec ar-io-bundler-redis-queues redis-cli -p 6381 --scan --pattern 'bull:upload-plan-bundle:repeat:*' 2>/dev/null | grep -q ."
echo ""

# Section: Log Checks (recent critical errors)
# NOTE: the previous form `grep -qi … | head -1` was a no-op — `grep -q` emits no
# output, so the pipeline's exit status came from `head` (always 0) and the result
# was meaningless. This checks grep's own exit status (recent errors = a non-fatal
# warning, so it never flips the overall exit code; only check()s set FAILED).
echo -e "${BLUE}━━━ Error Checks ━━━${NC}"
for proc in payment-service payment-workers upload-api upload-workers; do
  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))
  if pm2 logs "$proc" --lines 100 --nostream 2>&1 \
       | grep -v "OTEL" \
       | grep -qiE "error.*failed|critical|cannot start|ERR_REQUIRE_ESM"; then
    echo -e "${YELLOW}⚠${NC}  $proc has recent errors (check: pm2 logs $proc --err)"
  else
    echo -e "${GREEN}✓${NC} $proc: no critical errors"
    PASSED_CHECKS=$((PASSED_CHECKS + 1))
  fi
done
echo ""

# Summary
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}Summary:${NC}"
echo "  Total Checks: $TOTAL_CHECKS"
echo -e "  ${GREEN}Passed: $PASSED_CHECKS${NC}"
if [ $FAILED_CHECKS -gt 0 ]; then
  echo -e "  ${RED}Failed: $FAILED_CHECKS${NC}"
fi
echo ""

# Overall status
if [ $FAILED_CHECKS -eq 0 ]; then
  echo -e "${GREEN}✅ All systems operational!${NC}"
  echo ""
  echo "Service URLs:"
  echo "  Payment Service:    http://localhost:4001"
  echo "  Upload Service:     http://localhost:3001"
  echo "  Admin Dashboard:    http://localhost:3002/admin/dashboard"
  echo "  Queue Monitoring:   http://localhost:3002/admin/queues"
  echo "  MinIO Console:      http://localhost:9001"
  echo ""
  echo "Next steps:"
  echo "  • Test upload: curl -X POST http://localhost:3001/v1/tx -H 'Content-Type: application/octet-stream' --data 'Hello Arweave!'"
  echo "  • View logs: pm2 logs"
  echo "  • Monitor: pm2 monit"
  echo ""
  exit 0
else
  echo -e "${RED}❌ System has issues - check failed items above${NC}"
  echo ""
  echo "Troubleshooting:"
  echo "  • View logs: pm2 logs"
  echo "  • Restart services: ./scripts/restart.sh"
  echo "  • Full restart: ./scripts/stop.sh && ./scripts/start.sh"
  echo ""
  exit 1
fi
