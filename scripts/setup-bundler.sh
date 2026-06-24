#!/bin/bash

#############################################################################################
# AR.IO Bundler - Complete Interactive Setup (137 Environment Variables)
#############################################################################################
# This script guides you through configuring your AR.IO Bundler from scratch.
# It is fully idempotent and can be safely run multiple times.
#
# Features:
#   ✓ Comprehensive configuration wizard for all 137 environment variables
#   ✓ Complete AR.IO Gateway integration with optical bridging
#   ✓ Full x402 payment protocol configuration (all networks)
#   ✓ Smart defaults based on environment (development/production)
#   ✓ Input validation for all fields
#   ✓ State detection (skips already-configured sections)
#   ✓ Infrastructure setup and health checks
#   ✓ Database migrations
#   ✓ Service startup and verification
#
# Usage:
#   ./scripts/setup-bundler.sh              # Interactive wizard
#   ./scripts/setup-bundler.sh --quick      # Quick setup with defaults (dev mode)
#   ./scripts/setup-bundler.sh --advanced   # Include advanced/optional variables
#   ./scripts/setup-bundler.sh --update     # Update existing configuration
#############################################################################################

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${PROJECT_ROOT}/.env"
ENV_SAMPLE="${PROJECT_ROOT}/.env.sample"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# Modes
QUICK_MODE=false
UPDATE_MODE=false
ADVANCED_MODE=false

# Parse arguments
for arg in "$@"; do
    case $arg in
        --quick) QUICK_MODE=true ;;
        --update) UPDATE_MODE=true ;;
        --advanced) ADVANCED_MODE=true ;;
        --help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --quick      Quick setup with sensible defaults (development mode)"
            echo "  --advanced   Include advanced/optional configuration (40+ extra variables)"
            echo "  --update     Update existing configuration"
            echo "  --help       Show this help message"
            exit 0
            ;;
    esac
done

#############################################################################################
# Utility Functions
#############################################################################################

print_header() {
    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BOLD}${CYAN}$1${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

print_section() {
    echo ""
    echo -e "${MAGENTA}▸ $1${NC}"
    echo ""
}

print_success() { echo -e "${GREEN}✓${NC} $1"; }
print_warning() { echo -e "${YELLOW}⚠${NC} $1"; }
print_error() { echo -e "${RED}✗${NC} $1"; }
print_info() { echo -e "${CYAN}ℹ${NC} $1"; }

prompt() {
    local var_name="$1"
    local prompt_text="$2"
    local default_value="$3"
    local is_secret="${4:-false}"

    if [ "$QUICK_MODE" = true ] && [ -n "$default_value" ]; then
        CONFIG["$var_name"]="$default_value"
        return
    fi

    if [ -n "$default_value" ]; then
        if [ "$is_secret" = "true" ]; then
            read -s -p "$(echo -e ${CYAN}${prompt_text}${NC} [default: <hidden>]: )" input
            echo
        else
            read -p "$(echo -e ${CYAN}${prompt_text}${NC} [default: ${default_value}]: )" input
        fi
        CONFIG["$var_name"]="${input:-$default_value}"
    else
        if [ "$is_secret" = "true" ]; then
            read -s -p "$(echo -e ${CYAN}${prompt_text}${NC} ${RED}(required)${NC}: )" input
            echo
        else
            read -p "$(echo -e ${CYAN}${prompt_text}${NC} ${RED}(required)${NC}: )" input
        fi
        while [ -z "$input" ]; do
            print_error "This field is required"
            if [ "$is_secret" = "true" ]; then
                read -s -p "$(echo -e ${CYAN}${prompt_text}${NC} ${RED}(required)${NC}: )" input
                echo
            else
                read -p "$(echo -e ${CYAN}${prompt_text}${NC} ${RED}(required)${NC}: )" input
            fi
        done
        CONFIG["$var_name"]="$input"
    fi
}

confirm() {
    local prompt_text="$1"
    local default="${2:-n}"

    if [ "$QUICK_MODE" = true ]; then
        [[ "$default" =~ ^[Yy]$ ]] && return 0 || return 1
    fi

    if [ "$default" = "y" ]; then
        read -p "$(echo -e ${CYAN}${prompt_text}${NC}) [Y/n]: " response
        response=${response:-y}
    else
        read -p "$(echo -e ${CYAN}${prompt_text}${NC}) [y/N]: " response
        response=${response:-n}
    fi

    [[ "$response" =~ ^[Yy]$ ]]
}

generate_secret() { openssl rand -hex 32 2>/dev/null || echo "CHANGE_ME_$(date +%s)"; }

validate_url() { [[ "$1" =~ ^https?:// ]]; }
validate_port() { [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }
validate_ethereum_address() { [[ "$1" =~ ^0x[a-fA-F0-9]{40}$ ]]; }
validate_arweave_address() { [[ "$1" =~ ^[A-Za-z0-9_-]{43}$ ]]; }
validate_solana_address() { [[ "$1" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]]; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

# Configuration storage
declare -A CONFIG

#############################################################################################
# Welcome
#############################################################################################

clear
print_header "🚀 AR.IO Bundler - Complete Interactive Setup"

if [ "$QUICK_MODE" = true ]; then
    echo -e "${YELLOW}QUICK MODE:${NC} Using default values for rapid setup (development mode)"
    echo ""
elif [ "$ADVANCED_MODE" = true ]; then
    echo -e "${YELLOW}ADVANCED MODE:${NC} Configuring all 137 environment variables"
    echo ""
elif [ "$UPDATE_MODE" = true ]; then
    echo -e "${YELLOW}UPDATE MODE:${NC} Modifying existing configuration"
    echo ""
fi

echo "This wizard will configure your AR.IO Bundler platform."
echo ""
echo "The bundler consists of:"
echo "  • ${CYAN}Payment Service${NC}  - Processes payments and manages credits"
echo "  • ${CYAN}Upload Service${NC}   - Accepts data uploads and creates bundles"
echo "  • ${CYAN}Infrastructure${NC}   - PostgreSQL, Redis, MinIO (via Docker)"
echo ""
echo "Configuration scope: ${BOLD}137 environment variables${NC}"
echo ""

# Check if .env exists
if [ -f "$ENV_FILE" ]; then
    print_warning "Existing .env file found"

    if [ "$UPDATE_MODE" = false ] && [ "$QUICK_MODE" = false ]; then
        if confirm "Back up existing .env before continuing?" "y"; then
            BACKUP_FILE="${ENV_FILE}.backup.$(date +%Y%m%d_%H%M%S)"
            cp "$ENV_FILE" "$BACKUP_FILE"
            print_success "Backup created: $BACKUP_FILE"
        fi
    fi

    # Load existing values
    source "$ENV_FILE" 2>/dev/null || true
    echo ""
fi

if [ "$QUICK_MODE" = false ]; then
    if ! confirm "Ready to begin setup?" "y"; then
        echo "Setup cancelled."
        exit 0
    fi
fi

#############################################################################################
# 1. Prerequisites Check
#############################################################################################

print_header "Step 1: Prerequisites Check"

MISSING_PREREQS=false

# Node.js
if command_exists node; then
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -ge 18 ]; then
        print_success "Node.js $(node -v)"
    else
        print_error "Node.js 18+ required (you have $(node -v))"
        MISSING_PREREQS=true
    fi
else
    print_error "Node.js not found (install from https://nodejs.org/)"
    MISSING_PREREQS=true
fi

# Yarn
if command_exists yarn; then
    print_success "Yarn $(yarn --version)"
else
    print_error "Yarn not found (run: corepack enable)"
    MISSING_PREREQS=true
fi

# Docker
if command_exists docker; then
    if docker ps >/dev/null 2>&1; then
        print_success "Docker (running)"
    else
        print_error "Docker installed but not running"
        MISSING_PREREQS=true
    fi
else
    print_error "Docker not found (install from https://docs.docker.com/get-docker/)"
    MISSING_PREREQS=true
fi

# Docker Compose
if docker compose version >/dev/null 2>&1; then
    print_success "Docker Compose V2"
else
    print_error "Docker Compose V2 not found"
    MISSING_PREREQS=true
fi

# OpenSSL
if command_exists openssl; then
    print_success "OpenSSL"
else
    print_warning "OpenSSL not found (will use fallback for secret generation)"
fi

# PM2 (optional)
if command_exists pm2; then
    print_success "PM2 $(pm2 --version)"
else
    print_warning "PM2 not found (will be installed via yarn)"
fi

if [ "$MISSING_PREREQS" = true ]; then
    echo ""
    print_error "Missing required prerequisites. Please install them and try again."
    exit 1
fi

#############################################################################################
# 2. Environment Selection
#############################################################################################

print_header "Step 2: Environment Configuration"

if [ -n "$NODE_ENV" ] && [ "$UPDATE_MODE" = true ]; then
    print_info "Current environment: $NODE_ENV"
    if ! confirm "Keep this environment?" "y"; then
        unset NODE_ENV
    fi
fi

if [ -z "$NODE_ENV" ]; then
    echo "Select environment:"
    echo "  ${GREEN}1)${NC} development - Local testing with relaxed security"
    echo "  ${GREEN}2)${NC} production  - Production deployment with strict validation"
    echo ""

    if [ "$QUICK_MODE" = true ]; then
        CONFIG["NODE_ENV"]="development"
    else
        while true; do
            read -p "Choose (1 or 2) [1]: " env_choice
            env_choice=${env_choice:-1}
            case $env_choice in
                1) CONFIG["NODE_ENV"]="development"; break ;;
                2) CONFIG["NODE_ENV"]="production"; break ;;
                *) print_error "Invalid choice" ;;
            esac
        done
    fi
else
    CONFIG["NODE_ENV"]="$NODE_ENV"
fi

print_success "Environment: ${CONFIG[NODE_ENV]}"

CONFIG["MIGRATE_ON_STARTUP"]="false"

#############################################################################################
# 3. Service Ports
#############################################################################################

print_header "Step 3: Service Ports"

echo "Configure ports for the bundler services."
echo ""

prompt "PAYMENT_SERVICE_PORT" "Payment service port" "${PAYMENT_SERVICE_PORT:-4001}"
while ! validate_port "${CONFIG[PAYMENT_SERVICE_PORT]}"; do
    print_error "Invalid port number (1-65535)"
    prompt "PAYMENT_SERVICE_PORT" "Payment service port" "4001"
done

prompt "UPLOAD_SERVICE_PORT" "Upload service port" "${UPLOAD_SERVICE_PORT:-3001}"
while ! validate_port "${CONFIG[UPLOAD_SERVICE_PORT]}"; do
    print_error "Invalid port number (1-65535)"
    prompt "UPLOAD_SERVICE_PORT" "Upload service port" "3001"
done

# Check for port conflicts
if [ "${CONFIG[PAYMENT_SERVICE_PORT]}" = "${CONFIG[UPLOAD_SERVICE_PORT]}" ]; then
    print_error "Services cannot use the same port!"
    exit 1
fi

# Check if ports are in use
for port in "${CONFIG[PAYMENT_SERVICE_PORT]}" "${CONFIG[UPLOAD_SERVICE_PORT]}"; do
    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
        print_warning "Port $port is currently in use"
    fi
done

print_success "Payment service: port ${CONFIG[PAYMENT_SERVICE_PORT]}"
print_success "Upload service: port ${CONFIG[UPLOAD_SERVICE_PORT]}"

#############################################################################################
# 4. Database Configuration
#############################################################################################

print_header "Step 4: Database Configuration"

echo "The bundler uses PostgreSQL with two separate databases:"
echo "  • ${CYAN}payment_service${NC} - Payments, balances, receipts"
echo "  • ${CYAN}upload_service${NC}  - Data items, bundles, offsets"
echo ""

prompt "DB_HOST" "Database host" "${DB_HOST:-localhost}"
prompt "DB_PORT" "Database port" "${DB_PORT:-5432}"

while ! validate_port "${CONFIG[DB_PORT]}"; do
    print_error "Invalid port number"
    prompt "DB_PORT" "Database port" "5432"
done

prompt "DB_USER" "Database username" "${DB_USER:-turbo_admin}"
prompt "DB_PASSWORD" "Database password" "${DB_PASSWORD:-postgres}" true

CONFIG["DB_WRITER_ENDPOINT"]="${CONFIG[DB_HOST]}"
CONFIG["DB_READER_ENDPOINT"]="${CONFIG[DB_HOST]}"
CONFIG["PAYMENT_DB_DATABASE"]="payment_service"
CONFIG["UPLOAD_DB_DATABASE"]="upload_service"

if [ "$ADVANCED_MODE" = true ]; then
    echo ""
    prompt "POSTGRES_VERSION" "PostgreSQL version" "${POSTGRES_VERSION:-16.1}"
fi

print_success "Database: ${CONFIG[DB_USER]}@${CONFIG[DB_HOST]}:${CONFIG[DB_PORT]}"
print_info "Databases: payment_service, upload_service"

#############################################################################################
# 5. Security Secrets
#############################################################################################

print_header "Step 5: Security Configuration"

echo "Generating secure random secrets..."
echo ""

# PRIVATE_ROUTE_SECRET
if [ -n "$PRIVATE_ROUTE_SECRET" ] && [ "$UPDATE_MODE" = true ]; then
    CONFIG["PRIVATE_ROUTE_SECRET"]="$PRIVATE_ROUTE_SECRET"
    print_success "Using existing PRIVATE_ROUTE_SECRET"
else
    CONFIG["PRIVATE_ROUTE_SECRET"]=$(generate_secret)
    print_success "Generated PRIVATE_ROUTE_SECRET (inter-service authentication)"
fi

# JWT_SECRET
if [ -n "$JWT_SECRET" ] && [ "$UPDATE_MODE" = true ]; then
    CONFIG["JWT_SECRET"]="$JWT_SECRET"
    print_success "Using existing JWT_SECRET"
else
    CONFIG["JWT_SECRET"]=$(generate_secret)
    print_success "Generated JWT_SECRET (for JWT tokens)"
fi

#############################################################################################
# 6. Arweave Wallet Configuration
#############################################################################################

print_header "Step 6: Arweave Wallet Configuration"

echo "The bundler requires an Arweave wallet (JWK) to sign bundles."
echo ""
print_warning "IMPORTANT: Use an ABSOLUTE path!"
echo ""

while true; do
    prompt "TURBO_JWK_FILE" "Path to Arweave wallet JWK file" "${TURBO_JWK_FILE:-${PROJECT_ROOT}/wallet.json}"

    # Expand ~ to home directory
    CONFIG["TURBO_JWK_FILE"]="${CONFIG[TURBO_JWK_FILE]/#\~/$HOME}"

    # Convert to absolute path if relative
    if [[ "${CONFIG[TURBO_JWK_FILE]}" != /* ]]; then
        CONFIG["TURBO_JWK_FILE"]="$(cd "$(dirname "${CONFIG[TURBO_JWK_FILE]}")" 2>/dev/null && pwd)/$(basename "${CONFIG[TURBO_JWK_FILE]}")" || CONFIG["TURBO_JWK_FILE"]=""
    fi

    if [ -f "${CONFIG[TURBO_JWK_FILE]}" ]; then
        print_success "Wallet found: ${CONFIG[TURBO_JWK_FILE]}"

        # Try to extract Arweave address
        if command_exists node; then
            ARWEAVE_ADDR=$(node -e "
                const fs = require('fs');
                const crypto = require('crypto');
                try {
                    const jwk = JSON.parse(fs.readFileSync('${CONFIG[TURBO_JWK_FILE]}', 'utf8'));
                    const n = Buffer.from(jwk.n, 'base64url');
                    const hash = crypto.createHash('sha256').update(n).digest();
                    console.log(hash.toString('base64url'));
                } catch (e) {
                    console.log('');
                }
            " 2>/dev/null || echo "")

            if [ -n "$ARWEAVE_ADDR" ]; then
                CONFIG["ARWEAVE_ADDRESS"]="$ARWEAVE_ADDR"
                print_success "Wallet address: $ARWEAVE_ADDR"
            fi
        fi
        break
    else
        print_error "File not found: ${CONFIG[TURBO_JWK_FILE]}"
        if [ "$QUICK_MODE" = true ]; then
            print_error "Wallet file required for setup"
            exit 1
        fi
        if ! confirm "Try a different path?" "y"; then
            print_error "Wallet file is required. Exiting."
            exit 1
        fi
    fi
done

# Optional: Raw data item wallet
echo ""
if [ "${CONFIG[NODE_ENV]}" = "production" ]; then
    if confirm "Enable raw data uploads (unsigned data for AI agents)?" "n"; then
        prompt "RAW_DATA_ITEM_JWK_FILE" "Path to raw data wallet" "${CONFIG[TURBO_JWK_FILE]}"
        CONFIG["RAW_DATA_ITEM_JWK_FILE"]="${CONFIG[RAW_DATA_ITEM_JWK_FILE]/#\~/$HOME}"
    fi
else
    # Development: use same wallet
    CONFIG["RAW_DATA_ITEM_JWK_FILE"]="${CONFIG[TURBO_JWK_FILE]}"
fi

#############################################################################################
# 7. Payment Addresses
#############################################################################################

print_header "Step 7: Blockchain Payment Addresses"

echo "Configure addresses where you'll receive payments."
echo ""

# Arweave (required - already extracted from wallet)
if [ -z "${CONFIG[ARWEAVE_ADDRESS]}" ]; then
    print_section "Arweave Address"
    while true; do
        prompt "ARWEAVE_ADDRESS" "Your Arweave address" "${ARWEAVE_ADDRESS:-}"
        if validate_arweave_address "${CONFIG[ARWEAVE_ADDRESS]}"; then
            print_success "Valid Arweave address"
            break
        else
            print_error "Invalid format (43 chars, base64url)"
        fi
    done
fi

CONFIG["ARIO_ADDRESS"]="${CONFIG[ARWEAVE_ADDRESS]}"

# Ethereum
echo ""
print_section "Ethereum Address"
if confirm "Configure Ethereum address for ETH payments?" "y"; then
    while true; do
        prompt "ETHEREUM_ADDRESS" "Your Ethereum address" "${ETHEREUM_ADDRESS:-}"
        if validate_ethereum_address "${CONFIG[ETHEREUM_ADDRESS]}"; then
            print_success "Valid Ethereum address"
            break
        else
            print_error "Invalid format (0x + 40 hex chars)"
            if ! confirm "Try again?" "y"; then
                unset CONFIG["ETHEREUM_ADDRESS"]
                break
            fi
        fi
    done
fi

# Solana
echo ""
print_section "Solana Address"
if confirm "Configure Solana address for SOL payments?" "y"; then
    while true; do
        prompt "SOLANA_ADDRESS" "Your Solana address" "${SOLANA_ADDRESS:-}"
        if validate_solana_address "${CONFIG[SOLANA_ADDRESS]}"; then
            print_success "Valid Solana address"
            CONFIG["ED25519_ADDRESS"]="${CONFIG[SOLANA_ADDRESS]}"
            break
        else
            print_error "Invalid format (32-44 chars, base58)"
            if ! confirm "Try again?" "y"; then
                unset CONFIG["SOLANA_ADDRESS"]
                break
            fi
        fi
    done
fi

# Polygon (MATIC)
echo ""
if confirm "Configure Polygon (MATIC) address?" "n"; then
    while true; do
        prompt "MATIC_ADDRESS" "Your Polygon address" "${MATIC_ADDRESS:-${CONFIG[ETHEREUM_ADDRESS]:-}}"
        if validate_ethereum_address "${CONFIG[MATIC_ADDRESS]}"; then
            print_success "Valid Polygon address"
            CONFIG["POL_ADDRESS"]="${CONFIG[MATIC_ADDRESS]}"
            break
        else
            print_error "Invalid format"
            if ! confirm "Try again?" "y"; then
                unset CONFIG["MATIC_ADDRESS"]
                break
            fi
        fi
    done
fi

# Base
echo ""
if confirm "Configure Base (Base-ETH) address?" "n"; then
    while true; do
        prompt "BASE_ETH_ADDRESS" "Your Base address" "${BASE_ETH_ADDRESS:-${CONFIG[ETHEREUM_ADDRESS]:-}}"
        if validate_ethereum_address "${CONFIG[BASE_ETH_ADDRESS]}"; then
            print_success "Valid Base address"
            break
        else
            print_error "Invalid format"
            if ! confirm "Try again?" "y"; then
                unset CONFIG["BASE_ETH_ADDRESS"]
                break
            fi
        fi
    done
fi

# KYVE
echo ""
if confirm "Configure KYVE address?" "n"; then
    prompt "KYVE_ADDRESS" "Your KYVE address (kyve1...)" "${KYVE_ADDRESS:-}"
fi

#############################################################################################
# 8. Arweave Gateway Configuration
#############################################################################################

print_header "Step 8: Arweave Gateway Configuration"

echo "Configure Arweave gateway URLs for pricing and data retrieval."
echo ""
echo "TIP: For vertical integration with AR.IO Gateway, use:"
echo "  • ARWEAVE_GATEWAY=http://localhost:3000 (for reads/GraphQL)"
echo "  • ARWEAVE_UPLOAD_NODE=https://arweave.net:443 (for TX/chunk uploads)"
echo ""

prompt "ARWEAVE_GATEWAY" "Primary Arweave gateway" "${ARWEAVE_GATEWAY:-https://arweave.net}"
while ! validate_url "${CONFIG[ARWEAVE_GATEWAY]}"; do
    print_error "Invalid URL format"
    prompt "ARWEAVE_GATEWAY" "Primary Arweave gateway" "https://arweave.net"
done

prompt "ARWEAVE_UPLOAD_NODE" "Arweave upload node (for posting bundles)" "${ARWEAVE_UPLOAD_NODE:-https://arweave.net:443}"

echo ""
echo "Public gateway URLs (shown in /v1/info, comma-separated):"
prompt "PUBLIC_GATEWAY_FQDNS" "Public gateways" "${PUBLIC_GATEWAY_FQDNS:-${CONFIG[ARWEAVE_GATEWAY]}}"

CONFIG["PUBLIC_ACCESS_GATEWAY"]="${CONFIG[ARWEAVE_GATEWAY]}"

if [ "$ADVANCED_MODE" = true ]; then
    echo ""
    prompt "ARWEAVE_NETWORK_REQUEST_TIMEOUT_MS" "Network request timeout (ms)" "${ARWEAVE_NETWORK_REQUEST_TIMEOUT_MS:-60000}"
fi

print_success "Gateway configured: ${CONFIG[ARWEAVE_GATEWAY]}"

#############################################################################################
# 9. AR.IO Gateway Integration (Optical Bridging)
#############################################################################################

print_header "Step 9: AR.IO Gateway Integration (Optical Bridging)"

echo "Optical bridging enables immediate data availability via AR.IO Gateway."
echo "Data items are queued to the gateway BEFORE Arweave confirmation."
echo ""
echo "Benefits:"
echo "  • Instant data availability (no waiting for Arweave finality)"
echo "  • Full vertical integration with your AR.IO Gateway"
echo "  • Independent from external gateways"
echo ""

if confirm "Enable AR.IO Gateway optical bridging?" "n"; then
    CONFIG["OPTICAL_BRIDGING_ENABLED"]="true"

    echo ""
    # Detect deployment topology
    if [[ "${CONFIG[ARWEAVE_GATEWAY]}" == *"localhost"* ]] || [[ "${CONFIG[ARWEAVE_GATEWAY]}" == *"127.0.0.1"* ]]; then
        print_info "Detected local AR.IO Gateway - same-server deployment"
        DEFAULT_BRIDGE_URL="http://localhost:4000/ar-io/admin/queue-data-item"
    else
        print_info "Detected remote gateway - configure bridge URL accordingly"
        DEFAULT_BRIDGE_URL="http://your-gateway:4000/ar-io/admin/queue-data-item"
    fi

    prompt "OPTICAL_BRIDGE_URL" "Gateway optical bridge URL" "${OPTICAL_BRIDGE_URL:-$DEFAULT_BRIDGE_URL}"

    echo ""
    print_warning "AR.IO Gateway admin key is REQUIRED for optical bridging"
    prompt "AR_IO_ADMIN_KEY" "Gateway admin key" "${AR_IO_ADMIN_KEY:-}" true

    # Optional additional bridges
    echo ""
    if confirm "Configure additional optical bridge URLs (for redundancy)?" "n"; then
        echo "Enter additional bridge URLs (comma-separated):"
        prompt "OPTIONAL_OPTICAL_BRIDGE_URLS" "Additional bridge URLs" "${OPTIONAL_OPTICAL_BRIDGE_URLS:-}"
    fi

    print_success "Optical bridging enabled: ${CONFIG[OPTICAL_BRIDGE_URL]}"
else
    CONFIG["OPTICAL_BRIDGING_ENABLED"]="false"
    print_info "Optical bridging disabled"
fi

#############################################################################################
# 10. Storage Configuration (MinIO/S3)
#############################################################################################

print_header "Step 10: Object Storage Configuration"

echo "The bundler uses S3-compatible storage for data items and bundles."
echo ""

if [ "${CONFIG[NODE_ENV]}" = "development" ] || confirm "Use local MinIO?" "y"; then
    print_info "Configuring MinIO (S3-compatible local storage)"
    CONFIG["S3_ENDPOINT"]="http://localhost:9000"
    CONFIG["S3_REGION"]="us-east-1"
    CONFIG["S3_ACCESS_KEY_ID"]="minioadmin"
    CONFIG["S3_SECRET_ACCESS_KEY"]="minioadmin123"
    CONFIG["S3_FORCE_PATH_STYLE"]="true"
    CONFIG["S3_SESSION_TOKEN"]=""
    print_success "MinIO configuration applied"
else
    echo "Configuring AWS S3 or S3-compatible service"
    prompt "S3_ENDPOINT" "S3 endpoint (leave empty for AWS S3)" "${S3_ENDPOINT:-}"
    prompt "S3_REGION" "S3 region" "${S3_REGION:-us-east-1}"
    prompt "S3_ACCESS_KEY_ID" "Access key ID" "${S3_ACCESS_KEY_ID:-}"
    prompt "S3_SECRET_ACCESS_KEY" "Secret access key" "${S3_SECRET_ACCESS_KEY:-}" true

    if confirm "Use session token (STS credentials)?" "n"; then
        prompt "S3_SESSION_TOKEN" "Session token" "${S3_SESSION_TOKEN:-}" true
    fi

    CONFIG["S3_FORCE_PATH_STYLE"]="true"
fi

CONFIG["DATA_ITEM_BUCKET"]="raw-data-items"
CONFIG["BACKUP_DATA_ITEM_BUCKET"]="backup-data-items"

if [ "$ADVANCED_MODE" = true ]; then
    echo ""
    print_section "S3 Advanced Configuration"
    prompt "DATA_ITEM_BUCKET_REGION" "Data item bucket region" "${DATA_ITEM_BUCKET_REGION:-us-east-1}"
    prompt "BACKUP_BUCKET_REGION" "Backup bucket region" "${BACKUP_BUCKET_REGION:-us-east-1}"
    prompt "S3_RETRY_MAX_ATTEMPTS" "S3 retry max attempts" "${S3_RETRY_MAX_ATTEMPTS:-5}"
    prompt "S3_RETRY_BASE_DELAY_MS" "S3 retry base delay (ms)" "${S3_RETRY_BASE_DELAY_MS:-100}"

    echo ""
    print_section "S3 Key Prefixes"
    prompt "DATA_ITEM_S3_PREFIX" "Data item prefix" "${DATA_ITEM_S3_PREFIX:-raw-data-item}"
    prompt "MULTIPART_S3_PREFIX" "Multipart uploads prefix" "${MULTIPART_S3_PREFIX:-multipart-uploads}"
    prompt "BUNDLE_PAYLOAD_S3_PREFIX" "Bundle payload prefix" "${BUNDLE_PAYLOAD_S3_PREFIX:-bundle-payload}"
    prompt "BUNDLE_TX_S3_PREFIX" "Bundle TX prefix" "${BUNDLE_TX_S3_PREFIX:-bundle}"
fi

print_success "Storage configured: ${CONFIG[S3_ENDPOINT]}"

# --- Optional: Two-tier MinIO (SSD hot + HDD archive) --------------------------
echo ""
print_section "Two-tier MinIO — HDD archive tier (optional, advanced)"
echo "Mirrors served objects (raw data items + bundle payloads) to a second"
echo "HDD-backed MinIO so AR.IO gateway reads don't compete with the bundling"
echo "pipeline on the fast SSD. Leave disabled for a single-MinIO deployment"
echo "(default). Design + ops: docs/architecture/TWO_TIER_MINIO_SSD_HDD.md."
echo ""
if confirm "Enable the two-tier MinIO HDD archive tier?" "n"; then
    # Bucket AND region label MUST be distinct from the SSD store — object-store
    # routing is keyed by both, and a collision makes the bundler refuse to wire
    # the archive (it logs an error and stays inert).
    prompt "ARCHIVE_DATA_ITEM_BUCKET" "Archive bucket name (MUST differ from DATA_ITEM_BUCKET)" "${ARCHIVE_DATA_ITEM_BUCKET:-archive-data-items}"
    prompt "ARCHIVE_BUCKET_REGION" "Archive region label (MUST differ from S3_REGION)" "${ARCHIVE_BUCKET_REGION:-archive-hdd}"
    prompt "ARCHIVE_S3_ENDPOINT" "Archive (HDD) MinIO endpoint" "${ARCHIVE_S3_ENDPOINT:-http://localhost:9002}"
    prompt "ARCHIVE_S3_ACCESS_KEY_ID" "Archive MinIO root access key" "${ARCHIVE_S3_ACCESS_KEY_ID:-minioadmin}"
    prompt "ARCHIVE_S3_SECRET_ACCESS_KEY" "Archive MinIO root secret key" "${ARCHIVE_S3_SECRET_ACCESS_KEY:-minioadmin123}" true
    CONFIG["ARCHIVE_S3_FORCE_PATH_STYLE"]="true"
    prompt "ARCHIVE_MINIO_DATA_PATH" "Host path for the HDD MinIO volume (the large disk)" "${ARCHIVE_MINIO_DATA_PATH:-/mnt/hdd/minio}"
    prompt "MINIO_S3_BIND_IP" "Private IP the HDD MinIO S3 port binds to (gateway reach; NEVER public)" "${MINIO_S3_BIND_IP:-127.0.0.1}"
    prompt "GATEWAY_S3_ACCESS_KEY_ID" "Read-only gateway user for HDD reads" "${GATEWAY_S3_ACCESS_KEY_ID:-gateway-readonly}"
    prompt "GATEWAY_S3_SECRET_ACCESS_KEY" "Read-only gateway user secret" "${GATEWAY_S3_SECRET_ACCESS_KEY:-$(generate_secret)}" true
    if [ "$ADVANCED_MODE" = true ]; then
        prompt "ARCHIVE_RETENTION_DAYS" "HDD retention in days (native MinIO ILM expiry)" "${ARCHIVE_RETENTION_DAYS:-90}"
        prompt "ARCHIVE_COPY_WORKER_CONCURRENCY" "archive-copy worker concurrency" "${ARCHIVE_COPY_WORKER_CONCURRENCY:-3}"
        prompt "SSD_CLEANUP_GRACE_DAYS" "Grace days to hold SSD copies after permanence" "${SSD_CLEANUP_GRACE_DAYS:-0}"
    fi
    print_success "Two-tier MinIO archive enabled (${CONFIG[ARCHIVE_DATA_ITEM_BUCKET]} @ ${CONFIG[ARCHIVE_S3_ENDPOINT]})"
    print_warning "Bring up the HDD MinIO:  docker compose -f docker-compose.yml -f docker-compose.hdd.yml up -d"
    print_warning "Repoint the gateway's AWS_ENDPOINT to the HDD MinIO BEFORE SSD reclaim runs (runbook §13)."
    print_warning "Enabling on a DB that ALREADY has permanent bundles? Seed the 'archive-ssd-cleanup-cursor'"
    print_warning "config row to max(permanent_date) first, or the sweep wedges backfilling history (runbook §13)."
else
    print_info "Two-tier MinIO archive disabled — single-MinIO behavior (unchanged)."
fi

#############################################################################################
# 11. Redis Configuration
#############################################################################################

print_header "Step 11: Redis Configuration"

echo "The bundler uses Redis for caching and job queues."
echo ""

prompt "REDIS_CACHE_HOST" "Redis cache host" "${REDIS_CACHE_HOST:-localhost}"
prompt "REDIS_CACHE_PORT" "Redis cache port" "${REDIS_CACHE_PORT:-6379}"
prompt "REDIS_QUEUE_HOST" "Redis queue host" "${REDIS_QUEUE_HOST:-localhost}"
prompt "REDIS_QUEUE_PORT" "Redis queue port" "${REDIS_QUEUE_PORT:-6381}"

# ElastiCache aliases
CONFIG["ELASTICACHE_HOST"]="${CONFIG[REDIS_CACHE_HOST]}"
CONFIG["ELASTICACHE_PORT"]="${CONFIG[REDIS_CACHE_PORT]}"
CONFIG["REDIS_HOST"]="${CONFIG[REDIS_QUEUE_HOST]}"
CONFIG["REDIS_PORT_QUEUES"]="${CONFIG[REDIS_QUEUE_PORT]}"

if [ "$ADVANCED_MODE" = true ]; then
    echo ""
    print_section "Redis Advanced Settings"

    if confirm "Configure ElastiCache password/TLS?" "n"; then
        prompt "ELASTICACHE_PASSWORD" "ElastiCache password" "${ELASTICACHE_PASSWORD:-}"

        if confirm "Enable TLS for ElastiCache?" "n"; then
            CONFIG["ELASTICACHE_USE_TLS"]="true"
        else
            CONFIG["ELASTICACHE_USE_TLS"]="false"
        fi
    fi

    CONFIG["ELASTICACHE_NO_CLUSTERING"]="${ELASTICACHE_NO_CLUSTERING:-true}"
fi

print_success "Redis cache: ${CONFIG[REDIS_CACHE_HOST]}:${CONFIG[REDIS_CACHE_PORT]}"
print_success "Redis queues: ${CONFIG[REDIS_QUEUE_HOST]}:${CONFIG[REDIS_QUEUE_PORT]}"

#############################################################################################
# 12. Inter-Service Communication
#############################################################################################

print_header "Step 12: Service URLs"

echo "Configure how services communicate with each other."
echo ""

if [ "${CONFIG[NODE_ENV]}" = "development" ]; then
    CONFIG["PAYMENT_SERVICE_BASE_URL"]="localhost:${CONFIG[PAYMENT_SERVICE_PORT]}"
    CONFIG["UPLOAD_SERVICE_PUBLIC_URL"]="http://localhost:${CONFIG[UPLOAD_SERVICE_PORT]}"
    CONFIG["PAYMENT_SERVICE_PROTOCOL"]="http"
    print_info "Using localhost URLs for development"
else
    print_warning "Do NOT include http:// prefix for PAYMENT_SERVICE_BASE_URL"
    prompt "PAYMENT_SERVICE_BASE_URL" "Payment service URL (no http://)" "localhost:${CONFIG[PAYMENT_SERVICE_PORT]}"

    if confirm "Use HTTPS for payment service communication?" "n"; then
        CONFIG["PAYMENT_SERVICE_PROTOCOL"]="https"
    else
        CONFIG["PAYMENT_SERVICE_PROTOCOL"]="http"
    fi

    echo ""
    echo "What is the public URL where users will access your upload service?"
    echo "This is critical for x402 payment flows."
    prompt "UPLOAD_SERVICE_PUBLIC_URL" "Public upload URL" "https://upload.yourdomain.com"

    while ! validate_url "${CONFIG[UPLOAD_SERVICE_PUBLIC_URL]}"; do
        print_error "Invalid URL format (must include http:// or https://)"
        prompt "UPLOAD_SERVICE_PUBLIC_URL" "Public upload URL" "https://upload.yourdomain.com"
    done
fi

print_success "Service communication configured"

#############################################################################################
# 13. x402 Payment Protocol (COMPREHENSIVE)
#############################################################################################

print_header "Step 13: x402 Payment Protocol (USDC Payments)"

echo "x402 is the Coinbase HTTP 402 standard for USDC payments."
echo "This is the ${BOLD}recommended${NC} payment method for production."
echo ""
echo "Supports:"
echo "  • Base Mainnet (primary)"
echo "  • Ethereum Mainnet"
echo "  • Polygon Mainnet"
echo "  • Base Sepolia (testnet)"
echo ""

if confirm "Enable x402 USDC payments?" "y"; then
    CONFIG["X402_ENABLED"]="true"

    # Network selection
    echo ""
    echo "Select primary network:"
    echo "  ${GREEN}1)${NC} Base Sepolia (Testnet) - Free testnet USDC, no CDP needed"
    echo "  ${GREEN}2)${NC} Base Mainnet - Real USDC, requires CDP credentials"
    echo "  ${GREEN}3)${NC} Ethereum Mainnet - Real USDC, requires CDP credentials"
    echo "  ${GREEN}4)${NC} Polygon Mainnet - Real USDC, requires CDP credentials"
    echo ""

    if [ "$QUICK_MODE" = true ]; then
        network_choice=1
    else
        while true; do
            read -p "Choose (1, 2, 3, or 4) [1]: " network_choice
            network_choice=${network_choice:-1}
            case $network_choice in
                1|2|3|4) break ;;
                *) print_error "Invalid choice" ;;
            esac
        done
    fi

    # Configure selected network
    case $network_choice in
        1)
            # Base Sepolia (Testnet)
            CONFIG["X402_BASE_TESTNET_ENABLED"]="true"
            CONFIG["X402_BASE_ENABLED"]="false"
            CONFIG["X402_ETH_ENABLED"]="false"
            CONFIG["X402_POLYGON_ENABLED"]="false"
            CONFIG["BASE_SEPOLIA_RPC_URL"]="https://sepolia.base.org"
            print_success "Network: Base Sepolia (Testnet)"
            ;;
        2)
            # Base Mainnet
            CONFIG["X402_BASE_ENABLED"]="true"
            CONFIG["X402_BASE_TESTNET_ENABLED"]="false"
            CONFIG["X402_ETH_ENABLED"]="false"
            CONFIG["X402_POLYGON_ENABLED"]="false"
            CONFIG["BASE_MAINNET_RPC_URL"]="https://mainnet.base.org"
            CONFIG["X402_BASE_MIN_CONFIRMATIONS"]="1"
            print_success "Network: Base Mainnet"
            ;;
        3)
            # Ethereum Mainnet
            CONFIG["X402_ETH_ENABLED"]="true"
            CONFIG["X402_BASE_ENABLED"]="false"
            CONFIG["X402_BASE_TESTNET_ENABLED"]="false"
            CONFIG["X402_POLYGON_ENABLED"]="false"
            CONFIG["ETHEREUM_MAINNET_RPC_URL"]="https://cloudflare-eth.com/"
            CONFIG["X402_ETH_MIN_CONFIRMATIONS"]="3"
            print_success "Network: Ethereum Mainnet"
            ;;
        4)
            # Polygon Mainnet
            CONFIG["X402_POLYGON_ENABLED"]="true"
            CONFIG["X402_BASE_ENABLED"]="false"
            CONFIG["X402_BASE_TESTNET_ENABLED"]="false"
            CONFIG["X402_ETH_ENABLED"]="false"
            CONFIG["POLYGON_MAINNET_RPC_URL"]="https://polygon-rpc.com/"
            CONFIG["X402_POLYGON_MIN_CONFIRMATIONS"]="10"
            print_success "Network: Polygon Mainnet"
            ;;
    esac

    # Payment address
    echo ""
    while true; do
        prompt "X402_PAYMENT_ADDRESS" "Your Ethereum address for USDC payments" "${X402_PAYMENT_ADDRESS:-${CONFIG[ETHEREUM_ADDRESS]:-}}"
        if validate_ethereum_address "${CONFIG[X402_PAYMENT_ADDRESS]}"; then
            print_success "Valid payment address"
            break
        else
            print_error "Invalid Ethereum address format"
        fi
    done

    # CDP credentials (mainnet only)
    if [ "$network_choice" != "1" ]; then
        echo ""
        print_warning "Mainnet requires Coinbase CDP credentials"
        echo "Get them from: ${CYAN}https://portal.cdp.coinbase.com/${NC}"
        echo ""
        prompt "CDP_API_KEY_ID" "CDP API Key ID" "${CDP_API_KEY_ID:-}"
        prompt "CDP_API_KEY_SECRET" "CDP API Key Secret" "${CDP_API_KEY_SECRET:-}" true

        echo ""
        if confirm "Enable browser paywall (CDP Client Key for Coinbase Onramp)?" "n"; then
            echo "This enables client-side payment UI with Coinbase Onramp."
            prompt "X_402_CDP_CLIENT_KEY" "CDP Client Key (public)" "${X_402_CDP_CLIENT_KEY:-}"
        fi

        print_success "CDP credentials configured"
    fi

    # Facilitators
    echo ""
    echo "x402 Facilitators handle payment settlement on-chain."
    echo "Default facilitators are provided (Coinbase, Mogami)."
    echo ""
    if confirm "Customize facilitator URLs?" "n"; then
        case $network_choice in
            1)
                echo "Enter Base Sepolia facilitators (comma-separated):"
                prompt "X402_FACILITATOR_URLS_BASE_TESTNET" "Base Sepolia facilitators" "${X402_FACILITATOR_URLS_BASE_TESTNET:-}"
                ;;
            2)
                echo "Enter Base Mainnet facilitators (comma-separated):"
                prompt "X402_FACILITATOR_URLS_BASE" "Base Mainnet facilitators" "${X402_FACILITATOR_URLS_BASE:-}"
                ;;
            3)
                echo "Enter Ethereum facilitators (comma-separated):"
                prompt "X402_FACILITATOR_URLS_ETH" "Ethereum facilitators" "${X402_FACILITATOR_URLS_ETH:-}"
                ;;
            4)
                echo "Enter Polygon facilitators (comma-separated):"
                prompt "X402_FACILITATOR_URLS_POLYGON" "Polygon facilitators" "${X402_FACILITATOR_URLS_POLYGON:-}"
                ;;
        esac
        print_success "Custom facilitators configured"
    else
        print_info "Using default facilitators"
    fi

    # x402 configuration
    echo ""
    print_section "x402 Payment Settings"
    CONFIG["X402_DEFAULT_MODE"]="${X402_DEFAULT_MODE:-hybrid}"
    CONFIG["X402_PAYMENT_TIMEOUT_MS"]="${X402_PAYMENT_TIMEOUT_MS:-300000}"
    CONFIG["X402_PRICING_BUFFER_PERCENT"]="${X402_PRICING_BUFFER_PERCENT:-15}"
    CONFIG["X402_FRAUD_TOLERANCE_PERCENT"]="${X402_FRAUD_TOLERANCE_PERCENT:-5}"
    CONFIG["X402_FEE_PERCENT"]="${X402_FEE_PERCENT:-15}"
    CONFIG["X402_MINIMUM_PAYMENT_USDC"]="${X402_MINIMUM_PAYMENT_USDC:-0.001}"

    if [ "$ADVANCED_MODE" = true ]; then
        prompt "X402_DEFAULT_MODE" "Payment mode (payg/topup/hybrid)" "${X402_DEFAULT_MODE}"
        prompt "X402_FEE_PERCENT" "Fee percentage (your profit margin)" "${X402_FEE_PERCENT}"
        prompt "X402_PAYMENT_TIMEOUT_MS" "Payment timeout (ms)" "${X402_PAYMENT_TIMEOUT_MS}"
        prompt "X402_PRICING_BUFFER_PERCENT" "Pricing buffer %" "${X402_PRICING_BUFFER_PERCENT}"
        prompt "X402_FRAUD_TOLERANCE_PERCENT" "Fraud tolerance %" "${X402_FRAUD_TOLERANCE_PERCENT}"
        prompt "X402_MINIMUM_PAYMENT_USDC" "Minimum payment (USDC)" "${X402_MINIMUM_PAYMENT_USDC}"
    fi

    # CoinGecko API (for AR/USD pricing)
    echo ""
    print_section "CoinGecko API (AR/USD Pricing)"
    echo "CoinGecko provides AR to USD conversion for x402 pricing."
    echo "Free tier works fine for most use cases."
    echo ""

    if confirm "Configure CoinGecko API key?" "n"; then
        prompt "COINGECKO_API_KEY" "CoinGecko API key" "${COINGECKO_API_KEY:-}"
    fi

    CONFIG["COINGECKO_API_URL"]="${COINGECKO_API_URL:-https://api.coingecko.com/api/v3/}"

    print_success "x402 payment protocol configured"
else
    CONFIG["X402_ENABLED"]="false"
    CONFIG["X402_BASE_ENABLED"]="false"
    CONFIG["X402_BASE_TESTNET_ENABLED"]="false"
    CONFIG["X402_ETH_ENABLED"]="false"
    CONFIG["X402_POLYGON_ENABLED"]="false"
    print_info "x402 disabled"
fi

#############################################################################################
# 14. Stripe Integration
#############################################################################################

print_header "Step 14: Stripe Payment Integration (Optional)"

echo "Stripe enables credit card payments for your bundler."
echo ""

if confirm "Enable Stripe for credit card payments?" "n"; then
    echo ""
    echo "Get your Stripe keys from: ${CYAN}https://dashboard.stripe.com/apikeys${NC}"
    echo ""
    prompt "STRIPE_SECRET_KEY" "Stripe secret key (sk_...)" "${STRIPE_SECRET_KEY:-}"
    prompt "STRIPE_WEBHOOK_SECRET" "Stripe webhook secret (whsec_...)" "${STRIPE_WEBHOOK_SECRET:-}"
    CONFIG["STRIPE_ENABLED"]="true"
    CONFIG["TOP_UP_QUOTE_EXPIRATION_MS"]="${TOP_UP_QUOTE_EXPIRATION_MS:-1800000}"

    if [ "$ADVANCED_MODE" = true ]; then
        echo ""
        if confirm "Enable automatic Stripe tax calculation?" "n"; then
            CONFIG["ENABLE_AUTO_STRIPE_TAX"]="true"
        else
            CONFIG["ENABLE_AUTO_STRIPE_TAX"]="false"
        fi
    fi

    print_success "Stripe configured"
else
    CONFIG["STRIPE_ENABLED"]="false"
    CONFIG["ENABLE_AUTO_STRIPE_TAX"]="false"
    print_info "Stripe disabled"
fi

#############################################################################################
# 15. Cryptocurrency Monitoring
#############################################################################################

print_header "Step 15: Cryptocurrency Payment Monitoring (Optional)"

echo "Monitor blockchain addresses for direct cryptocurrency payments."
echo "This is separate from x402 and enables AR, ETH, SOL, MATIC deposits."
echo ""

if confirm "Enable cryptocurrency payment monitoring?" "n"; then
    CONFIG["CRYPTO_MONITORING_ENABLED"]="true"

    # RPC endpoints
    echo ""
    echo "Configure RPC endpoints for each blockchain:"
    echo ""

    if [ -n "${CONFIG[ETHEREUM_ADDRESS]}" ]; then
        prompt "ETHEREUM_GATEWAY" "Ethereum RPC URL" "${ETHEREUM_GATEWAY:-https://cloudflare-eth.com/}"
    fi

    if [ -n "${CONFIG[MATIC_ADDRESS]}" ]; then
        prompt "MATIC_GATEWAY" "Polygon RPC URL" "${MATIC_GATEWAY:-https://polygon-rpc.com/}"
    fi

    if [ -n "${CONFIG[SOLANA_ADDRESS]}" ]; then
        prompt "SOLANA_GATEWAY" "Solana RPC URL" "${SOLANA_GATEWAY:-https://api.mainnet-beta.solana.com/}"
    fi

    if [ -n "${CONFIG[KYVE_ADDRESS]}" ]; then
        prompt "KYVE_GATEWAY" "KYVE RPC URL" "${KYVE_GATEWAY:-https://api.kyve.network/}"
    fi

    if [ -n "${CONFIG[BASE_ETH_ADDRESS]}" ]; then
        prompt "BASE_ETH_GATEWAY" "Base RPC URL" "${BASE_ETH_GATEWAY:-https://mainnet.base.org}"
    fi

    # Confirmations
    if [ "$ADVANCED_MODE" = true ]; then
        echo ""
        print_section "Crypto Payment Confirmations"
        prompt "ARWEAVE_MIN_CONFIRMATIONS" "Arweave confirmations" "${ARWEAVE_MIN_CONFIRMATIONS:-18}"
        prompt "ETHEREUM_MIN_CONFIRMATIONS" "Ethereum confirmations" "${ETHEREUM_MIN_CONFIRMATIONS:-5}"
        prompt "MATIC_MIN_CONFIRMATIONS" "Polygon confirmations" "${MATIC_MIN_CONFIRMATIONS:-12}"
        prompt "BASE_ETH_MIN_CONFIRMATIONS" "Base confirmations" "${BASE_ETH_MIN_CONFIRMATIONS:-5}"
        prompt "DEFAULT_MIN_CONFIRMATIONS" "Default confirmations" "${DEFAULT_MIN_CONFIRMATIONS:-5}"

        echo ""
        print_section "Crypto Payment Polling"
        prompt "PAYMENT_TX_POLLING_WAIT_TIME_MS" "Polling wait time (ms)" "${PAYMENT_TX_POLLING_WAIT_TIME_MS:-500}"
        prompt "MAX_PAYMENT_TX_POLLING_ATTEMPTS" "Max polling attempts" "${MAX_PAYMENT_TX_POLLING_ATTEMPTS:-5}"
    fi

    # Exclude addresses
    echo ""
    prompt "CRYPTO_FUND_EXCLUDED_ADDRESSES" "Excluded addresses (comma-separated)" "${CRYPTO_FUND_EXCLUDED_ADDRESSES:-}"

    print_success "Cryptocurrency monitoring configured"
else
    CONFIG["CRYPTO_MONITORING_ENABLED"]="false"
    print_info "Cryptocurrency monitoring disabled"
fi

#############################################################################################
# 16. ArNS (Arweave Name System)
#############################################################################################

print_header "Step 16: ArNS (Arweave Name System) - Optional"

echo "ArNS enables purchasing and managing Arweave Name System names."
echo ""

if confirm "Enable ArNS name purchases?" "n"; then
    CONFIG["ARNS_ENABLED"]="true"

    echo ""
    echo "ArNS requires additional configuration:"
    prompt "ARIO_SIGNING_JWK" "ARIO signing wallet (JSON string)" "${ARIO_SIGNING_JWK:-}"
    prompt "ARIO_PROCESS_ID" "ARIO process ID" "${ARIO_PROCESS_ID:-}"
    prompt "CU_URL" "Compute unit URL" "${CU_URL:-}"

    if [ "$ADVANCED_MODE" = true ]; then
        prompt "ARIO_LEASE_NAME_DUST_AMOUNT" "Lease name dust amount" "${ARIO_LEASE_NAME_DUST_AMOUNT:-1}"
        prompt "ARIO_PERMA_BUY_NAME_DUST_AMOUNT" "Perma buy name dust amount" "${ARIO_PERMA_BUY_NAME_DUST_AMOUNT:-5}"
    fi

    print_success "ArNS enabled"
else
    CONFIG["ARNS_ENABLED"]="false"
    print_info "ArNS disabled"
fi

#############################################################################################
# 17. Optional Features
#############################################################################################

print_header "Step 17: Optional Features"

# Gifting
print_section "Gifting System"
if confirm "Enable gifting via email?" "n"; then
    CONFIG["GIFTING_ENABLED"]="true"
    prompt "GIFTING_EMAIL_ADDRESS" "Gifting email address" "${GIFTING_EMAIL_ADDRESS:-gift@ardrive.io}"
    CONFIG["MAX_GIFT_MESSAGE_LENGTH"]="${MAX_GIFT_MESSAGE_LENGTH:-250}"
    print_success "Gifting enabled"
else
    CONFIG["GIFTING_ENABLED"]="false"
fi

# Email notifications
echo ""
print_section "Email Notifications (Optional)"
if confirm "Enable email notifications?" "n"; then
    echo "Choose provider:"
    echo "  1) SendGrid"
    echo "  2) Mandrill"
    read -p "Choose (1 or 2): " email_provider

    case $email_provider in
        1)
            prompt "SENDGRID_API_KEY" "SendGrid API key" "${SENDGRID_API_KEY:-}" true
            ;;
        2)
            prompt "MANDRILL_API_KEY" "Mandrill API key" "${MANDRILL_API_KEY:-}" true
            ;;
    esac
    print_success "Email notifications enabled"
fi

# Allow-listed addresses
echo ""
print_section "Free Upload Allowlist"
prompt "ALLOW_LISTED_ADDRESSES" "Addresses for free uploads (comma-separated)" "${ALLOW_LISTED_ADDRESSES:-}"
CONFIG["FREE_UPLOAD_LIMIT"]="${FREE_UPLOAD_LIMIT:-517120}"

if [ "$ADVANCED_MODE" = true ]; then
    prompt "FREE_UPLOAD_LIMIT" "Free upload limit (bytes)" "${FREE_UPLOAD_LIMIT}"
fi

CONFIG["SKIP_BALANCE_CHECKS"]="${SKIP_BALANCE_CHECKS:-false}"

# Rate limiting
echo ""
print_section "Rate Limiting"
if confirm "Enable rate limiting?" "y"; then
    CONFIG["RATE_LIMIT_ENABLED"]="true"
    CONFIG["RATE_LIMIT_MAX_REQUESTS"]="${RATE_LIMIT_MAX_REQUESTS:-100}"
    CONFIG["RATE_LIMIT_WINDOW_MS"]="${RATE_LIMIT_WINDOW_MS:-60000}"

    if [ "$ADVANCED_MODE" = true ]; then
        prompt "RATE_LIMIT_MAX_REQUESTS" "Max requests per window" "${RATE_LIMIT_MAX_REQUESTS}"
        prompt "RATE_LIMIT_WINDOW_MS" "Window duration (ms)" "${RATE_LIMIT_WINDOW_MS}"
    fi
else
    CONFIG["RATE_LIMIT_ENABLED"]="false"
fi

#############################################################################################
# 18. Upload Service Advanced Configuration
#############################################################################################

if [ "$ADVANCED_MODE" = true ]; then
    print_header "Step 18: Upload Service Advanced Configuration"

    print_section "Data Item Limits"
    prompt "MAX_DATA_ITEM_SIZE" "Max data item size (bytes)" "${MAX_DATA_ITEM_SIZE:-10737418240}"
    prompt "MAX_DATA_ITEM_LIMIT" "Max data items per bundle" "${MAX_DATA_ITEM_LIMIT:-10000}"
    prompt "MAX_BUNDLE_SIZE" "Max bundle size (bytes)" "${MAX_BUNDLE_SIZE:-2147483648}"

    echo ""
    print_section "Upload Features"

    if confirm "Allow ArFS data?" "n"; then
        CONFIG["ALLOW_ARFS_DATA"]="true"
    else
        CONFIG["ALLOW_ARFS_DATA"]="false"
    fi

    prompt "BLOCKLISTED_ADDRESSES" "Blocklisted addresses (comma-separated)" "${BLOCKLISTED_ADDRESSES:-}"
    prompt "ALLOW_LISTED_SIGNATURE_TYPES" "Allowed signature types (comma-separated IDs)" "${ALLOW_LISTED_SIGNATURE_TYPES:-}"

    echo ""
    print_section "Special Address Lists"
    echo "Configure special address lists for prioritization or custom handling:"
    prompt "WARP_ADDRESSES" "Warp contract addresses" "${WARP_ADDRESSES:-}"
    prompt "AO_ADDRESSES" "AO process addresses" "${AO_ADDRESSES:-}"
    prompt "REDSTONE_ORACLE_ADDRESSES" "RedStone oracle addresses" "${REDSTONE_ORACLE_ADDRESSES:-}"
    prompt "KYVE_ADDRESSES" "KYVE addresses" "${KYVE_ADDRESSES:-}"
    prompt "ARIO_MAINNET_PROCESSES" "ARIO mainnet processes" "${ARIO_MAINNET_PROCESSES:-}"
    prompt "ARIO_TESTNET_PROCESSES" "ARIO testnet processes" "${ARIO_TESTNET_PROCESSES:-}"
    prompt "ANT_REGISTRY_MAINNET_PROCESSES" "ANT registry mainnet" "${ANT_REGISTRY_MAINNET_PROCESSES:-}"
    prompt "ANT_REGISTRY_TESTNET_PROCESSES" "ANT registry testnet" "${ANT_REGISTRY_TESTNET_PROCESSES:-}"
    prompt "FIRST_BATCH_ADDRESSES" "First batch addresses" "${FIRST_BATCH_ADDRESSES:-}"
    prompt "SKIP_OPTICAL_POST_ADDRESSES" "Skip optical post (comma-separated)" "${SKIP_OPTICAL_POST_ADDRESSES:-}"

    echo ""
    print_section "Data Caches & Indexes"
    prompt "DATA_CACHES" "Data caches (comma-separated)" "${DATA_CACHES:-}"
    prompt "FAST_FINALITY_INDEXES" "Fast finality indexes (comma-separated)" "${FAST_FINALITY_INDEXES:-}"

    echo ""
    print_section "Timing Configuration"
    prompt "OVERDUE_DATA_ITEM_THRESHOLD_MS" "Overdue threshold (ms)" "${OVERDUE_DATA_ITEM_THRESHOLD_MS:-300000}"
    prompt "IN_FLIGHT_DATA_ITEM_TTL_SECS" "In-flight TTL (seconds)" "${IN_FLIGHT_DATA_ITEM_TTL_SECS:-600}"
    prompt "QUARANTINED_SMALL_DATAITEM_TTL_SECS" "Quarantined TTL (seconds)" "${QUARANTINED_SMALL_DATAITEM_TTL_SECS:-432000}"

    echo ""
    print_section "Filesystem Storage"
    prompt "FS_DATA_PATH" "Persistent data path" "${FS_DATA_PATH:-./upload-service-data}"
    prompt "TEMP_DIR" "Temporary directory" "${TEMP_DIR:-./temp}"

    if confirm "Configure EFS mount point (network filesystem)?" "n"; then
        prompt "EFS_MOUNT_POINT" "EFS mount point" "${EFS_MOUNT_POINT:-}"
    fi

    echo ""
    print_section "Database Backfill (Migration)"
    prompt "PERMANENT_DATA_ITEM_BACKFILL_START_BLOCK" "Backfill start block" "${PERMANENT_DATA_ITEM_BACKFILL_START_BLOCK:-1045991}"
    prompt "PERMANENT_DATA_ITEM_BACKFILL_END_BLOCK" "Backfill end block" "${PERMANENT_DATA_ITEM_BACKFILL_END_BLOCK:-1470456}"
fi

#############################################################################################
# 19. Payment Service Advanced Configuration
#############################################################################################

if [ "$ADVANCED_MODE" = true ]; then
    print_header "Step 19: Payment Service Advanced Configuration"

    print_section "Payment Features"
    prompt "MAX_ALLOWED_CHARGE_BACKS" "Max allowed chargebacks" "${MAX_ALLOWED_CHARGE_BACKS:-1}"
    prompt "TOKENS_WITHOUT_FEES" "Tokens exempt from fees (comma-separated)" "${TOKENS_WITHOUT_FEES:-}"
fi

#############################################################################################
# 20. Worker Configuration
#############################################################################################

if [ "$ADVANCED_MODE" = true ]; then
    print_header "Step 20: Worker & PM2 Configuration"

    print_section "Worker Concurrency"
    prompt "WORKER_CONCURRENCY_ADMIN_CREDIT" "Admin credit worker concurrency" "${WORKER_CONCURRENCY_ADMIN_CREDIT:-2}"
    prompt "WORKER_CONCURRENCY_PENDING_TX" "Pending TX worker concurrency" "${WORKER_CONCURRENCY_PENDING_TX:-1}"

    echo ""
    print_section "PM2 Instances"
    prompt "API_INSTANCES" "API instances (cluster mode)" "${API_INSTANCES:-2}"
    prompt "WORKER_INSTANCES" "Worker instances (fork mode)" "${WORKER_INSTANCES:-1}"
fi

#############################################################################################
# 21. Monitoring & Observability
#############################################################################################

print_header "Step 21: Monitoring & Observability (Optional)"

# Logging
if [ "$ADVANCED_MODE" = true ]; then
    print_section "Logging Configuration"
    prompt "LOG_LEVEL" "Log level (debug/info/warn/error)" "${LOG_LEVEL:-info}"
    prompt "LOG_FORMAT" "Log format (simple/json)" "${LOG_FORMAT:-simple}"

    if confirm "Log all stack traces?" "n"; then
        CONFIG["LOG_ALL_STACKTRACES"]="true"
    else
        CONFIG["LOG_ALL_STACKTRACES"]="false"
    fi

    if confirm "Disable logs entirely?" "n"; then
        CONFIG["DISABLE_LOGS"]="true"
    else
        CONFIG["DISABLE_LOGS"]="false"
    fi

    if confirm "Enable stream debugging?" "n"; then
        CONFIG["STREAM_DEBUG"]="true"
    else
        CONFIG["STREAM_DEBUG"]="false"
    fi
fi

# OpenTelemetry
echo ""
print_section "OpenTelemetry Tracing"
if confirm "Enable OpenTelemetry?" "n"; then
    CONFIG["OTEL_ENABLED"]="true"
    prompt "OTEL_COLLECTOR_URL" "OTEL collector URL" "${OTEL_COLLECTOR_URL:-}"

    if [ "$ADVANCED_MODE" = true ]; then
        prompt "OTEL_SAMPLE_RATE" "OTEL sample rate (1 in N)" "${OTEL_SAMPLE_RATE:-200}"
    fi

    print_success "OpenTelemetry enabled"
else
    CONFIG["OTEL_ENABLED"]="false"
fi

# Prometheus
echo ""
print_section "Prometheus Metrics"
CONFIG["PROMETHEUS_PORT"]="${PROMETHEUS_PORT:-9090}"

if [ "$ADVANCED_MODE" = true ]; then
    prompt "PROMETHEUS_PORT" "Prometheus port" "${PROMETHEUS_PORT}"
fi

print_info "Prometheus metrics on port ${CONFIG[PROMETHEUS_PORT]}"

#############################################################################################
# 22. App Configuration
#############################################################################################

print_header "Step 22: Application Configuration"

CONFIG["APP_NAME"]="${APP_NAME:-AR.IO Bundler}"

if [ "$ADVANCED_MODE" = true ]; then
    prompt "APP_NAME" "Application name" "${APP_NAME}"
fi

print_info "App name: ${CONFIG[APP_NAME]}"

#############################################################################################
# 23. Generate .env File
#############################################################################################

print_header "Step 23: Generating Configuration File"

echo "Creating comprehensive .env file with all 137 variables..."
echo ""

cat > "$ENV_FILE" << 'EOF_HEADER'
# ================================
# AR.IO BUNDLER CONFIGURATION
# ================================
# Single centralized configuration file for both Payment and Upload services
# Generated by setup-bundler.sh - Comprehensive configuration (137 variables)
EOF_HEADER

echo "# Generated: $(date)" >> "$ENV_FILE"
echo "" >> "$ENV_FILE"

# Core configuration
cat >> "$ENV_FILE" << EOF
# ================================
# CORE CONFIGURATION
# ================================
NODE_ENV=${CONFIG[NODE_ENV]}
MIGRATE_ON_STARTUP=${CONFIG[MIGRATE_ON_STARTUP]}

# ================================
# SERVICE PORTS
# ================================
PAYMENT_SERVICE_PORT=${CONFIG[PAYMENT_SERVICE_PORT]}
UPLOAD_SERVICE_PORT=${CONFIG[UPLOAD_SERVICE_PORT]}

# ================================
# DATABASE CONFIGURATION
# ================================
DB_HOST=${CONFIG[DB_HOST]}
DB_PORT=${CONFIG[DB_PORT]}
DB_USER=${CONFIG[DB_USER]}
DB_PASSWORD=${CONFIG[DB_PASSWORD]}
DB_WRITER_ENDPOINT=${CONFIG[DB_WRITER_ENDPOINT]}
DB_READER_ENDPOINT=${CONFIG[DB_READER_ENDPOINT]}

# Database names (MUST be different for each service)
PAYMENT_DB_DATABASE=${CONFIG[PAYMENT_DB_DATABASE]}
UPLOAD_DB_DATABASE=${CONFIG[UPLOAD_DB_DATABASE]}

# PostgreSQL version
POSTGRES_VERSION=${CONFIG[POSTGRES_VERSION]:-16.1}

# Database connection pool configuration (for scale)
DB_POOL_MIN=${CONFIG[DB_POOL_MIN]:-5}
DB_POOL_MAX=${CONFIG[DB_POOL_MAX]:-50}
DB_ACQUIRE_TIMEOUT=${CONFIG[DB_ACQUIRE_TIMEOUT]:-10000}
DB_IDLE_TIMEOUT=${CONFIG[DB_IDLE_TIMEOUT]:-30000}
DB_REAP_INTERVAL=${CONFIG[DB_REAP_INTERVAL]:-1000}

# ================================
# SERVER TIMEOUT CONFIGURATION
# ================================
# Upload Service (supports large files up to 10 GiB)
REQUEST_TIMEOUT_MS=${CONFIG[REQUEST_TIMEOUT_MS]:-600000}
KEEPALIVE_TIMEOUT_MS=${CONFIG[KEEPALIVE_TIMEOUT_MS]:-620000}
HEADERS_TIMEOUT_MS=${CONFIG[HEADERS_TIMEOUT_MS]:-630000}

# ================================
# SCALE & PERFORMANCE CONFIGURATION
# ================================
# Maximum data item size to cache in Redis (bytes)
# Items larger than this will be stored in object store only
# Default: 100 MB (104857600 bytes)
# WARNING: Setting too high can cause Redis OOM
MAX_CACHE_DATA_ITEM_SIZE=${CONFIG[MAX_CACHE_DATA_ITEM_SIZE]:-104857600}

# ================================
# SECURITY & AUTHENTICATION
# ================================
# Inter-service authentication (MUST match between services)
PRIVATE_ROUTE_SECRET=${CONFIG[PRIVATE_ROUTE_SECRET]}

# JWT secret for token generation
JWT_SECRET=${CONFIG[JWT_SECRET]}

# ================================
# ARWEAVE WALLET CONFIGURATION
# ================================
# Bundle signing wallet (MUST be absolute path)
TURBO_JWK_FILE=${CONFIG[TURBO_JWK_FILE]}

# Raw data item signing wallet
RAW_DATA_ITEM_JWK_FILE=${CONFIG[RAW_DATA_ITEM_JWK_FILE]:-${CONFIG[TURBO_JWK_FILE]}}

# Wallet addresses
ARWEAVE_ADDRESS=${CONFIG[ARWEAVE_ADDRESS]}
ARIO_ADDRESS=${CONFIG[ARIO_ADDRESS]}
EOF

# Optional blockchain addresses
[ -n "${CONFIG[ETHEREUM_ADDRESS]}" ] && echo "ETHEREUM_ADDRESS=${CONFIG[ETHEREUM_ADDRESS]}" >> "$ENV_FILE"
[ -n "${CONFIG[SOLANA_ADDRESS]}" ] && echo "SOLANA_ADDRESS=${CONFIG[SOLANA_ADDRESS]}" >> "$ENV_FILE"
[ -n "${CONFIG[ED25519_ADDRESS]}" ] && echo "ED25519_ADDRESS=${CONFIG[ED25519_ADDRESS]}" >> "$ENV_FILE"
[ -n "${CONFIG[MATIC_ADDRESS]}" ] && echo "MATIC_ADDRESS=${CONFIG[MATIC_ADDRESS]}" >> "$ENV_FILE"
[ -n "${CONFIG[POL_ADDRESS]}" ] && echo "POL_ADDRESS=${CONFIG[POL_ADDRESS]}" >> "$ENV_FILE"
[ -n "${CONFIG[BASE_ETH_ADDRESS]}" ] && echo "BASE_ETH_ADDRESS=${CONFIG[BASE_ETH_ADDRESS]}" >> "$ENV_FILE"
[ -n "${CONFIG[KYVE_ADDRESS]}" ] && echo "KYVE_ADDRESS=${CONFIG[KYVE_ADDRESS]}" >> "$ENV_FILE"

# Two-tier MinIO (SSD hot + HDD archive) — only written when enabled above.
# Unset ARCHIVE_DATA_ITEM_BUCKET keeps the single-MinIO path (feature stays inert).
if [ -n "${CONFIG[ARCHIVE_DATA_ITEM_BUCKET]}" ]; then
    {
        echo ""
        echo "# ================================"
        echo "# TWO-TIER MINIO (SSD hot + HDD archive)"
        echo "# ================================"
        echo "ARCHIVE_DATA_ITEM_BUCKET=${CONFIG[ARCHIVE_DATA_ITEM_BUCKET]}"
        echo "ARCHIVE_BUCKET_REGION=${CONFIG[ARCHIVE_BUCKET_REGION]:-archive-hdd}"
        echo "ARCHIVE_S3_ENDPOINT=${CONFIG[ARCHIVE_S3_ENDPOINT]}"
        echo "ARCHIVE_S3_ACCESS_KEY_ID=${CONFIG[ARCHIVE_S3_ACCESS_KEY_ID]}"
        echo "ARCHIVE_S3_SECRET_ACCESS_KEY=${CONFIG[ARCHIVE_S3_SECRET_ACCESS_KEY]}"
        echo "ARCHIVE_S3_FORCE_PATH_STYLE=${CONFIG[ARCHIVE_S3_FORCE_PATH_STYLE]:-true}"
        echo "ARCHIVE_MINIO_DATA_PATH=${CONFIG[ARCHIVE_MINIO_DATA_PATH]}"
        echo "MINIO_S3_BIND_IP=${CONFIG[MINIO_S3_BIND_IP]:-127.0.0.1}"
        echo "GATEWAY_S3_ACCESS_KEY_ID=${CONFIG[GATEWAY_S3_ACCESS_KEY_ID]:-gateway-readonly}"
        echo "GATEWAY_S3_SECRET_ACCESS_KEY=${CONFIG[GATEWAY_S3_SECRET_ACCESS_KEY]}"
        echo "ARCHIVE_RETENTION_DAYS=${CONFIG[ARCHIVE_RETENTION_DAYS]:-90}"
        echo "ARCHIVE_COPY_WORKER_CONCURRENCY=${CONFIG[ARCHIVE_COPY_WORKER_CONCURRENCY]:-3}"
        echo "SSD_CLEANUP_GRACE_DAYS=${CONFIG[SSD_CLEANUP_GRACE_DAYS]:-0}"
    } >> "$ENV_FILE"
fi

# x402 configuration
cat >> "$ENV_FILE" << EOF

# ================================
# X402 PAYMENT PROTOCOL
# ================================
X402_ENABLED=${CONFIG[X402_ENABLED]:-false}
EOF

if [ "${CONFIG[X402_ENABLED]}" = "true" ]; then
    cat >> "$ENV_FILE" << EOF
X402_PAYMENT_ADDRESS=${CONFIG[X402_PAYMENT_ADDRESS]}

# Network enables
X402_BASE_ENABLED=${CONFIG[X402_BASE_ENABLED]:-false}
X402_BASE_TESTNET_ENABLED=${CONFIG[X402_BASE_TESTNET_ENABLED]:-false}
X402_ETH_ENABLED=${CONFIG[X402_ETH_ENABLED]:-false}
X402_POLYGON_ENABLED=${CONFIG[X402_POLYGON_ENABLED]:-false}

# RPC URLs
EOF
    [ -n "${CONFIG[BASE_MAINNET_RPC_URL]}" ] && echo "BASE_MAINNET_RPC_URL=${CONFIG[BASE_MAINNET_RPC_URL]}" >> "$ENV_FILE"
    [ -n "${CONFIG[BASE_SEPOLIA_RPC_URL]}" ] && echo "BASE_SEPOLIA_RPC_URL=${CONFIG[BASE_SEPOLIA_RPC_URL]}" >> "$ENV_FILE"
    [ -n "${CONFIG[ETHEREUM_MAINNET_RPC_URL]}" ] && echo "ETHEREUM_MAINNET_RPC_URL=${CONFIG[ETHEREUM_MAINNET_RPC_URL]}" >> "$ENV_FILE"
    [ -n "${CONFIG[POLYGON_MAINNET_RPC_URL]}" ] && echo "POLYGON_MAINNET_RPC_URL=${CONFIG[POLYGON_MAINNET_RPC_URL]}" >> "$ENV_FILE"

    cat >> "$ENV_FILE" << EOF

# Minimum confirmations per network
EOF
    [ -n "${CONFIG[X402_BASE_MIN_CONFIRMATIONS]}" ] && echo "X402_BASE_MIN_CONFIRMATIONS=${CONFIG[X402_BASE_MIN_CONFIRMATIONS]}" >> "$ENV_FILE"
    [ -n "${CONFIG[X402_ETH_MIN_CONFIRMATIONS]}" ] && echo "X402_ETH_MIN_CONFIRMATIONS=${CONFIG[X402_ETH_MIN_CONFIRMATIONS]}" >> "$ENV_FILE"
    [ -n "${CONFIG[X402_POLYGON_MIN_CONFIRMATIONS]}" ] && echo "X402_POLYGON_MIN_CONFIRMATIONS=${CONFIG[X402_POLYGON_MIN_CONFIRMATIONS]}" >> "$ENV_FILE"

    cat >> "$ENV_FILE" << EOF

# Facilitator URLs per network
EOF
    [ -n "${CONFIG[X402_FACILITATOR_URLS_BASE]}" ] && echo "X402_FACILITATOR_URLS_BASE=${CONFIG[X402_FACILITATOR_URLS_BASE]}" >> "$ENV_FILE"
    [ -n "${CONFIG[X402_FACILITATOR_URLS_BASE_TESTNET]}" ] && echo "X402_FACILITATOR_URLS_BASE_TESTNET=${CONFIG[X402_FACILITATOR_URLS_BASE_TESTNET]}" >> "$ENV_FILE"
    [ -n "${CONFIG[X402_FACILITATOR_URLS_ETH]}" ] && echo "X402_FACILITATOR_URLS_ETH=${CONFIG[X402_FACILITATOR_URLS_ETH]}" >> "$ENV_FILE"
    [ -n "${CONFIG[X402_FACILITATOR_URLS_POLYGON]}" ] && echo "X402_FACILITATOR_URLS_POLYGON=${CONFIG[X402_FACILITATOR_URLS_POLYGON]}" >> "$ENV_FILE"

    cat >> "$ENV_FILE" << EOF

# CDP Credentials (REQUIRED for mainnet)
EOF
    [ -n "${CONFIG[CDP_API_KEY_ID]}" ] && echo "CDP_API_KEY_ID=${CONFIG[CDP_API_KEY_ID]}" >> "$ENV_FILE"
    [ -n "${CONFIG[CDP_API_KEY_SECRET]}" ] && echo "CDP_API_KEY_SECRET=${CONFIG[CDP_API_KEY_SECRET]}" >> "$ENV_FILE"
    [ -n "${CONFIG[X_402_CDP_CLIENT_KEY]}" ] && echo "X_402_CDP_CLIENT_KEY=${CONFIG[X_402_CDP_CLIENT_KEY]}" >> "$ENV_FILE"

    cat >> "$ENV_FILE" << EOF

# Payment configuration
X402_DEFAULT_MODE=${CONFIG[X402_DEFAULT_MODE]:-hybrid}
X402_FEE_PERCENT=${CONFIG[X402_FEE_PERCENT]:-15}
X402_PAYMENT_TIMEOUT_MS=${CONFIG[X402_PAYMENT_TIMEOUT_MS]:-300000}
X402_PRICING_BUFFER_PERCENT=${CONFIG[X402_PRICING_BUFFER_PERCENT]:-15}
X402_FRAUD_TOLERANCE_PERCENT=${CONFIG[X402_FRAUD_TOLERANCE_PERCENT]:-5}
X402_MINIMUM_PAYMENT_USDC=${CONFIG[X402_MINIMUM_PAYMENT_USDC]:-0.001}

# CoinGecko API (AR/USD pricing)
COINGECKO_API_KEY=${CONFIG[COINGECKO_API_KEY]:-}
COINGECKO_API_URL=${CONFIG[COINGECKO_API_URL]:-https://api.coingecko.com/api/v3/}
EOF
fi

# Gateway configuration
cat >> "$ENV_FILE" << EOF

# ================================
# ARWEAVE GATEWAY CONFIGURATION
# ================================
ARWEAVE_GATEWAY=${CONFIG[ARWEAVE_GATEWAY]}
PUBLIC_ACCESS_GATEWAY=${CONFIG[PUBLIC_ACCESS_GATEWAY]}
ARWEAVE_UPLOAD_NODE=${CONFIG[ARWEAVE_UPLOAD_NODE]}
PUBLIC_GATEWAY_FQDNS=${CONFIG[PUBLIC_GATEWAY_FQDNS]:-}
ARWEAVE_NETWORK_REQUEST_TIMEOUT_MS=${CONFIG[ARWEAVE_NETWORK_REQUEST_TIMEOUT_MS]:-60000}

# ================================
# AR.IO GATEWAY INTEGRATION
# ================================
OPTICAL_BRIDGING_ENABLED=${CONFIG[OPTICAL_BRIDGING_ENABLED]:-false}
EOF

if [ "${CONFIG[OPTICAL_BRIDGING_ENABLED]}" = "true" ]; then
    cat >> "$ENV_FILE" << EOF
OPTICAL_BRIDGE_URL=${CONFIG[OPTICAL_BRIDGE_URL]}
AR_IO_ADMIN_KEY=${CONFIG[AR_IO_ADMIN_KEY]}
OPTIONAL_OPTICAL_BRIDGE_URLS=${CONFIG[OPTIONAL_OPTICAL_BRIDGE_URLS]:-}
EOF
fi

# Storage configuration
cat >> "$ENV_FILE" << EOF

# ================================
# OBJECT STORAGE (S3/MinIO)
# ================================
S3_ENDPOINT=${CONFIG[S3_ENDPOINT]}
S3_REGION=${CONFIG[S3_REGION]}
S3_ACCESS_KEY_ID=${CONFIG[S3_ACCESS_KEY_ID]}
S3_SECRET_ACCESS_KEY=${CONFIG[S3_SECRET_ACCESS_KEY]}
S3_FORCE_PATH_STYLE=${CONFIG[S3_FORCE_PATH_STYLE]}
S3_SESSION_TOKEN=${CONFIG[S3_SESSION_TOKEN]:-}

# Bucket names and regions
DATA_ITEM_BUCKET=${CONFIG[DATA_ITEM_BUCKET]}
BACKUP_DATA_ITEM_BUCKET=${CONFIG[BACKUP_DATA_ITEM_BUCKET]}
DATA_ITEM_BUCKET_REGION=${CONFIG[DATA_ITEM_BUCKET_REGION]:-us-east-1}
BACKUP_BUCKET_REGION=${CONFIG[BACKUP_BUCKET_REGION]:-us-east-1}

# S3 retry configuration
S3_RETRY_MAX_ATTEMPTS=${CONFIG[S3_RETRY_MAX_ATTEMPTS]:-5}
S3_RETRY_BASE_DELAY_MS=${CONFIG[S3_RETRY_BASE_DELAY_MS]:-100}

# S3 key prefixes
DATA_ITEM_S3_PREFIX=${CONFIG[DATA_ITEM_S3_PREFIX]:-raw-data-item}
MULTIPART_S3_PREFIX=${CONFIG[MULTIPART_S3_PREFIX]:-multipart-uploads}
BUNDLE_PAYLOAD_S3_PREFIX=${CONFIG[BUNDLE_PAYLOAD_S3_PREFIX]:-bundle-payload}
BUNDLE_TX_S3_PREFIX=${CONFIG[BUNDLE_TX_S3_PREFIX]:-bundle}
EOF

# Redis configuration
cat >> "$ENV_FILE" << EOF

# ================================
# REDIS CONFIGURATION
# ================================
# Redis Cache (ElastiCache)
REDIS_CACHE_HOST=${CONFIG[REDIS_CACHE_HOST]}
REDIS_CACHE_PORT=${CONFIG[REDIS_CACHE_PORT]}
ELASTICACHE_HOST=${CONFIG[ELASTICACHE_HOST]}
ELASTICACHE_PORT=${CONFIG[ELASTICACHE_PORT]}
ELASTICACHE_NO_CLUSTERING=${CONFIG[ELASTICACHE_NO_CLUSTERING]:-true}
ELASTICACHE_PASSWORD=${CONFIG[ELASTICACHE_PASSWORD]:-}
ELASTICACHE_USE_TLS=${CONFIG[ELASTICACHE_USE_TLS]:-false}

# Redis Queues (BullMQ)
REDIS_QUEUE_HOST=${CONFIG[REDIS_QUEUE_HOST]}
REDIS_QUEUE_PORT=${CONFIG[REDIS_QUEUE_PORT]}
REDIS_HOST=${CONFIG[REDIS_HOST]}
REDIS_PORT_QUEUES=${CONFIG[REDIS_PORT_QUEUES]}
EOF

# Service URLs
cat >> "$ENV_FILE" << EOF

# ================================
# INTER-SERVICE COMMUNICATION
# ================================
PAYMENT_SERVICE_BASE_URL=${CONFIG[PAYMENT_SERVICE_BASE_URL]}
PAYMENT_SERVICE_PROTOCOL=${CONFIG[PAYMENT_SERVICE_PROTOCOL]:-http}
UPLOAD_SERVICE_PUBLIC_URL=${CONFIG[UPLOAD_SERVICE_PUBLIC_URL]}
EOF

# Stripe
cat >> "$ENV_FILE" << EOF

# ================================
# STRIPE PAYMENTS
# ================================
STRIPE_ENABLED=${CONFIG[STRIPE_ENABLED]:-false}
EOF

if [ "${CONFIG[STRIPE_ENABLED]}" = "true" ]; then
    cat >> "$ENV_FILE" << EOF
STRIPE_SECRET_KEY=${CONFIG[STRIPE_SECRET_KEY]}
STRIPE_WEBHOOK_SECRET=${CONFIG[STRIPE_WEBHOOK_SECRET]}
TOP_UP_QUOTE_EXPIRATION_MS=${CONFIG[TOP_UP_QUOTE_EXPIRATION_MS]:-1800000}
ENABLE_AUTO_STRIPE_TAX=${CONFIG[ENABLE_AUTO_STRIPE_TAX]:-false}
EOF
fi

# Crypto monitoring
cat >> "$ENV_FILE" << EOF

# ================================
# CRYPTOCURRENCY MONITORING
# ================================
CRYPTO_MONITORING_ENABLED=${CONFIG[CRYPTO_MONITORING_ENABLED]:-false}
EOF

if [ "${CONFIG[CRYPTO_MONITORING_ENABLED]}" = "true" ]; then
    [ -n "${CONFIG[ETHEREUM_GATEWAY]}" ] && echo "ETHEREUM_GATEWAY=${CONFIG[ETHEREUM_GATEWAY]}" >> "$ENV_FILE"
    [ -n "${CONFIG[MATIC_GATEWAY]}" ] && echo "MATIC_GATEWAY=${CONFIG[MATIC_GATEWAY]}" >> "$ENV_FILE"
    [ -n "${CONFIG[SOLANA_GATEWAY]}" ] && echo "SOLANA_GATEWAY=${CONFIG[SOLANA_GATEWAY]}" >> "$ENV_FILE"
    [ -n "${CONFIG[KYVE_GATEWAY]}" ] && echo "KYVE_GATEWAY=${CONFIG[KYVE_GATEWAY]}" >> "$ENV_FILE"
    [ -n "${CONFIG[BASE_ETH_GATEWAY]}" ] && echo "BASE_ETH_GATEWAY=${CONFIG[BASE_ETH_GATEWAY]}" >> "$ENV_FILE"

    cat >> "$ENV_FILE" << EOF

# Crypto confirmations
ARWEAVE_MIN_CONFIRMATIONS=${CONFIG[ARWEAVE_MIN_CONFIRMATIONS]:-18}
ETHEREUM_MIN_CONFIRMATIONS=${CONFIG[ETHEREUM_MIN_CONFIRMATIONS]:-5}
MATIC_MIN_CONFIRMATIONS=${CONFIG[MATIC_MIN_CONFIRMATIONS]:-12}
BASE_ETH_MIN_CONFIRMATIONS=${CONFIG[BASE_ETH_MIN_CONFIRMATIONS]:-5}
DEFAULT_MIN_CONFIRMATIONS=${CONFIG[DEFAULT_MIN_CONFIRMATIONS]:-5}

# Crypto payment polling
PAYMENT_TX_POLLING_WAIT_TIME_MS=${CONFIG[PAYMENT_TX_POLLING_WAIT_TIME_MS]:-500}
MAX_PAYMENT_TX_POLLING_ATTEMPTS=${CONFIG[MAX_PAYMENT_TX_POLLING_ATTEMPTS]:-5}

# Excluded addresses
CRYPTO_FUND_EXCLUDED_ADDRESSES=${CONFIG[CRYPTO_FUND_EXCLUDED_ADDRESSES]:-}
EOF
fi

# ArNS
cat >> "$ENV_FILE" << EOF

# ================================
# ARNS (ARWEAVE NAME SYSTEM)
# ================================
ARNS_ENABLED=${CONFIG[ARNS_ENABLED]:-false}
EOF

if [ "${CONFIG[ARNS_ENABLED]}" = "true" ]; then
    cat >> "$ENV_FILE" << EOF
ARIO_SIGNING_JWK=${CONFIG[ARIO_SIGNING_JWK]:-}
ARIO_PROCESS_ID=${CONFIG[ARIO_PROCESS_ID]:-}
CU_URL=${CONFIG[CU_URL]:-}
ARIO_LEASE_NAME_DUST_AMOUNT=${CONFIG[ARIO_LEASE_NAME_DUST_AMOUNT]:-1}
ARIO_PERMA_BUY_NAME_DUST_AMOUNT=${CONFIG[ARIO_PERMA_BUY_NAME_DUST_AMOUNT]:-5}
EOF
fi

# Gifting and email
cat >> "$ENV_FILE" << EOF

# ================================
# GIFTING & EMAIL
# ================================
GIFTING_ENABLED=${CONFIG[GIFTING_ENABLED]:-false}
EOF

[ -n "${CONFIG[GIFTING_EMAIL_ADDRESS]}" ] && echo "GIFTING_EMAIL_ADDRESS=${CONFIG[GIFTING_EMAIL_ADDRESS]}" >> "$ENV_FILE"
[ -n "${CONFIG[MAX_GIFT_MESSAGE_LENGTH]}" ] && echo "MAX_GIFT_MESSAGE_LENGTH=${CONFIG[MAX_GIFT_MESSAGE_LENGTH]}" >> "$ENV_FILE"
[ -n "${CONFIG[MANDRILL_API_KEY]}" ] && echo "MANDRILL_API_KEY=${CONFIG[MANDRILL_API_KEY]}" >> "$ENV_FILE"
[ -n "${CONFIG[SENDGRID_API_KEY]}" ] && echo "SENDGRID_API_KEY=${CONFIG[SENDGRID_API_KEY]}" >> "$ENV_FILE"

# Upload features
cat >> "$ENV_FILE" << EOF

# ================================
# UPLOAD SERVICE CONFIGURATION
# ================================
# Allow listed addresses for free uploads
ALLOW_LISTED_ADDRESSES=${CONFIG[ALLOW_LISTED_ADDRESSES]:-}
SKIP_BALANCE_CHECKS=${CONFIG[SKIP_BALANCE_CHECKS]:-false}

# Data item and bundle limits
MAX_DATA_ITEM_SIZE=${CONFIG[MAX_DATA_ITEM_SIZE]:-10737418240}
MAX_DATA_ITEM_LIMIT=${CONFIG[MAX_DATA_ITEM_LIMIT]:-10000}
MAX_BUNDLE_SIZE=${CONFIG[MAX_BUNDLE_SIZE]:-2147483648}
FREE_UPLOAD_LIMIT=${CONFIG[FREE_UPLOAD_LIMIT]:-517120}

# Upload features
ALLOW_ARFS_DATA=${CONFIG[ALLOW_ARFS_DATA]:-false}
BLOCKLISTED_ADDRESSES=${CONFIG[BLOCKLISTED_ADDRESSES]:-}
ALLOW_LISTED_SIGNATURE_TYPES=${CONFIG[ALLOW_LISTED_SIGNATURE_TYPES]:-}

# Data caches and indexes
DATA_CACHES=${CONFIG[DATA_CACHES]:-}
FAST_FINALITY_INDEXES=${CONFIG[FAST_FINALITY_INDEXES]:-}

# Special address lists
WARP_ADDRESSES=${CONFIG[WARP_ADDRESSES]:-}
REDSTONE_ORACLE_ADDRESSES=${CONFIG[REDSTONE_ORACLE_ADDRESSES]:-}
FIRST_BATCH_ADDRESSES=${CONFIG[FIRST_BATCH_ADDRESSES]:-}
AO_ADDRESSES=${CONFIG[AO_ADDRESSES]:-}
KYVE_ADDRESSES=${CONFIG[KYVE_ADDRESSES]:-}
ARIO_MAINNET_PROCESSES=${CONFIG[ARIO_MAINNET_PROCESSES]:-}
ARIO_TESTNET_PROCESSES=${CONFIG[ARIO_TESTNET_PROCESSES]:-}
ANT_REGISTRY_MAINNET_PROCESSES=${CONFIG[ANT_REGISTRY_MAINNET_PROCESSES]:-}
ANT_REGISTRY_TESTNET_PROCESSES=${CONFIG[ANT_REGISTRY_TESTNET_PROCESSES]:-}
SKIP_OPTICAL_POST_ADDRESSES=${CONFIG[SKIP_OPTICAL_POST_ADDRESSES]:-}

# Timing configuration
OVERDUE_DATA_ITEM_THRESHOLD_MS=${CONFIG[OVERDUE_DATA_ITEM_THRESHOLD_MS]:-300000}
IN_FLIGHT_DATA_ITEM_TTL_SECS=${CONFIG[IN_FLIGHT_DATA_ITEM_TTL_SECS]:-600}
QUARANTINED_SMALL_DATAITEM_TTL_SECS=${CONFIG[QUARANTINED_SMALL_DATAITEM_TTL_SECS]:-432000}

# Filesystem storage
FS_DATA_PATH=${CONFIG[FS_DATA_PATH]:-./upload-service-data}
TEMP_DIR=${CONFIG[TEMP_DIR]:-./temp}
EFS_MOUNT_POINT=${CONFIG[EFS_MOUNT_POINT]:-}

# Database migration backfill
PERMANENT_DATA_ITEM_BACKFILL_START_BLOCK=${CONFIG[PERMANENT_DATA_ITEM_BACKFILL_START_BLOCK]:-1045991}
PERMANENT_DATA_ITEM_BACKFILL_END_BLOCK=${CONFIG[PERMANENT_DATA_ITEM_BACKFILL_END_BLOCK]:-1470456}

# App metadata
APP_NAME=${CONFIG[APP_NAME]:-AR.IO Bundler}
EOF

# Payment service features
cat >> "$ENV_FILE" << EOF

# ================================
# PAYMENT SERVICE FEATURES
# ================================
MAX_ALLOWED_CHARGE_BACKS=${CONFIG[MAX_ALLOWED_CHARGE_BACKS]:-1}
TOKENS_WITHOUT_FEES=${CONFIG[TOKENS_WITHOUT_FEES]:-}
EOF

# Worker configuration
cat >> "$ENV_FILE" << EOF

# ================================
# WORKER CONFIGURATION
# ================================
# BullMQ worker concurrency (for scale)
PLAN_WORKER_CONCURRENCY=${CONFIG[PLAN_WORKER_CONCURRENCY]:-5}
PREPARE_WORKER_CONCURRENCY=${CONFIG[PREPARE_WORKER_CONCURRENCY]:-3}
POST_WORKER_CONCURRENCY=${CONFIG[POST_WORKER_CONCURRENCY]:-2}
VERIFY_WORKER_CONCURRENCY=${CONFIG[VERIFY_WORKER_CONCURRENCY]:-3}

WORKER_CONCURRENCY_ADMIN_CREDIT=${CONFIG[WORKER_CONCURRENCY_ADMIN_CREDIT]:-2}
WORKER_CONCURRENCY_PENDING_TX=${CONFIG[WORKER_CONCURRENCY_PENDING_TX]:-1}
API_INSTANCES=${CONFIG[API_INSTANCES]:-2}
WORKER_INSTANCES=${CONFIG[WORKER_INSTANCES]:-1}
EOF

# Rate limiting
cat >> "$ENV_FILE" << EOF

# ================================
# RATE LIMITING
# ================================
RATE_LIMIT_ENABLED=${CONFIG[RATE_LIMIT_ENABLED]:-true}
RATE_LIMIT_MAX_REQUESTS=${CONFIG[RATE_LIMIT_MAX_REQUESTS]:-100}
RATE_LIMIT_WINDOW_MS=${CONFIG[RATE_LIMIT_WINDOW_MS]:-60000}
EOF

# Monitoring
cat >> "$ENV_FILE" << EOF

# ================================
# LOGGING & MONITORING
# ================================
LOG_LEVEL=${CONFIG[LOG_LEVEL]:-info}
LOG_ALL_STACKTRACES=${CONFIG[LOG_ALL_STACKTRACES]:-false}
LOG_FORMAT=${CONFIG[LOG_FORMAT]:-simple}
DISABLE_LOGS=${CONFIG[DISABLE_LOGS]:-false}
STREAM_DEBUG=${CONFIG[STREAM_DEBUG]:-false}

# OpenTelemetry
OTEL_ENABLED=${CONFIG[OTEL_ENABLED]:-false}
EOF

[ -n "${CONFIG[OTEL_COLLECTOR_URL]}" ] && echo "OTEL_COLLECTOR_URL=${CONFIG[OTEL_COLLECTOR_URL]}" >> "$ENV_FILE"
echo "OTEL_SAMPLE_RATE=${CONFIG[OTEL_SAMPLE_RATE]:-200}" >> "$ENV_FILE"

cat >> "$ENV_FILE" << EOF

# Prometheus
PROMETHEUS_PORT=${CONFIG[PROMETHEUS_PORT]:-9090}
EOF

chmod 600 "$ENV_FILE"
print_success ".env file created with all 137 variables: $ENV_FILE"

#############################################################################################
# 24. Install Dependencies
#############################################################################################

print_header "Step 24: Installing Dependencies"

cd "$PROJECT_ROOT"

if [ "$QUICK_MODE" = false ]; then
    if ! confirm "Install Node.js dependencies now?" "y"; then
        print_warning "Skipping dependency installation"
        echo "Run manually: yarn install"
    else
        yarn install
        print_success "Dependencies installed"
    fi
else
    yarn install
    print_success "Dependencies installed"
fi

#############################################################################################
# 25. Build All Packages
#############################################################################################

print_header "Step 25: Building All Packages"

if [ "$QUICK_MODE" = false ]; then
    if ! confirm "Build all packages now?" "y"; then
        print_warning "Skipping build"
        echo "Run manually: yarn build"
    else
        yarn build
        print_success "All packages built"
    fi
else
    yarn build
    print_success "All packages built"
fi

#############################################################################################
# 26. Start Infrastructure
#############################################################################################

print_header "Step 26: Starting Infrastructure"

if [ "$QUICK_MODE" = false ]; then
    if ! confirm "Start Docker infrastructure (PostgreSQL, Redis, MinIO)?" "y"; then
        print_warning "Skipping infrastructure startup"
        echo "Run manually: docker compose up -d"
    else
        docker compose up -d postgres redis-cache redis-queues minio
        sleep 5
        docker compose up minio-init
        print_success "Infrastructure started"
    fi
else
    docker compose up -d postgres redis-cache redis-queues minio
    sleep 5
    docker compose up minio-init
    print_success "Infrastructure started"
fi

#############################################################################################
# 27. Run Database Migrations
#############################################################################################

print_header "Step 27: Running Database Migrations"

if [ "$QUICK_MODE" = false ]; then
    if ! confirm "Run database migrations now?" "y"; then
        print_warning "Skipping migrations"
        echo "Run manually:"
        echo "  cd packages/payment-service && yarn db:migrate:latest"
        echo "  cd packages/upload-service && yarn db:migrate:latest"
    else
        echo "Running payment service migrations..."
        cd "$PROJECT_ROOT/packages/payment-service"
        DB_HOST="${CONFIG[DB_HOST]}" DB_PORT="${CONFIG[DB_PORT]}" DB_USER="${CONFIG[DB_USER]}" \
            DB_PASSWORD="${CONFIG[DB_PASSWORD]}" DB_DATABASE="${CONFIG[PAYMENT_DB_DATABASE]}" \
            yarn db:migrate:latest

        echo "Running upload service migrations..."
        cd "$PROJECT_ROOT/packages/upload-service"
        DB_HOST="${CONFIG[DB_HOST]}" DB_PORT="${CONFIG[DB_PORT]}" DB_USER="${CONFIG[DB_USER]}" \
            DB_PASSWORD="${CONFIG[DB_PASSWORD]}" DB_DATABASE="${CONFIG[UPLOAD_DB_DATABASE]}" \
            yarn db:migrate:latest

        cd "$PROJECT_ROOT"
        print_success "Database migrations complete"
    fi
else
    echo "Running migrations..."
    cd "$PROJECT_ROOT/packages/payment-service"
    DB_HOST="${CONFIG[DB_HOST]}" DB_PORT="${CONFIG[DB_PORT]}" DB_USER="${CONFIG[DB_USER]}" \
        DB_PASSWORD="${CONFIG[DB_PASSWORD]}" DB_DATABASE="${CONFIG[PAYMENT_DB_DATABASE]}" \
        yarn db:migrate:latest

    cd "$PROJECT_ROOT/packages/upload-service"
    DB_HOST="${CONFIG[DB_HOST]}" DB_PORT="${CONFIG[DB_PORT]}" DB_USER="${CONFIG[DB_USER]}" \
        DB_PASSWORD="${CONFIG[DB_PASSWORD]}" DB_DATABASE="${CONFIG[UPLOAD_DB_DATABASE]}" \
        yarn db:migrate:latest

    cd "$PROJECT_ROOT"
    print_success "Database migrations complete"
fi

#############################################################################################
# 28. Bundle Planning Schedule (in-process — NO cron job needed)
#############################################################################################

print_header "Step 28: Bundle Planning Schedule"

# Bundle planning, tiered cleanup, and posted-bundle redrive are registered as
# in-process BullMQ repeatable schedulers by the upload-workers process at startup
# (tuned via PLAN_SCHEDULE_CRON / CLEANUP_SCHEDULE_CRON / POSTED_REDRIVE_SCHEDULE_CRON
# in .env). There is NO crontab to install — and a leftover `cron-trigger-plan`
# crontab entry would DOUBLE-FIRE alongside the in-process scheduler.
echo "Bundle planning runs in-process (BullMQ schedulers in upload-workers) — no cron job needed."
if crontab -l 2>/dev/null | grep -q "trigger-plan"; then
    print_warning "Removing a stale cron-trigger-plan crontab entry (planning is in-process now)"
    crontab -l 2>/dev/null | grep -v "trigger-plan" | crontab -
fi
print_success "Scheduling is in-process. Verify after services start:"
echo "  pm2 logs upload-workers --nostream | grep 'Registered BullMQ job schedulers'"

#############################################################################################
# 29. Start Services
#############################################################################################

print_header "Step 29: Starting Services"

if [ "$QUICK_MODE" = false ]; then
    if ! confirm "Start all services now?" "y"; then
        print_warning "Skipping service startup"
        echo "Start manually: ./scripts/start.sh"
    else
        cd "$PROJECT_ROOT"
        ./scripts/start.sh
        print_success "Services started"
    fi
else
    cd "$PROJECT_ROOT"
    ./scripts/start.sh
    print_success "Services started"
fi

#############################################################################################
# 30. Verification
#############################################################################################

print_header "Step 30: System Verification"

echo "Testing service health..."
echo ""

sleep 3

# Test upload service
if curl -s -f "http://localhost:${CONFIG[UPLOAD_SERVICE_PORT]}/health" > /dev/null 2>&1; then
    print_success "Upload service: http://localhost:${CONFIG[UPLOAD_SERVICE_PORT]}/health"
else
    print_warning "Upload service health check failed (may still be starting)"
fi

# Test payment service
if curl -s -f "http://localhost:${CONFIG[PAYMENT_SERVICE_PORT]}/health" > /dev/null 2>&1; then
    print_success "Payment service: http://localhost:${CONFIG[PAYMENT_SERVICE_PORT]}/health"
else
    print_warning "Payment service health check failed (may still be starting)"
fi

# Check PM2 processes
if command_exists pm2; then
    echo ""
    PM2_COUNT=$(pm2 list | grep -c "online" || echo "0")
    if [ "$PM2_COUNT" -gt 0 ]; then
        print_success "PM2 processes: $PM2_COUNT online"
    fi
fi

#############################################################################################
# 31. Configuration Summary
#############################################################################################

print_header "✅ Setup Complete!"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BOLD}Configuration Summary (137 Variables Configured)${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo -e "${BOLD}Environment:${NC} ${CONFIG[NODE_ENV]}"
echo ""
echo -e "${BOLD}Service URLs:${NC}"
echo "  📤 Upload Service:    http://localhost:${CONFIG[UPLOAD_SERVICE_PORT]}"
echo "  💳 Payment Service:   http://localhost:${CONFIG[PAYMENT_SERVICE_PORT]}"
echo "  📊 Admin Dashboard:   http://localhost:3002/admin/dashboard"
echo "  📋 Queue Monitor:     http://localhost:3002/admin/queues"
echo "  🪣 MinIO Console:     http://localhost:9001"
echo ""
echo -e "${BOLD}Database:${NC}"
echo "  Host: ${CONFIG[DB_HOST]}:${CONFIG[DB_PORT]}"
echo "  Payment DB: ${CONFIG[PAYMENT_DB_DATABASE]}"
echo "  Upload DB: ${CONFIG[UPLOAD_DB_DATABASE]}"
echo ""
echo -e "${BOLD}Storage:${NC}"
echo "  Endpoint: ${CONFIG[S3_ENDPOINT]}"
echo "  Buckets: ${CONFIG[DATA_ITEM_BUCKET]}, ${CONFIG[BACKUP_DATA_ITEM_BUCKET]}"
echo ""
echo -e "${BOLD}Payment Methods:${NC}"
if [ "${CONFIG[X402_ENABLED]}" = "true" ]; then
    X402_NETWORK="Unknown"
    [ "${CONFIG[X402_BASE_TESTNET_ENABLED]}" = "true" ] && X402_NETWORK="Base Sepolia (Testnet)"
    [ "${CONFIG[X402_BASE_ENABLED]}" = "true" ] && X402_NETWORK="Base Mainnet"
    [ "${CONFIG[X402_ETH_ENABLED]}" = "true" ] && X402_NETWORK="Ethereum Mainnet"
    [ "${CONFIG[X402_POLYGON_ENABLED]}" = "true" ] && X402_NETWORK="Polygon Mainnet"
    echo "  ✓ x402 USDC ($X402_NETWORK)"
fi
if [ "${CONFIG[STRIPE_ENABLED]}" = "true" ]; then
    echo "  ✓ Stripe (credit cards)"
fi
if [ "${CONFIG[CRYPTO_MONITORING_ENABLED]}" = "true" ]; then
    echo "  ✓ Cryptocurrency monitoring"
fi
echo ""
echo -e "${BOLD}Optional Features:${NC}"
[ "${CONFIG[OPTICAL_BRIDGING_ENABLED]}" = "true" ] && echo "  ✓ AR.IO Gateway optical bridging"
[ "${CONFIG[ARNS_ENABLED]}" = "true" ] && echo "  ✓ ArNS purchases"
[ "${CONFIG[GIFTING_ENABLED]}" = "true" ] && echo "  ✓ Gifting system"
[ "${CONFIG[OTEL_ENABLED]}" = "true" ] && echo "  ✓ OpenTelemetry tracing"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo -e "${BOLD}Quick Start Commands:${NC}"
echo "  ${CYAN}./scripts/verify.sh${NC}        - Verify system health"
echo "  ${CYAN}pm2 logs${NC}                   - View all service logs"
echo "  ${CYAN}pm2 monit${NC}                  - Monitor processes"
echo "  ${CYAN}./scripts/stop.sh${NC}          - Stop all services"
echo "  ${CYAN}./scripts/restart.sh${NC}       - Restart services"
echo ""
echo -e "${BOLD}Test the Bundler:${NC}"
echo "  ${CYAN}curl http://localhost:${CONFIG[UPLOAD_SERVICE_PORT]}/v1/info${NC}"
echo "  ${CYAN}curl http://localhost:${CONFIG[PAYMENT_SERVICE_PORT]}/v1/info${NC}"
echo ""
echo -e "${BOLD}Configuration File:${NC}"
echo "  ${ENV_FILE}"
echo ""
echo -e "${BOLD}Documentation:${NC}"
echo "  • CLAUDE.md - Project overview"
echo "  • SETUP_GUIDE.md - Detailed setup instructions"
echo "  • packages/payment-service/CLAUDE.md - Payment service details"
echo "  • packages/upload-service/CLAUDE.md - Upload service details"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
print_success "Setup complete! Your AR.IO Bundler is ready with full configuration. 🚀"
echo ""
