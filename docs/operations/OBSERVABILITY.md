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

## Not yet collected

- **App metrics** (`/bundler_metrics`, `/metrics`) are emitted but ungated — open on the
  public API ports. To gate them, front the app on `:443` only (close direct
  `:3001/:4001` in the firewall) and clamp the two paths in nginx with
  `metrics-allowlist.conf`.
- **postgres_exporter** (`:9187`) and **redis_exporter** (`:9121`, cache + queues) — the
  RDS/ElastiCache analog. Same pattern as node_exporter (install → firewall rule to
  collector CIDRs → **new** collector scrape job, since they're not auto-discovered).
- **Tracing** — OpenTelemetry → Honeycomb is wired (`packages/upload-service/src/arch/tracing.ts`)
  but dormant until `HONEYCOMB_API_KEY` is set.
