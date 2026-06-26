# Observability — metrics, exposure, and scraping

How the bundler's metrics are emitted, exposed, and gated for an external
Prometheus/OTel collector. The de-AWS stack has no CloudWatch; this is the
equivalent. Three independent metric sources, three different exposure paths.

## Metric sources

| Source | Endpoint (on the box) | What it covers | Exposed to the collector via | Gating |
|---|---|---|---|---|
| **App (upload)** | `:3001/bundler_metrics` | bundle pipeline (`fulfillment_job_*`, `circuit_breaker_*`, `chunk_seed_post_*`, `archive_copy_total`, …) + Node process | the public API port `:3001` | ⚠️ none yet (world-readable) |
| **App (payment)** | `:4001/metrics` | payments/Stripe/x402/chargebacks + Node process | the public API port `:4001` | ⚠️ none yet (world-readable) |
| **MinIO** (both tiers) | private `:9000` / `:9002` `…/minio/v2/metrics/cluster` | capacity/disk-fill, S3 request rates/errors/latency, ILM expiry, drives/health | **nginx** `:443` → `/minio-metrics/{bundler,archive}/cluster` | nginx CIDR allowlist **+** MinIO bearer token |
| **node_exporter** | `:9100/metrics` | host CPU, memory, **disk/filesystem fill**, network, load | the port `:9100` directly | **cloud firewall** (source-CIDR) |
| **postgres_exporter** | `:9187/metrics` | connections, xacts, locks, DB/table/index sizes, per-DB `pg_stat_*` | the port `:9187` directly | **cloud firewall** (source-CIDR) |
| **redis_exporter** | `:9121/scrape?target=…` | memory, evictions, keyspace, ops/sec — both `cache` (6379) + `queues` (6381) | the port `:9121` directly | **cloud firewall** (source-CIDR) |

> The MinIO scrape setup (bearer token, paths, collector job) is documented in
> `docs/architecture/TWO_TIER_MINIO.md` → "Observability: scraping MinIO metrics".

## Exposure model — three layers, not one

- **Hetzner Cloud Firewall** (dev) / **Robot firewall** (prod) — L3/L4, source-CIDR ×
  port. Default-deny inbound. This is the coarse gate and the *only* gate for
  plaintext exporter ports like `:9100`. It is **external to the VM** — invisible to
  `ufw`/`iptables` inside (ufw is intentionally unused here).
- **nginx `allow`/`deny`** (`snippets/metrics-allowlist.conf`) — L7, per-HTTP-path.
  Used for the MinIO metrics (`/minio-metrics/…`) because they ride the shared public
  `:443` and must be gated by *path*, which a packet filter can't do. Self-contained
  in nginx; does **not** use ufw.
- **MinIO bearer token** — app-layer auth on top of the nginx allowlist (defense in depth).

Why the split: a network firewall can open/close a *port* but can't tell
`/bundler_metrics` from a real upload on `:3001`. So path-scoped metrics go through
nginx; whole-port exporters (node_exporter) go through the firewall. This pattern is
identical on cloud (dev) and robot (prod) — only the firewall tool changes.

## node_exporter (host metrics)

Installed on the box as the Ubuntu package (auto systemd unit + `prometheus` user,
binds `:9100`):

```bash
apt-get install -y prometheus-node-exporter   # service: prometheus-node-exporter, port 9100
```

Exposed to the collector with a **cloud-firewall rule** (node_exporter has no auth, so
the source-CIDR restriction IS the gate — never `0.0.0.0/0`):

```bash
hcloud firewall add-rule ar-io-bundler-fw \
  --direction in --protocol tcp --port 9100 \
  --source-ips 10.83.0.0/24 \           # private vSwitch
  --source-ips 100.64.0.0/10 \          # Tailscale v4
  --source-ips fd7a:115c:a1e0::/48 \    # Tailscale v6
  --source-ips 34.205.91.20/32 \        # collector EIP
  --source-ips 34.192.58.42/32 \        # collector EIP
  --source-ips 54.166.111.219/32        # collector EIP
```

**No new scrape job needed** — the fleet's existing hcloud-SD `node_exporter` job
discovers every server in the project on `:9100` and scrapes it automatically. Verify:
`curl http://<tailnet-ip>:9100/metrics` (200 from an allowlisted source; refused from
the public IP).

> The collector egresses from more EIPs than the three above; add the rest to this rule
> (and to `metrics-allowlist.conf` for MinIO) once they're confirmed, or scrapes from
> those instances will be dropped.

## postgres_exporter & redis_exporter (DB/cache metrics)

The RDS/ElastiCache analog. Same exposure model as node_exporter (apt host process →
cloud-firewall rule to the collector CIDRs), but **not** auto-discovered — each needs an
explicit collector scrape job.

**postgres_exporter** (`:9187`) — reads via a dedicated **read-only `monitoring` role**
(`pg_monitor`, login, `CONNECT` on both DBs); the DSN lives in
`/etc/default/prometheus-postgres-exporter` (mode `640`, owner `root:prometheus`). `pg_stat_database`
is cluster-wide, so one exporter covers `payment_service` + `upload_service`.

```bash
# in postgres: CREATE ROLE monitoring LOGIN PASSWORD '…'; GRANT pg_monitor TO monitoring;
#              GRANT CONNECT ON DATABASE payment_service, upload_service TO monitoring;
apt-get install -y prometheus-postgres-exporter
# /etc/default/prometheus-postgres-exporter:
#   DATA_SOURCE_NAME="postgresql://monitoring:<pw>@127.0.0.1:5432/postgres?sslmode=disable"
```

**redis_exporter** (`:9121`) — both instances are passwordless and served by **one**
exporter via multi-target: `/scrape?target=redis://localhost:6379` (cache) and
`…:6381` (queues). `localhost` resolves from the exporter (on the box).

```bash
apt-get install -y prometheus-redis-exporter   # default /metrics = cache; queues via /scrape
```

Firewall (same source set as `:9100`):

```bash
hcloud firewall add-rule ar-io-bundler-fw --direction in --protocol tcp --port 9187 \
  --source-ips 10.83.0.0/24 --source-ips 100.64.0.0/10 --source-ips fd7a:115c:a1e0::/48 \
  --source-ips 34.205.91.20/32 --source-ips 34.192.58.42/32 --source-ips 54.166.111.219/32
# …and again with --port 9121
```

**Collector scrape jobs to add** (these are not auto-discovered):

```yaml
- job_name: ar_io_dev_bundler_postgres
  scrape_interval: 60s
  static_configs:
    - targets: ['178.105.217.148:9187']

- job_name: ar_io_dev_bundler_redis
  metrics_path: /scrape
  scrape_interval: 60s
  static_configs:
    - { targets: ['redis://localhost:6379'], labels: { redis_instance: cache } }
    - { targets: ['redis://localhost:6381'], labels: { redis_instance: queues } }
  relabel_configs:
    - { source_labels: [__address__], target_label: __param_target }
    - { source_labels: [__param_target], target_label: instance }
    - { target_label: __address__, replacement: '178.105.217.148:9121' }   # the exporter
```

## Collector scrape config (MinIO)

node_exporter is auto-discovered; MinIO needs explicit jobs (https + bearer token,
one token serves both tiers):

```yaml
- job_name: ar_io_dev_bundler_minio_bundler
  scheme: https
  metrics_path: /minio-metrics/bundler/cluster
  authorization: { type: Bearer, credentials: <minio-prom-token> }
  static_configs: [{ targets: ['turbo.services.ar-io.dev'], labels: { tier: bundler } }]
- job_name: ar_io_dev_bundler_minio_archive
  scheme: https
  metrics_path: /minio-metrics/archive/cluster
  authorization: { type: Bearer, credentials: <minio-prom-token> }
  static_configs: [{ targets: ['turbo.services.ar-io.dev'], labels: { tier: archive } }]
```

Generate the MinIO token: `mc admin prometheus generate <alias> cluster`.

## nginx per-host access log (log-based, added 2026-06-26)

`nginx.conf` runs a custom `log_format vhost` (standard *combined* + `host=` `upstream=`
`ustatus=` `urt=` `rt=`). This is the **only** way to attribute traffic, errors, and
latency **per hostname** (`turbo.ardrive.io` vs `upload.ardrive.io` vs `*.services.ar.io`)
and to watch the `turbo.ardrive.io`→AWS **payment-proxy round-trip** (`urt` on lines whose
`upstream` is a CloudFront IP, not `127.0.0.1`). Today it's grep/awk only — a promtail/Loki
or `mtail` exporter could turn it into metrics later. Field reference + queries:
`NGINX_ROUTER_HANDOFF.md` → Logging. (`nginx.conf` is box-local — re-apply after reinstall.)

## Not yet collected

- **App metrics** (`/bundler_metrics`, `/metrics`) are emitted but ungated — open on the
  public API ports. To gate them, front the app on `:443` only (close direct
  `:3001/:4001` in the firewall) and clamp the two paths in nginx with
  `metrics-allowlist.conf`.
- **Tracing** — OpenTelemetry → Honeycomb is wired (`packages/upload-service/src/arch/tracing.ts`)
  but dormant until `HONEYCOMB_API_KEY` is set.
