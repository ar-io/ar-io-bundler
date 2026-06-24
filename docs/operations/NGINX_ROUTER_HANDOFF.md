# nginx Router Handoff — add the AR.IO Bundler endpoints

> **For the nginx-router agent.** Goal: add three bundler endpoints to an **existing, live** nginx router
> **additively**, without disturbing any other vhost on the box (gateways, c2pa, etc.).
>
> Roles (each reusable on any hostname):
> - **unified** `turbo.<domain>` — one host, path-muxed to both services
> - **upload** `upload.<domain>` → upload-service `:3001`
> - **payment** `payment.<domain>` → payment-service `:4001`
>
> The config + reusable snippets are the source of truth in the bundler repo:
> `infrastructure/nginx/ar-io-bundler.conf` and `infrastructure/nginx/snippets/*`. They have been
> validated with `nginx -t` and an empirical per-path routing test — **do not re-derive the routing**, copy
> it. This doc is how to *adapt and install* it on this router.

## 0. Inputs to confirm before touching anything
- **Hostnames** for the three roles (e.g. for perma.online: `turbo.services.perma.online`,
  `upload.services.perma.online`, `payment.services.perma.online`). Confirm exact names with the operator.
- **Bundler backend address.** This router is a **separate box**, so the upstreams point at the bundler's
  **private IP**, not localhost — e.g. `<BUNDLER_PRIVATE_IP>:3001` (upload) and `:4001` (payment). Confirm the IP.
- **TLS cert** that covers all three names. The router already manages Let's Encrypt certs (e.g.
  `perma.online-0001`). Confirm whether the existing cert's SAN list includes the three names; if not,
  expand it (see §4).
- **Existing blocks.** Check whether `upload.services.<domain>` / `payment.services.<domain>` server blocks
  already exist in the current config — if so you are **replacing** them with the snippet-based versions
  (same behavior, plus the new unified host), not adding duplicates.

## 1. Install the snippets (no effect until referenced)
Copy the five files from `infrastructure/nginx/snippets/` to `/etc/nginx/snippets/`:
`bundler-ssl-params.conf`, `bundler-headers.conf`, `bundler-loc-upload.conf`, `bundler-loc-payment.conf`,
`bundler-loc-unified.conf`. These are inert until a `server` block `include`s them.

## 2. Add ONE site file — `/etc/nginx/sites-available/ar-io-bundler.conf`
Start from `infrastructure/nginx/ar-io-bundler.conf` and change exactly three things:
1. **`upstream` targets** → the bundler private IP (separate-router):
   ```nginx
   upstream bundler_upload  { server <BUNDLER_PRIVATE_IP>:3001; keepalive 32; }
   upstream bundler_payment { server <BUNDLER_PRIVATE_IP>:4001; keepalive 32; }
   ```
2. **`server_name`** in each of the three `:443` blocks (and the `:80` redirect block) → the confirmed
   hostnames for this domain.
3. **`ssl_certificate` / `ssl_certificate_key`** → the cert that covers those names.

> If the router already has a global `:80` redirect that covers `*.services.<domain>` (many do), **omit the
> `:80` server block** from this file to avoid a duplicate-default conflict — the existing redirect handles
> ACME + HTTP→HTTPS. Keep only the three `:443` blocks.

Symlink it enabled: `ln -s ../sites-available/ar-io-bundler.conf /etc/nginx/sites-enabled/`.

## 3. Don't break the box
- **Additive only.** Do not edit or remove other `server` blocks. The only allowed change to existing
  blocks is *replacing* a now-superseded `upload.services.*` / `payment.services.*` block (move it out of
  the old file into this one), and only if the operator confirms.
- **Back up first:** `cp -a /etc/nginx/sites-available /root/nginx-backup-$(date +%s)` (or the snapshot
  mechanism this box uses).
- **`nginx -t` BEFORE every reload.** Never `reload` on a failing test.

## 4. Certs (only if the existing cert doesn't cover the names)
```bash
# Add the three names to a SAN cert (webroot path as used on this router):
certbot certonly --webroot -w /var/www/certbot \
  -d turbo.<domain> -d upload.<domain> -d payment.<domain> \
  --deploy-hook "systemctl reload nginx"
certbot renew --dry-run
```
Point the site file's `ssl_certificate*` at the resulting `/etc/letsencrypt/live/<first-name>/...`.

## 5. Validate, then reload
```bash
nginx -t                # must say "test is successful"
systemctl reload nginx  # only if -t passed
```
Then verify routing (replace host/IP as needed; use the real https host once DNS+cert are live):
```bash
H=turbo.<domain>
curl -s  https://$H/info                         # -> upload service info
curl -s  https://$H/v1/price/bytes/1000000       # -> payment (a real winston price)
curl -s  https://$H/v1/price/x402/data-item/ethereum/1000   # -> upload (x402 pricing)
curl -sI https://$H/v1/balance                   # -> payment
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS https://$H/v1/tx   # -> 204 (CORS preflight)
# And confirm an UNRELATED existing vhost still works (e.g. the gateway root).
```

## Routing reference (what the unified host does)
Default → **upload** (incl. `/`, `/info`, `/health`, `/tx`, `/chunks`, `/x402/upload`, `/bundler_metrics`).
Explicit **payment** prefixes → payment: `/v1/balance`, `/v1/account/`, `/v1/price/`, `/v1/rates`,
`/v1/currencies`, `/v1/countries`, `/v1/redeem`, `/v1/reserve-balance/`, `/v1/refund-balance/`,
`/v1/check-balance/`, `/v1/x402/`, `/v1/arns/`, `/v1/stripe-webhook`, `/account/balance`, `/price/`.
Longest-prefix overrides send `/v1/price/x402/`, `/price/x402/`, `/v1/x402/upload/`, `/v1/x402/data-item/`
back to **upload**. `/info` & `/v1/info` resolve to **upload** (intended).

Settings baked into the snippets: CORS (`*`) + `OPTIONS`→204 (backends' own CORS is disabled, so no
duplication); upload `client_max_body_size 100M` + `proxy_request_buffering off` + 300s; payment `10M` +
`proxy_request_buffering on` + 60s and **no `Content-Type` override**; HTTP/1.1 keepalive; TLS 1.2/1.3.
