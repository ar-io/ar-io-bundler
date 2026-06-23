# Hetzner Bundler — End-to-End Go-Live Checklist

> Sequential, executable checklist for a clean production install of the AR.IO Bundler on a Hetzner
> dedicated box, vertically integrated with the two AR.IO gateways.
>
> This is the **do-this-in-order** companion to `HETZNER_DEPLOYMENT_RUNBOOK.md` — each step cites the
> runbook section (`→ §N`) that has the detail and the ⚠️ ACTION caveats. Sizing rationale is runbook §1.
>
> **🔴 PROD posts for real.** Unlike scale-testing (which uses the `:4555` $0 sink), production seeds bundles
> to the real gateway/Arweave network — **every bundle costs AR**. Confirm the signing wallet is funded
> (Phase 8) before opening uploads.

---

## Live deployment status — pre-prod · updated 2026-06-23

**Box:** Hetzner Ryzen 7 7700 · 8C/16T · 64 GB · 2× 1 TB NVMe (RAID1) + 16 TB HDD · **Ubuntu 22.04 LTS**.
**Endpoints:** `turbo.services.ardrive.net` (unified) · `upload.services.ardrive.net` · `payment.services.ardrive.net`.
**Gateways:** turbo-gateway.com — node1 `167.235.37.213`, node2 `167.235.37.218`.

- [x] **Phase 0** — server provisioned
- [x] **Phase 1** — NVMe RAID1; 16 TB HDD → xfs `/mnt/minio`; **Node 22 (system, `/usr/bin/node`)**; Docker 29.x + compose v5; `bundler` user
- [x] **Phase 4** — repo cloned on `develop` + `yarn build`
- [ ] **Phase 5** — `.env` ← **current step** (paste from the secure handoff; see §7 / `.env.sample`)
- [ ] **Phases 2, 3, 6–14** — pending (firewall, wallets, migrate, start, gateway wiring, TLS, smoke, backups, S1)

> Secrets + the real `.env` are handed off out-of-band (not in git). Tuning for this box:
> `API_INSTANCES=4`, `PG_SHARED_BUFFERS=16GB`, `DB_POOL_MAX=20`.

---

## Phase 0 — Procure the server (tonight)

- [ ] Pick a box per the **two filters** (→ §1 "Buying off-the-shelf"): **(1)** has SSD/NVMe for Postgres,
      **(2)** ≥ 3 TB for cold MinIO. Prefer ECC + a modern CPU.
      - Box chosen: `__________________________`  ·  Cold capacity: `______`  ·  ECC: `Y/N`
- [ ] Note the **disk plan** before install: SSD pair → OS+PG+FS-hot; bulk (HDD or 2nd SSD pair) → MinIO cold.
- [ ] Confirm datacenter/region (FSN preferred for proximity to the gateways' network).

## Phase 1 — OS, disks, base deps (→ §1, §3)

- [ ] Install **Ubuntu 24.04 LTS** via Hetzner installimage.
- [ ] 🔴 **Disk layout — do NOT use the installimage default (`SWRAIDLEVEL 5` across all 3 drives):** RAID5
      sizes to the smallest disk (would waste ~15 TB of the HDD) and runs the NVMe at HDD speed. Instead:
      - **2× NVMe → RAID 1** (`SWRAID 1`, `SWRAIDLEVEL 1`, list only `DRIVE1`/`DRIVE2`; **comment out
        `DRIVE3`**) → OS + `/var/lib/postgresql` + FS hot dirs (`TEMP_DIR`, `FS_DATA_PATH`).
        UEFI PART layout (all on the mirror): `PART /boot/efi esp 256M` · `PART swap swap 8G` ·
        `PART /boot ext4 1024M` · `PART / ext4 all`. installimage handles ESP-on-RAID automatically; data
        is fully mirrored — only a cold boot off the survivor after the *first* NVMe dies may need a manual
        boot-entry nudge. Verify after install: `cat /proc/mdstat` shows `[UU]`.
      - **16 TB HDD → standalone** (left out of RAID): post-install `apt install -y xfsprogs`;
        `parted -s /dev/sda mklabel gpt; parted -s /dev/sda mkpart minio 0% 100%;
        mkfs.xfs -L minio /dev/sda1; mkdir -p /mnt/minio; mount /mnt/minio` (+ fstab
        `LABEL=minio /mnt/minio xfs defaults,noatime 0 2`).
- [ ] Point **MinIO's data dir at `/mnt/minio`**: in `docker-compose.yml` change the minio volume from
      `minio-data:/data` to a bind mount `/mnt/minio:/data`.
- [ ] Create non-root deploy user `bundler`; deploy root `/opt/ar-io-bundler` (do **not** hardcode `/home/...`).
- [ ] **Node 22** via a system install (NodeSource), fixed absolute path — `@ar.io/sdk` v4 is ESM-only and
      payment-service will not boot on Node <22.12. One runtime for the whole PM2 fleet.
- [ ] `corepack enable && corepack prepare yarn@3.6.0 --activate`; install Docker + compose plugin; `npm i -g pm2`.

## Phase 2 — Network & firewall (→ §2)

- [ ] Attach to the **vSwitch** shared with the 2 gateways; record this box's **private IP**.
- [ ] Firewall: **public only** `22` (admin IPs), `80/443`. Everything else (`3001/4001/3002/9000/9001/5432/6379/6381/9090`)
      → localhost or the private gateway network only.
- [ ] DNS: `upload.<domain>` and `payment.<domain>` → this box (for TLS in Phase 11).

## Phase 3 — Secrets & wallets (→ §6)

- [ ] Place **two** wallets, mode `600`: `wallet.json` (`TURBO_JWK_FILE`), `rawWallet.json` (`RAW_DATA_ITEM_JWK_FILE`).
- [ ] `openssl rand -hex 32` → `PRIVATE_ROUTE_SECRET`; again → `JWT_SECRET` (must **match** across both services).
- [ ] Back up wallets + secrets **encrypted, off-box** (losing `wallet.json` = losing the posting identity).

## Phase 4 — Code & infrastructure (→ §4, §5)

- [ ] `git clone <ar.io-org-repo> /opt/ar-io-bundler` → `yarn install` → `yarn build`.
- [ ] `docker network create ar-io-network` (**before** compose up).
- [ ] Harden `docker-compose.yml`: pinned images, `restart: unless-stopped`, infra bound to localhost/private,
      **rotate** PG + MinIO creds off the defaults.
- [ ] **Postgres tuning** (PR #39 set `max_connections=500 shared_buffers=256MB`): on this box bump
      `shared_buffers` to **~25% of RAM** (e.g. 16 GB on 64 GB / 32 GB on 128 GB). Re-derive `max_connections`
      from `procs × DB_POOL_MAX + overhead`. *(→ finding #1, `scripts/perf/SCALE_TEST_PLAN.md`.)*
- [ ] `yarn infra:up` → confirm both DBs (`payment_service`, `upload_service`) and buckets
      (`raw-data-items`, `backup-data-items`) exist.

## Phase 5 — `.env` configuration (→ §7) — the error-prone one

- [ ] **DB:** host/port/user/pass, `DB_WRITER_ENDPOINT`=`DB_READER_ENDPOINT`=localhost, DB names, **`DB_POOL_MAX=20`**.
- [ ] **Redis ×2 (dual-naming footgun — set BOTH):** cache `REDIS_CACHE_*`/`ELASTICACHE_*` :6379; queues
      `REDIS_QUEUE_*`/`REDIS_HOST`+`REDIS_PORT_QUEUES` :6381.
- [ ] **MinIO/S3:** `S3_ENDPOINT=http://localhost:9000`, rotated creds, `S3_FORCE_PATH_STYLE=true`, bucket names.
- [ ] **Auth/inter-service:** `PRIVATE_ROUTE_SECRET`, `JWT_SECRET`, `PAYMENT_SERVICE_BASE_URL=localhost:4001` (no protocol).
- [ ] **PM2 scale:** `API_INSTANCES` ≈ ½ cores (e.g. 4 on an 8-core), `WORKER_INSTANCES=1`. Bump
      `PREPARE/POST/VERIFY_WORKER_CONCURRENCY` for the core count; **leave `PLAN_WORKER_CONCURRENCY=1`** (overlap guard).
- [ ] **🔴 `ARWEAVE_UPLOAD_NODE`** = your gateway **core** (`http://localhost:4000`) — this posts bundles to Arweave
      **for real** (costs AR). Do **not** point it at the `:4555` test sink in prod. *(→ §13.4 for the direct-to-core rationale.)*
- [ ] **Reads/pricing:** `ARWEAVE_GATEWAY` / `PUBLIC_ACCESS_GATEWAY` → your gateway (`:3000`), **never arweave.net**.
- [ ] **`PRICE_ORACLE_GATEWAY_URL`** → your own gateway `/price` (default arweave.net **429s under load** → "Pricing Oracle Unavailable").
- [ ] **Optical bridging:** `OPTICAL_BRIDGING_ENABLED=true`, `OPTICAL_BRIDGE_URL=http://<gw1>:4000/ar-io/admin/queue-data-item`,
      `OPTIONAL_OPTICAL_BRIDGE_URLS=http://<gw2>:4000/...` (the **second** gateway), `AR_IO_ADMIN_KEY`. Replace dev LAN IPs.
- [ ] **ARIO/Solana:** `ARIO_ADDRESS` = **base58 Solana** (stale Arweave addr crashes payment boot), `ARIO_GATEWAY_URL`
      = an RPC that allows `getProgramAccounts`, `ARIO_SOLANA_SIGNER_SECRET_KEY` (else ArNS is read-only).
- [ ] **x402:** `X402_PAYMENT_ADDRESS`, `CDP_API_KEY_ID`/`SECRET` (mainnet), `X402_FEE_PERCENT`,
      `UPLOAD_SERVICE_PUBLIC_URL=https://upload.<domain>` (x402 signing needs the real public URL).
- [ ] **FS hot-cache dirs:** `TEMP_DIR` + **`FS_DATA_PATH`** (on the NVMe). ⚠️ Use `FS_DATA_PATH` — **not**
      `UPLOAD_SERVICE_DATA_DIR` (that's a vestige of the old bash-cron cleanup; the app code + the MQ
      `cleanup-fs` worker read `FS_DATA_PATH`). Drop the legacy `ARIO_SIGNING_JWK` (ArNS writes use
      `ARIO_SOLANA_SIGNER_SECRET_KEY`).
- [ ] **Cleanup + basics:** `FILESYSTEM_CLEANUP_DAYS=7`, `MINIO_CLEANUP_DAYS=90`, `NODE_ENV=production`,
      `REQUEST_TIMEOUT_MS=600000`. `chmod 600 .env`.

## Phase 6 — Database migrations (→ §8)

- [ ] `yarn db:migrate` (payment then upload). `MIGRATE_ON_STARTUP=false` — run explicitly.
- [ ] Snapshot both DBs immediately after (clean baseline for rollback).

## Phase 7 — Start services + boot persistence (→ §9–11)

- [ ] `./scripts/start.sh` (checks infra, migrates, starts PM2). **Never `pm2 restart` directly.**
- [ ] `pm2 list` → **all 5** processes online — incl. **`payment-workers`** (else crypto top-ups never finalize).
- [ ] `sudo ./scripts/setup-pm2-startup.sh` → `pm2 save`.
- [ ] **Test reboot** → confirm Docker infra (restart policies) **and** PM2 (saved list) both come back.

## Phase 8 — Fund the wallet & confirm posting (🔴 prod = real AR)

- [ ] Confirm the **bundle-signing wallet has AR balance** (prod seeds for real). Top up if needed.
- [ ] Confirm `ARWEAVE_ADDRESS` matches `wallet.json`.

## Phase 9 — Schedulers (→ §12)

- [ ] `pm2 logs upload-workers --nostream | grep "job schedulers"` → plan (5 min) + cleanup (daily) registered.
- [ ] Install the **verify cron** with an **absolute Node path** (still subject to the stripped-PATH footgun):
      `0 * * * * NODE_BIN=/abs/node /opt/ar-io-bundler/scripts/trigger-verify.sh >> /var/log/bundler/verify.log 2>&1`.

## Phase 10 — Vertical integration with both gateways (→ §13)

- [ ] **Optical:** confirm new items reach both gateways' `/ar-io/admin/queue-data-item`.
- [ ] **MinIO retrieval:** on each gateway set `AWS_ENDPOINT`→bundler MinIO, `AWS_S3_CONTIGUOUS_DATA_BUCKET=raw-data-items`,
      creds, and prioritize `s3` in `ON_DEMAND_RETRIEVAL_ORDER`. Different-host gateways: route the MinIO aliases to
      this box's private IP.
- [ ] **Gateway-side chunk-ingest cache** (set in each *gateway's* `.env`, startup-read): `CHUNK_INGEST_CACHE_ENABLED=true`,
      `CHUNK_INGEST_CONFIRMATION_TIMEOUT_SECONDS=7200`, allowlist TODO — confirm the bundler's apparent source IP as core sees it.

## Phase 11 — TLS / reverse proxy (nginx co-located on the bundler box) (→ §14)

- [ ] DNS: `turbo.ardrive.io` + `upload.ardrive.io` + `payment.ardrive.io` → this box's public IP. (Bundler `:3001`/`:4001` stay **localhost-only** per §2 — nginx proxies from `127.0.0.1`.)
- [ ] Install `infrastructure/nginx/ar-io-bundler.conf` (sites-available → sites-enabled); `nginx -t` → reload. (`turbo.*` = unified path-mux; `upload.*`/`payment.*` = dedicated.)
- [ ] **Certs (Let's Encrypt, single SAN cert for all 3):** `certbot certonly --webroot -w /var/www/certbot -d turbo.ardrive.io -d upload.ardrive.io -d payment.ardrive.io --deploy-hook "systemctl reload nginx"`; then `certbot renew --dry-run`.
- [ ] Smoke-test the unified mux: `curl https://turbo.ardrive.io/v1/price/bytes/1000000` (→ payment), `curl https://turbo.ardrive.io/info` (→ upload), a `/v1/tx` upload (→ upload).
- [ ] 🔴 If on Cloudflare: keep `upload.<domain>` **DNS-only (grey cloud)** — CF's 100 MB body cap.
- [ ] Confirm `UPLOAD_SERVICE_PUBLIC_URL=https://upload.<domain>` (bundler trusts `X-Forwarded-Proto`).
- [ ] Verify the config encodes: **CORS + OPTIONS preflight**, upload `client_max_body_size 100M` + `proxy_request_buffering off`, payment `10M` + `proxy_request_buffering on` (and payment does **not** override `Content-Type`). Bull Board `:3002` / MinIO console / metrics get **no** public server block.
- [ ] *(Dev/test only)* if using a separate nginx router, point `proxy_pass` at the bundler's private IP and open `:3001`/`:4001` from the router IP only.

## Phase 12 — Smoke tests (→ §15)

- [ ] `./scripts/verify.sh`; `curl :3001/v1/info` + `:4001/v1/info` → 200.
- [ ] **Real end-to-end upload** (small signed): `new-data-item → plan → prepare → post → seed → verify`, and
      confirm it **mines** (real `block_height`) and appears on the gateway via optical + MinIO retrieval.
- [ ] **x402 unsigned upload** round-trips against the public HTTPS URL.

## Phase 13 — Backups, monitoring, rollback (→ §16–18)

- [ ] Backups scheduled & a **restore tested**: `pg_dump` both DBs off-box; `mc mirror` MinIO buckets off-box; wallets+`.env` encrypted off-box.
- [ ] Monitoring live: Prometheus scrape `:9090` + Grafana; alert on queue depth, worker liveness (esp.
      payment-workers/upload-workers), **DB pool saturation**, MinIO/PG disk growth, post/verify failure rates.
- [ ] `pm2-logrotate` + logrotate for cron logs.
- [ ] Rollback path rehearsed: tagged release + `db:migrate:rollback` + pre-migration snapshot.

## Phase 14 — Post-deploy validation & right-sizing

- [ ] Run **S1** (full-size bundles, off-box clients, **`:4555` $0 sink**) → right-size `API_INSTANCES`, worker
      concurrencies, and confirm disk/CPU/PG-IO-wait headroom. *(→ `scripts/perf/SCALE_TEST_PLAN.md`.)*
- [ ] Watch the **upload→payment hop** under load (finding #2): 503 cascade is driven by payment-service capacity
      + axios `retries=8`/60s timeout — tune if it surfaces in prod.
- [ ] Watch **MinIO disk** trend vs `MINIO_CLEANUP_DAYS`; if approaching the cold-volume limit, add a **local** NVMe/HDD
      (not network storage) and migrate the MinIO data dir.

---

### Go / no-go gate
Use the runbook's **Pre-flight checklist** (`HETZNER_DEPLOYMENT_RUNBOOK.md` end) as the final green-light gate
before opening public traffic.
