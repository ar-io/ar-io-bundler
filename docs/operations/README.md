# Operations Guide

Production deployment and operations documentation for AR.IO Bundler.

## Deployment

### Production Checklist

Before deploying to production:

- [ ] **Secrets**: Generate strong secrets with `openssl rand -hex 32`
- [ ] **Database**: Configure PostgreSQL with proper credentials and backups
- [ ] **Wallet**: Fund Arweave wallet with sufficient AR for bundle posting
- [ ] **Stripe**: Configure production Stripe keys (if using payments)
- [ ] **Email**: Set up email service for receipts (if using)
- [ ] **SSL/TLS**: Configure certificates for HTTPS
- [ ] **Reverse Proxy**: Set up nginx/Caddy for SSL termination
- [ ] **Monitoring**: Configure logging, metrics, and alerts
- [ ] **Backups**: Set up automated database and wallet backups
- [ ] **Firewall**: Configure security groups/firewall rules
- [ ] **Testing**: Verify all functionality in staging environment

### Deployment Methods

The authoritative production deployment procedure is the
[Hetzner Deployment Runbook](./HETZNER_DEPLOYMENT_RUNBOOK.md). See also
[ADMIN_GUIDE.md](./ADMIN_GUIDE.md) for day-to-day administration. The deployment
section of [ARCHITECTURE.md](../architecture/ARCHITECTURE.md#deployment) covers:
- Docker Compose production setup
- Manual deployment steps
- PM2 configuration
- Reverse proxy examples
- Scaling strategies

(Note: ARCHITECTURE.md is an older snapshot — defer to the runbook and ADMIN_GUIDE
for current specifics.)

## Monitoring

### Health Checks

Both services expose health check endpoints:

```bash
curl http://localhost:3001/v1/info
curl http://localhost:4001/v1/info
```

### Queue Monitoring

Access Bull Board dashboard:
```
http://localhost:3002/admin/queues
```

Monitor:
- Queue depths
- Failed jobs
- Job processing rates
- Worker performance

### Logs

PM2 log locations:
```
/home/vilenarios/ar-io-bundler/logs/
├── payment-service-error.log
├── payment-service-out.log
├── payment-workers-error.log
├── payment-workers-out.log
├── upload-api-error.log
├── upload-api-out.log
├── upload-workers-error.log
├── upload-workers-out.log
├── admin-dashboard-error.log
└── admin-dashboard-out.log
```

View logs:
```bash
pm2 logs                    # All logs
pm2 logs upload-api         # Specific service
tail -f logs/*.log          # Raw log files
```

### Metrics

Prometheus metrics (if enabled):
- HTTP request rates
- Queue depths
- Database connection pools
- Circuit breaker states
- Bundle sizes and counts

## Backups

> **Superseded by [`BACKUP_RESTORE.md`](./BACKUP_RESTORE.md)** — the authoritative architecture (measured
> sizing, encrypted `restic` procedure + systemd timer, pgBackRest/WAL scale path with PITR, restore drill).
> The snippet below is a minimal starting point only. **Do not** mirror MinIO object bytes (permanent on
> Arweave; in-flight re-uploadable) — that advice is obsolete.

### Database Backup Script

Create `/opt/backups/backup.sh`:

```bash
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/backups/postgres"

# Backup upload_service
pg_dump -h localhost -U turbo_admin -d upload_service \
  > $BACKUP_DIR/upload_service_$DATE.sql

# Backup payment_service
pg_dump -h localhost -U turbo_admin -d payment_service \
  > $BACKUP_DIR/payment_service_$DATE.sql

# Compress
gzip $BACKUP_DIR/*.sql

# Remove old backups (30 days)
find $BACKUP_DIR -name "*.sql.gz" -mtime +30 -delete
```

Add to crontab:
```bash
0 2 * * * /opt/backups/backup.sh
```

### Wallet Backup

**Critical**: Back up `wallet.json` securely:
```bash
# Encrypt and store offsite
gpg --encrypt --recipient your@email.com wallet.json
```

### MinIO Backup

Configure MinIO replication or use `mc mirror`:
```bash
mc mirror minio/raw-data-items /backup/minio/raw-data-items
```

## Troubleshooting

### Service Won't Start

1. Check logs: `pm2 logs`
2. Verify environment variables in `.env`
3. Test database connection
4. Verify Redis connectivity
5. Check port availability

### Database Connection Issues

```bash
# Test connection
docker exec -it ar-io-bundler-postgres psql -U turbo_admin -d upload_service

# Check logs
docker compose logs postgres

# Restart database
docker compose restart postgres
```

### Queue Processing Stopped

1. Check Bull Board: http://localhost:3002
2. Restart workers via the scripts (NEVER `pm2 restart` directly): `./scripts/restart.sh`
3. Check Redis: `docker compose logs redis-queues`
4. Review failed jobs for errors

### High Memory Usage

Monitor PM2 processes:
```bash
pm2 monit

# Restart if needed (use the scripts, not `pm2 restart`)
./scripts/restart.sh
```

### Bundle Posting Failures

Check:
1. Arweave wallet balance
2. Gateway connectivity
3. Bundle size limits
4. Network connectivity
5. Retry failed bundles via Bull Board

## Scaling

### Horizontal Scaling

Scale API instances:
```bash
# Set API_INSTANCES in .env, then restart via the scripts
API_INSTANCES=4
./scripts/restart.sh
```

### Database Scaling

- Configure read replicas
- Set `DB_READER_ENDPOINT` for queries
- Keep writes on `DB_WRITER_ENDPOINT`

### Redis Scaling

For high volume:
- Enable Redis cluster mode
- Set `ELASTICACHE_NO_CLUSTERING=false`
- Configure multiple Redis instances

## Security

### Firewall Rules

| Port | Service | Access |
|------|---------|--------|
| 3001 | Upload API | Public |
| 4001 | Payment API | Public |
| 3002 | Admin Dashboard (Bull Board) | Admin only |
| 5432 | PostgreSQL | Internal only |
| 6379 | Redis Cache | Internal only |
| 6381 | Redis Queues | Internal only |
| 9000 | MinIO API | Internal only |
| 9001 | MinIO Console | Admin only |

### SSL/TLS

Production must use HTTPS. Example nginx config:

```nginx
server {
    listen 443 ssl http2;
    server_name upload.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3001;
        client_max_body_size 10G;
    }
}
```

## Maintenance

### Update Procedure

1. Backup database
2. Pull latest code
3. Install dependencies: `yarn install`
4. Run migrations (if any): `yarn db:migrate`
5. Build + rolling-reload with **no client-facing outage**: `./scripts/deploy.sh`
   - `deploy.sh` builds payment+upload, then `pm2 reload`s the cluster APIs one instance
     at a time (socket stays bound — nginx never sees a refused connection) and restarts
     the fork workers (BullMQ jobs persist in Redis and resume). `--update-env` re-reads `.env`.
   - Run as the pm2 daemon owner; zero-downtime needs `API_INSTANCES` ≥ 2.
   - NEVER `pm2 restart`/`pm2 reload` directly. For **first boot / infra down** use
     `./scripts/start.sh`; for a deliberate full hard cycle use `./scripts/restart.sh` (brief outage).
6. Verify: `./scripts/verify.sh` (deploy.sh also runs its own post-reload health gate)

### Log Rotation

Configure logrotate for PM2 logs:

```
/home/vilenarios/ar-io-bundler/logs/*.log {
    daily
    rotate 30
    compress
    delaycompress
    notifempty
    create 0640 vilenarios vilenarios
    sharedscripts
}
```

## Further Reading

- [Architecture Documentation](../architecture/ARCHITECTURE.md)
- [API Reference](../api/README.md)
- [Setup Guide](../setup/README.md)
