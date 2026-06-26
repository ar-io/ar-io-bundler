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
Copy the core files from `infrastructure/nginx/snippets/` to `/etc/nginx/snippets/`:
`bundler-ssl-params.conf`, `bundler-headers.conf`, `bundler-loc-upload.conf`, `bundler-loc-payment.conf`,
`bundler-loc-unified.conf`. These are inert until a `server` block `include`s them.
For the **external-payment split-route** variant (see the section below), also copy
`bundler-loc-unified-extpay.conf` + `bundler-extpay.conf`.

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
`/v1/check-balance/`, `/v1/x402/`, `/v1/arns/`, `/v1/stripe-webhook`, **`/v1/top-up/`**, `/account/`,
`/price/`, `/x402/top-up`.
Longest-prefix overrides send `/v1/price/x402/`, `/price/x402/`, `/v1/x402/upload/`, `/v1/x402/data-item/`
back to **upload**. `/info` & `/v1/info` resolve to **upload** (intended).

> ⚠️ **`/v1/top-up/` is the Stripe/fiat top-up family** (`/v1/top-up/payment-intent/…`,
> `/v1/top-up/checkout-session/…`) — the primary credit-purchase flow. It was missing from the
> original list and silently fell through to upload (404) until 2026-06-26. If you regenerate this
> list, derive it from the payment service's **actual** route surface (see the split-route section
> below), not memory.

Settings baked into the snippets: CORS (`*`) + `OPTIONS`→204 (backends' own CORS is disabled, so no
duplication); upload `client_max_body_size 100M` + `proxy_request_buffering off` + 300s; payment `10M` +
`proxy_request_buffering on` + 60s and **no `Content-Type` override**; HTTP/1.1 keepalive; TLS 1.2/1.3.

## Split-route variant — unified host, payment proxied to an EXTERNAL service

Use this when a `turbo.<domain>` host must serve **uploads locally** but send **payment
routes to an external/upstream payment service** instead of the local `:4001` — e.g. during
an ArDrive cutover where the box's local payment service is idle and `payment.ardrive.io`
(AWS CloudFront) stays authoritative for balances/top-ups. First proven on `turbo.ardrive.io`
2026-06-26.

**Snippets** (source-of-truth in `infrastructure/nginx/snippets/`):
- `bundler-loc-unified-extpay.conf` — the unified mux, but payment prefixes `proxy_pass` to the
  external host instead of `bundler_payment`. Use it **in place of** `bundler-loc-unified.conf`
  in the unified server block.
- `bundler-extpay.conf` — shared per-location directives for the payment→external hop.

**The external-payment hop has five non-obvious requirements (all baked into `bundler-extpay.conf`):**
1. **Host rewrite** — `proxy_set_header Host payment.ardrive.io` (CloudFront host-routes; sending the
   client Host → 403). Setting Host here drops server-level header inheritance, so the snippet
   **re-declares all forwarding headers**.
2. **SNI** — `proxy_ssl_server_name on` + `proxy_ssl_name payment.ardrive.io` (else wrong/empty cert).
3. **Runtime DNS** — `proxy_pass https://$pay$request_uri` (variable) + `resolver 127.0.0.53` so
   rotating CloudFront IPs are re-resolved (a literal `proxy_pass` caches one IP forever). The
   `$request_uri` form preserves path **and query string**.
4. **CORS de-dupe** — the external service also returns `Access-Control-Allow-Origin: *`; nginx is the
   single CORS authority, so `proxy_hide_header` strips the upstream's (else browsers reject 2× ACAO).
5. **Upstream TLS verify** — `proxy_ssl_verify on` + `proxy_ssl_trusted_certificate
   /etc/ssl/certs/ca-certificates.crt` (payment hop — authenticate it; the `*.ardrive.io`/Amazon chain
   verifies clean).

**Deriving the payment-prefix list (do NOT guess — this is where gaps hide):** the external service may
expose routes the *local fork doesn't even define* (e.g. `/v1/top-up/payment-intent/…`). Enumerate the
**upstream's** surface and test every family through the proxy:
```bash
# 1. authoritative route list from the upstream itself
curl -s https://payment.ardrive.io/openapi.json | grep -oE '"/[^"]+"\s*:' | tr -d '":' | sort -u
# 2. confirm each family routes to the upstream (cloudfront via-header) at BOTH /v1 and root
for P in /v1/rates /v1/top-up/payment-intent/<addr>/usd/500?token=solana \
         /v1/account/balance/<token>?address=<addr> /account/balance/<token>?address=<addr> \
         /price/<token>/<amt> /x402/top-up ; do
  echo "$P -> $(curl -s "https://turbo.<domain>$P" -D- -o/dev/null | grep -ci cloudfront && echo AWS || echo LOCAL)"
done
```
Note the **root-form asymmetry**: this API serves `/account/*`, `/price/*`, `/x402/top-up` at root, but
`rates`/`balance`/`redeem`/`currencies`/`countries`/`top-up` are **`/v1`-only** (404 at root on AWS too) —
so only the real root routes are added. Verify against the upstream directly before adding any root form.

> **Reload caveat:** `systemctl reload nginx` cycles workers asynchronously — a new `location` can read as
> "not applied" for a second or two while old workers drain. Re-probe after ~3s before concluding a route is
> mis-mapped.

## Logging — per-host access log (added 2026-06-26)

`/etc/nginx/nginx.conf` defines a custom `log_format vhost` and `access_log … vhost`,
extending the standard *combined* format with four fields the default omits:

```
… "$request" $status … host=$host upstream=$upstream_addr ustatus=$upstream_status urt=$upstream_response_time rt=$request_time
```

- **`host=`** — the vhost, so traffic is attributable per endpoint (`turbo.ardrive.io`
  vs `upload.ardrive.io` vs `*.services.ar.io`). The default `combined` format has **no**
  Host field — without this you cannot tell which endpoint a request hit (this gap is
  exactly why per-host turbo traffic was invisible right after its cutover).
- **`upstream=`** — the backend: `127.0.0.1:3001` (upload), `127.0.0.1:4001` (local
  payment), or a **CloudFront IP** for `turbo.ardrive.io`'s payment routes proxied to
  `payment.ardrive.io` (AWS, via `bundler-loc-unified-extpay.conf`). Confirms the
  split-route is actually sending payments to AWS, not the idle local service.
- **`ustatus=` / `urt=` / `rt=`** — upstream status, upstream response time, total request
  time. `urt` on the payment-proxy lines = the live AWS round-trip latency.

Handy queries:
```bash
# traffic by host  (anchored to the real log field: greedy `.*` lands on the LAST
# host=…upstream=, so a `host=` inside a request URL or user-agent can't pollute it)
sed -nE 's/.* host=([^ ]+) upstream=.*/\1/p' /var/log/nginx/access.log | sort | uniq -c | sort -rn
# turbo.ardrive.io payment-proxy latency (upstream is a CloudFront IP, not 127.0.0.1)
grep -E ' host=turbo\.ardrive\.io upstream=' /var/log/nginx/access.log | grep -v 'upstream=127.0.0.1' | grep -oE 'urt=[0-9.]+'
# 5xx by host
grep -E '" 5[0-9][0-9] ' /var/log/nginx/access.log | sed -nE 's/.* host=([^ ]+) upstream=.*/\1/p' | sort | uniq -c | sort -rn
```

> `nginx.conf` is **box-local** (not tracked under `infrastructure/nginx/`, which holds the
> site file + snippets only), so this `log_format` lives only on the box — **re-apply it
> after any nginx reinstall**. Pre-change backup: `/etc/nginx/nginx.conf.bak-logfmt-*`.
