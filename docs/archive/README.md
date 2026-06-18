# Archived Documentation

Historical documents kept for reference only. **None of these describe the current
state of the system** — they are superseded plans, status snapshots, audits, and
decision analyses from earlier development (largely the AWS → open-source migration
and the Hetzner planning work of late 2025).

For current information, see the root [README.md](../../README.md),
[CLAUDE.md](../../CLAUDE.md), and the [docs index](../README.md).

## Contents

### Status snapshots and setup logs (point-in-time, dated)
- `2025-10-28-infrastructure-cleanup.md`, `2025-10-28-setup-complete.md`,
  `2025-10-28-vertically-integrated-status.md`
- `2025-10-29-security-fixes-plan.md`, `2025-10-29-x402-security-analysis.md`
- `STATUS.md`, `SERVICES_STATUS.md`, `SYSTEM_READINESS_REPORT.md`,
  `FINAL_DEEP_REVIEW.md`

### Testing / readiness checklists (superseded by current test scripts)
- `PRE_TESTING_CHECKLIST.md`, `TESTING_CHECKLIST.md`, `TEST_RESULTS.md`

### Configuration / migration notes
- `PORT_CONFIGURATION.md` — port allocation (now in the root README and CLAUDE.md)
- `MONOREPO_MIGRATION.md` — notes from the move to the Yarn-3 monorepo

### Technical analysis and audits
- `ARWEAVE_GATEWAY_ANALYSIS.md`, `X402_AUDIT_REPORT.md`

### Design and decision artifacts (proposals, not current architecture)
- `DEVILS_ADVOCATE_ANALYSIS.md` — pessimistic critique of the Hetzner migration plan
- `HETZNER_MIGRATION_ANALYSIS.md` — AWS-vs-Hetzner feasibility analysis
  (operationalized by [operations/HETZNER_DEPLOYMENT_RUNBOOK.md](../operations/HETZNER_DEPLOYMENT_RUNBOOK.md))
- `HIGH_AVAILABILITY_DISASTER_RECOVERY.md` — aspirational HA/DR design (the live
  system is single-node)
- `ADMIN_DASHBOARD_IMPLEMENTATION_PLAN.md` — plan for the admin dashboard (largely
  realized by the `admin-dashboard` PM2 process)

### Scale work (completed; still cited for tuning)
- `SCALE_TESTING_ANALYSIS.md` — analysis of scale bottlenecks
- `SCALE_FIX_IMPLEMENTATION_PLAN.md` — remediation plan. Some values (DB pool
  sizing, worker concurrency) are still referenced by the Hetzner runbook for
  capacity tuning.

---

*These files are kept for historical reference and are no longer actively maintained.*
