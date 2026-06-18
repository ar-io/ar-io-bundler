# Setup Guide

Get started with AR.IO Bundler development and deployment.

## Quick Start

### Prerequisites

- **Node.js** 22 (required; .nvmrc v22.22.0) (recommended: use [nvm](https://github.com/nvm-sh/nvm))
- **Yarn** 3.6.0+
- **Docker** & Docker Compose
- **Git**

### Installation

```bash
# Clone repository
git clone https://github.com/ar-io/ar-io-bundler.git
cd ar-io-bundler

# Install dependencies
yarn install

# Copy environment template
cp packages/upload-service/.env.sample packages/upload-service/.env

# Edit configuration
nano packages/upload-service/.env
```

### Required Configuration

Edit `.env` and set at minimum:

```bash
# Arweave Wallet (REQUIRED)
TURBO_JWK_FILE=./wallet.json

# Inter-service Secret (REQUIRED)
PRIVATE_ROUTE_SECRET=$(openssl rand -hex 32)

# Database (uses defaults if not specified)
DB_PASSWORD=postgres
```

### Start Infrastructure

```bash
# Start PostgreSQL, Redis, MinIO
docker compose up -d

# Run database migrations
yarn db:migrate
```

### Build and Run

```bash
# Build services
yarn build

# Start with PM2
pm2 start infrastructure/pm2/ecosystem.config.js

# View logs
pm2 logs

# Monitor
pm2 monit
```

### Verify Installation

```bash
# Check services
curl http://localhost:3001/v1/info  # Upload service
curl http://localhost:4001/v1/info  # Payment service

# View queue dashboard
open http://localhost:3002/admin/queues
```

## Development Mode

For active development with hot reload:

```bash
# Terminal 1: Upload API
cd packages/upload-service
yarn start:watch

# Terminal 2: Payment API
cd packages/payment-service
yarn start:watch

# Terminal 3: Workers
cd packages/upload-service
yarn nodemon lib/workers/allWorkers.js
```

## Detailed Guides

- **[Architecture](../architecture/ARCHITECTURE.md#development)** - Development workflow details
- **[Configuration](../architecture/ARCHITECTURE.md#configuration)** - All environment variables
- **[API Reference](../api/README.md)** - API endpoints and usage

## Common Issues

### Port Already in Use

Check if ports are available:
```bash
lsof -i :3001  # Upload service
lsof -i :4001  # Payment service
lsof -i :5432  # PostgreSQL
```

### Database Connection Failed

Ensure PostgreSQL is running:
```bash
docker compose ps postgres
docker compose logs postgres
```

### Missing Wallet

You need an Arweave wallet (JWK) file:
```bash
# Option 1: Generate new wallet (NOT FUNDED)
# Use Arweave wallet generator

# Option 2: Use existing wallet
cp /path/to/wallet.json ./wallet.json
```

### Migrations Failed

Reset and re-run migrations:
```bash
# Rollback all
yarn workspace @ar-io-bundler/upload-service db:migrate:rollback --all

# Re-run
yarn db:migrate
```

## Next Steps

- [Configuration Reference](../architecture/ARCHITECTURE.md#configuration)
- [API Documentation](../api/README.md)
- [Deployment Guide](../operations/)
- [Architecture Overview](../architecture/ARCHITECTURE.md)

## Support

- [GitHub Issues](https://github.com/ar-io/ar-io-bundler/issues)
- [Main Documentation](../README.md)
