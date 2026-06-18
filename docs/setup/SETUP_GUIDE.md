# AR.IO Bundler Setup Guide

This guide walks you through setting up the AR.IO Bundler using the interactive setup wizard.

## Quick Start

```bash
./scripts/setup-bundler.sh
```

The setup wizard will guide you through configuring all required and optional settings for your bundler.

## What You'll Need

Before running the setup script, gather the following information:

### Required

1. **Arweave Wallet** - JWK file for signing bundles
   - Generate at: https://arweave.app/add-wallet
   - Or use existing wallet

2. **Database Credentials** - PostgreSQL connection details
   - Host, port, username, password
   - Two databases will be created: `payment_service` and `upload_service`

3. **Payment Address** - Arweave wallet address where you'll receive payments
   - Must be valid 43-character base64url address

### Optional

4. **Additional Payment Addresses** - For accepting other cryptocurrencies
   - Ethereum (0x...)
   - Solana (base58)
   - Polygon/MATIC (0x...)
   - Base (0x...)
   - KYVE (kyve1...)

5. **Stripe Integration** - For credit card payments
   - Secret key (sk_...)
   - Webhook secret (whsec_...)
   - Get keys at: https://dashboard.stripe.com/apikeys

6. **AR.IO Gateway Integration** - For optical bridging
   - Gateway optical bridge URL
   - Admin API key

7. **x402 Payment Protocol** - For USDC payments
   - Network selection (base-mainnet, base-sepolia, etc.)
   - USDC contract address (auto-configured based on network)

## Setup Wizard Flow

The setup wizard walks you through 16 steps:

### 1. Environment Configuration
- Choose development or production mode
- Affects defaults and required fields

### 2. Database Configuration
- PostgreSQL host, port, username, password
- Validates port numbers
- Same credentials used for both databases (different names)

### 3. Arweave Wallet Configuration
- Path to main wallet JWK file (absolute path required!)
- Optional: Raw data item wallet (for raw uploads)
- Validates wallet files exist

### 4. Payment Addresses
- Configure blockchain addresses for receiving payments
- Validates address formats
- Required: Arweave
- Optional: Ethereum, Solana, Polygon, Base, KYVE

### 5. Gateway Configuration
- Primary Arweave gateway URL
- Public-facing gateway URLs (comma-separated)
- Public access gateway
- Validates URL formats

### 6. Service Ports and URLs
- Payment service port (default: 4001)
- Upload service port (default: 3001)
- Inter-service communication URL
- Public upload service URL
- Validates ports and checks for conflicts

### 7. Storage Configuration
- MinIO (local development) or AWS S3
- S3 endpoint, region, credentials
- Bucket names for raw data and backups

### 8. Redis Configuration
- Redis host
- Cache port (default: 6379)
- Queue port (default: 6381)

### 9. Security Configuration
- Auto-generates PRIVATE_ROUTE_SECRET (64-character hex)
- Option to customize in production

### 10. Stripe Integration (Optional)
- Secret key
- Webhook secret
- Can be skipped (placeholder key used)

### 11. AR.IO Gateway Integration (Optional)
- Optical bridge URL
- Admin API key
- Enables direct posting to local gateway

### 12. x402 Payment Protocol (Optional)
- Network selection
- Auto-configures USDC contract address
- Enables USDC payments via EIP-3009

### 13. Additional Settings
- Application name (shown in bundle tags)
- Free upload limit in bytes
- Allow list (comma-separated addresses for free uploads)

### 14. Generate .env File
- Creates complete .env file
- Backs up existing .env if present
- Sets proper file permissions (600)

### 15. Configuration Summary
- Review all configured settings
- Shows payment addresses
- Shows optional feature status

### 16. Next Steps
- Optional: Test database connectivity
- Optional: Run database migrations
- Optional: Start services

## Features & Guardrails

### Validation
- **URL format** - Must start with http:// or https://
- **Port numbers** - Must be 1-65535, checks for conflicts
- **File paths** - Validates wallet files exist
- **Blockchain addresses** - Format validation for each chain
  - Arweave: 43 chars, base64url
  - Ethereum/Polygon/Base: 0x + 40 hex chars
  - Solana: 32-44 chars, base58

### User Experience
- **Color-coded output** - Success (green), warnings (yellow), errors (red)
- **Clear prompts** - Descriptions for each setting
- **Sensible defaults** - Most settings have reasonable defaults
- **Skip options** - All optional integrations can be skipped
- **Confirmation dialogs** - Safety checks before overwriting files
- **Progress indicators** - Clear section headers and progress

### Safety
- **Backup existing .env** - Timestamped backups before overwriting
- **Secret generation** - Cryptographically secure random secrets
- **File permissions** - .env set to 600 (owner read/write only)
- **Validation loops** - Retry invalid inputs with helpful error messages
- **Required fields** - Cannot proceed without required configurations

### Testing
- **Database connectivity** - Optional psql connection test
- **Service startup** - Optional automatic service launch
- **Migration support** - Optional database migration execution

## Example Session

```bash
$ ./scripts/setup-bundler.sh

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚀 AR.IO Bundler Setup Wizard
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Welcome to the AR.IO Bundler setup wizard!
This script will guide you through configuring your bundler.

You'll be prompted for:
  • Environment settings (development/production)
  • Database credentials
  • Arweave wallet configuration
  • Payment addresses for supported blockchains
  • Gateway URLs
  • Service ports and URLs
  • Storage configuration (MinIO/S3)
  • Optional integrations (Stripe, AR.IO Gateway, x402)

⚠ Existing .env file found at: /path/to/.env
Do you want to back it up before continuing? [Y/n]: y
✓ Backup created: /path/to/.env.backup.20251029_153000

Ready to begin setup? [Y/n]: y

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Environment Configuration
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Select your environment type:
  development - For local development and testing
  production  - For production deployment

1) development
2) production
#? 1
✓ Environment set to: development

[... continues through all 16 steps ...]
```

## After Setup

Once setup is complete, you'll have:

1. **Complete .env file** - All configuration in one place
2. **Backup of old .env** - If one existed (timestamped)
3. **Ready to run** - Services can be started immediately

### Next Commands

```bash
# Install dependencies (if not done)
yarn install

# Build services
yarn build

# Start infrastructure (PostgreSQL, Redis, MinIO)
docker compose up -d

# Run database migrations
yarn db:migrate:latest

# Start all services
./scripts/start.sh

# Verify system health
./scripts/verify.sh
```

## Service URLs

After starting services:

- **Payment Service**: http://localhost:4001
- **Upload Service**: http://localhost:3001
- **Bull Board** (queue monitoring): http://localhost:3002/admin/queues
- **MinIO Console**: http://localhost:9001 (minioadmin/minioadmin)

## Troubleshooting

### "Wallet file not found"
- Ensure you're using an **absolute path**, not relative
- Example: `/home/user/ar-io-bundler/wallet.json`
- Not: `./wallet.json`

### "Invalid Arweave address"
- Must be exactly 43 characters
- Only contains: A-Z, a-z, 0-9, _, -
- Get address from wallet: `jq -r '.n' wallet.json | base64 -w0 | tr '+/' '-_' | tr -d '='`

### "Port already in use"
- Payment and upload services must use different ports
- Check with: `netstat -tulpn | grep :4001`

### "Database connection failed"
- Verify PostgreSQL is running: `docker compose ps postgres`
- Test connection: `psql -h localhost -p 5432 -U turbo_admin -d postgres`
- Check credentials match your database

### "PAYMENT_SERVICE_BASE_URL has http://"
- Do NOT include protocol prefix
- ✓ Correct: `localhost:4001`
- ✗ Wrong: `http://localhost:4001`

## Re-running Setup

You can run the setup script multiple times:

1. It will backup your existing .env
2. You can change any settings
3. Previous values are not retained between runs

To preserve some settings while changing others, either:
- Edit .env manually after setup
- Or: Run setup, skip unwanted prompts, manually restore from backup

## Manual Configuration

If you prefer to configure manually:

1. Copy template: `cp .env.sample .env`
2. Edit: `nano .env`
3. Follow comments in .env.sample for guidance

The setup wizard is recommended for initial setup to ensure all required fields are populated correctly.

## Advanced: Non-Interactive Setup

For automated deployments, you can:

1. Pre-create .env file from template
2. Skip the setup wizard
3. Use environment variables or secrets management

The setup wizard is primarily for interactive initial configuration.

## Support

For issues or questions:
- Review: `CLAUDE.md` for architecture overview
- Check: `packages/payment-service/CLAUDE.md`
- Check: `packages/upload-service/CLAUDE.md`
- Visit: https://github.com/ar-io/ar-io-bundler

## Security Notes

- Never commit .env files to git (already in .gitignore)
- Keep wallet JWK files secure and backed up
- Use strong database passwords in production
- Rotate PRIVATE_ROUTE_SECRET periodically
- Secure Redis and MinIO in production (passwords, firewalls)
- Use HTTPS for all public-facing URLs in production
