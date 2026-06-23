# AR.IO Bundler Documentation

Documentation for the [AR.IO Bundler](https://github.com/ar-io/ar-io-bundler) — a
complete ANS-104 data bundling platform for Arweave with AR.IO Gateway integration
and x402 payment support.

Start with the root [README.md](../README.md) (administrator quick-start) and
[CLAUDE.md](../CLAUDE.md) (developer / agent guidance). This directory holds the
deeper references.

## Structure

### [architecture/](./architecture/)
- [**ARCHITECTURE.md**](./architecture/ARCHITECTURE.md) — Full system architecture:
  services, the two PostgreSQL databases, the 12-queue BullMQ pipeline, MinIO
  object storage, APIs, and data flows.
- [**X402_END_TO_END_DEEP_DIVE.md**](./architecture/X402_END_TO_END_DEEP_DIVE.md) —
  How an x402 USDC payment threads through the upload and payment services.

### [setup/](./setup/)
- [**SETUP_GUIDE.md**](./setup/SETUP_GUIDE.md) — Walkthrough of the interactive
  `scripts/setup-bundler.sh` configuration wizard.
- [README.md](./setup/README.md) — Quick-start developer setup.

### [operations/](./operations/)
- [**HETZNER_DEPLOYMENT_RUNBOOK.md**](./operations/HETZNER_DEPLOYMENT_RUNBOOK.md) —
  Authoritative production deployment runbook (bare-metal/Hetzner, Node 22, the
  5-process PM2 layout, cron, vertical gateway integration, TLS, backups).
- [**ADMIN_GUIDE.md**](./operations/ADMIN_GUIDE.md) — Day-to-day administration:
  install, configure, manage, monitor, troubleshoot.
- [**INFRASTRUCTURE_COMPONENTS.md**](./operations/INFRASTRUCTURE_COMPONENTS.md) —
  Inventory of the Docker infrastructure and the 5 PM2 processes.
- [**FEE_CONFIGURATION_GUIDE.md**](./operations/FEE_CONFIGURATION_GUIDE.md) —
  Configuring pricing adjustments / fees.

### [api/](./api/)
- [**README.md**](./api/README.md) — REST API reference for both services.

### [guides/](./guides/)
- [**FEATURE_GUIDE.md**](./guides/FEATURE_GUIDE.md) — Feature overview.
- [**X402_INTEGRATION_GUIDE.md**](./guides/X402_INTEGRATION_GUIDE.md) — Integrating
  x402 USDC payments (signed and unsigned uploads).

### [archive/](./archive/)
Historical decision analyses and audits kept for reference only (gateway/x402
analysis, the Hetzner-migration feasibility study, HA/DR design). **Not current
state.** Superseded plans, status reports, testing checklists, and the completed
AWS → open-source migration phase logs were removed in a docs cleanup (still in
git history). Do not treat as authoritative.

## Quick links

| Topic | Document |
|-------|----------|
| Get started | [Root README](../README.md) |
| Developer / agent guidance | [Root CLAUDE.md](../CLAUDE.md) |
| Production deployment | [Hetzner runbook](./operations/HETZNER_DEPLOYMENT_RUNBOOK.md) |
| System architecture | [ARCHITECTURE.md](./architecture/ARCHITECTURE.md) |
| API reference | [api/README.md](./api/README.md) |
| x402 integration | [guides/X402_INTEGRATION_GUIDE.md](./guides/X402_INTEGRATION_GUIDE.md) |

## Support

- GitHub: https://github.com/ar-io/ar-io-bundler
- Issues: https://github.com/ar-io/ar-io-bundler/issues
- Arweave docs: https://docs.arweave.org
- AR.IO docs: https://docs.ar.io
