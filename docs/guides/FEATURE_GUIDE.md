# AR.IO Bundler - Comprehensive Feature Guide

**Version:** 1.0.0
**Last Updated:** October 2025
**Status:** Production Ready

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Platform Architecture](#2-platform-architecture)
3. [Payment Processing Features](#3-payment-processing-features)
4. [Data Upload & Bundling Features](#4-data-upload--bundling-features)
5. [Infrastructure & Deployment](#5-infrastructure--deployment)
6. [End-to-End Workflows](#6-end-to-end-workflows)
7. [Technical Specifications](#7-technical-specifications)
8. [Quick Reference](#8-quick-reference)

---

## 1. Executive Summary

### 1.1 What is AR.IO Bundler?

AR.IO Bundler is a **production-grade ANS-104 data bundling platform** that bridges the gap between users and the Arweave permanent web. It provides a complete solution for uploading data to Arweave with flexible payment options, optimistic caching for instant retrieval, and enterprise-grade reliability.

### 1.2 Key Capabilities at a Glance

**Payment Processing:**
- ✅ **x402 HTTP 402 Payment Protocol** (Primary) - USDC payments via Coinbase
- ✅ **9 Blockchain Integrations** - Arweave, Ethereum, Solana, Matic, KYVE, Base, AR.IO
- ✅ **Stripe Credit Card Payments** - 10+ fiat currencies
- ✅ **Promotional Codes & Discounts** - Single-use and general promo codes
- ✅ **Multi-Wallet Payment** - Delegated payment approvals
- ✅ **ArNS Name Purchases** - Arweave Name System integration

**Data Upload & Storage:**
- ✅ **Single & Multipart Uploads** - Up to 10GB per data item
- ✅ **9+ Signature Types** - Arweave, Ethereum, Solana, KYVE, Multiaptos
- ✅ **Raw Data Uploads** - AI-friendly uploads without ANS-104 signing
- ✅ **ANS-104 Bundling** - Full compliance with ANS-104 standard
- ✅ **Instant Retrieval** - AR.IO Gateway optimistic caching (optical posting)
- ✅ **Permanent Storage** - Automatic posting to Arweave network

**Enterprise Features:**
- ✅ **Microservice Architecture** - Separate payment and upload services
- ✅ **Horizontal Scaling** - PM2 cluster mode for APIs
- ✅ **Async Job Processing** - 11 BullMQ queues for fulfillment pipeline
- ✅ **Circuit Breakers** - Resilience against service failures
- ✅ **Comprehensive Monitoring** - Prometheus metrics, Winston logging, OpenTelemetry tracing
- ✅ **Multi-Region Support** - PostgreSQL, Redis, MinIO S3-compatible storage

### 1.3 Use Cases

1. **Decentralized Applications (dApps)** - Permanent storage for NFTs, smart contract data, and application assets
2. **AI Agent Payments** - x402 protocol enables AI agents to pay for uploads with USDC
3. **Content Creators** - Permanent hosting for articles, images, videos, and multimedia
4. **Enterprise Data Archival** - Compliance-grade permanent data storage
5. **Web3 Infrastructure** - Bundle aggregation for cost-effective Arweave posting
6. **ArNS Domain Management** - Purchase and manage Arweave Name System domains

### 1.4 Why AR.IO Bundler?

| Feature | AR.IO Bundler | Traditional Cloud Storage | Other Bundlers |
|---------|---------------|---------------------------|----------------|
| **Permanence** | ✅ Permanent (Arweave) | ❌ Subscription-based | ✅ Permanent |
| **Payment Flexibility** | ✅ Crypto + Fiat + x402 | ✅ Fiat only | ⚠️ Crypto only |
| **Instant Retrieval** | ✅ Optical caching | ✅ Fast | ❌ Wait for mining |
| **Self-Hostable** | ✅ Open source | ❌ Proprietary | ⚠️ Mixed |
| **AI-Friendly Payments** | ✅ x402 protocol | ❌ Not supported | ❌ Not supported |
| **Multi-Wallet Support** | ✅ Delegated approvals | ❌ Single account | ❌ Single wallet |
| **Enterprise Monitoring** | ✅ Full observability | ✅ Full observability | ⚠️ Limited |

---

## 2. Platform Architecture

### 2.1 System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          AR.IO Bundler Platform                              │
│                                                                              │
│  ┌──────────────────┐         ┌──────────────────┐         ┌──────────────┐│
│  │  Payment Service │◄────────┤  Upload Service  │◄────────┤  AR.IO       ││
│  │   (Port 4001)    │  JWT    │   (Port 3001)    │ Optical │  Gateway     ││
│  │                  │  Auth   │                  │ Bridge  │  (Port 4000) ││
│  │ • Stripe         │         │ • Data Upload    │         │              ││
│  │ • Crypto         │         │ • ANS-104        │         │ • Cache      ││
│  │ • x402 USDC      │         │ • Bundling       │         │ • Index      ││
│  │ • ArNS           │         │ • Workers        │         │ • Serve      ││
│  └──────────────────┘         └──────────────────┘         └──────────────┘│
│           │                            │                                     │
│           ▼                            ▼                                     │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                    Infrastructure Layer                               │  │
│  │                                                                       │  │
│  │  PostgreSQL (2 DBs)  •  Redis (Cache + Queues)  •  MinIO (S3)       │  │
│  │  BullMQ (11 Queues)  •  PM2 (5 Processes)       •  Docker Compose    │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│                                      │                                       │
│                                      ▼                                       │
│                            ┌──────────────────┐                             │
│                            │  Arweave Network │                             │
│                            │  (Permanent Web) │                             │
│                            └──────────────────┘                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Microservice Architecture

**Payment Service (packages/payment-service/)**
- **Responsibilities:** Payment processing, balance management, ArNS purchases, x402 protocol
- **Database:** `payment_service` (PostgreSQL)
- **API Port:** 4001
- **Workers:** 2 background workers (crypto payment confirmation, admin credit tool)
- **Queues:** 2 BullMQ queues

**Upload Service (packages/upload-service/)**
- **Responsibilities:** Data upload, ANS-104 bundling, Arweave posting, optical caching
- **Database:** `upload_service` (PostgreSQL)
- **API Port:** 3001
- **Workers:** 11 asynchronous job processors
- **Queues:** 11 BullMQ queues

**Communication Pattern:** Upload Service → Payment Service (HTTP REST with JWT authentication)

### 2.3 Data Flow Architecture

**Upload Flow:**
```
Client Upload → Upload API → Balance Check → Store (Cache + FS + S3)
                    ↓
              Queue Jobs:
              • newDataItem (DB insert)
              • opticalPost (Gateway caching)
              • unbundleBdi (Nested bundle extraction)
                    ↓
              Fulfillment Pipeline:
              planBundle → prepareBundle → postBundle → seedBundle → verifyBundle
                    ↓
              • putOffsets (Offset metadata)
              • cleanupFs (Filesystem cleanup)
                    ↓
              Permanent Storage on Arweave + AR.IO Gateway
```

**Payment Flow (x402 - Primary):**
```
1. Client Request (no payment header)
     ↓
2. Server: 200 OK with payment requirements (x402-1 protocol)
     ↓
3. Client: Create EIP-3009 USDC authorization + EIP-712 signature
     ↓
4. Client: Retry request with X-PAYMENT header
     ↓
5. Server: Verify signature + Settle USDC on-chain + Reserve/Credit balance
     ↓
6. Client: Upload succeeds
     ↓
7. Server: Fraud detection (compare declared vs actual size)
     ↓
8. Finalize: Confirm/Refund/Penalty
```

**Payment Flow (Traditional Balance):**
```
1. User deposits funds (Stripe/Crypto) → Payment Service
     ↓
2. Payment Service credits Winston balance
     ↓
3. Upload Request → Upload Service checks balance
     ↓
4. Upload Service reserves credits via Payment Service API
     ↓
5. Upload succeeds → Credits consumed
   OR Upload fails → Credits refunded
```

### 2.4 Dependency Injection Pattern

Both services use an `Architecture` object injected into Koa middleware context:

**Payment Service Architecture:**
```typescript
interface Architecture {
  paymentDatabase: Database;
  pricingService: PricingService;
  stripe: Stripe;
  emailProvider?: EmailProvider;
  gatewayMap: GatewayMap;  // 9 blockchain gateways
}
```

**Upload Service Architecture:**
```typescript
interface Architecture {
  database: Database;
  objectStore: ObjectStore;  // S3-compatible
  cacheService: CacheService;  // Redis
  paymentService: PaymentService;  // Payment API client
  arweaveGateway: ArweaveGateway;  // Arweave + AR.IO
  x402Service: X402Service;  // x402 payment protocol
  logger: winston.Logger;
  getArweaveWallet: () => JWKInterface;
  tracer?: Tracer;  // OpenTelemetry
}
```

---

## 3. Payment Processing Features

### 3.1 x402 Payment Protocol (Primary Payment Method)

**What is x402?**
- Industry standard for HTTP 402 Payment Required responses
- Developed by Coinbase for AI agent payments
- Uses USDC stablecoin on Ethereum L2 networks (Base, Polygon, Ethereum)
- EIP-3009 (TransferWithAuthorization) + EIP-712 (Typed Signatures)

**Supported Networks:**
- ✅ **Base Mainnet** (Primary) - Low gas fees, fast finality
- ✅ **Base Sepolia** (Testnet) - For development
- ⚠️ **Ethereum Mainnet** (Optional) - Higher gas fees
- ⚠️ **Polygon Mainnet** (Optional) - Alternative L2

**Payment Modes:**
1. **PAYG (Pay-As-You-Go):** Payment covers only this specific upload
2. **Topup:** Payment credits your account balance for future uploads
3. **Hybrid (Default):** Reserve for upload + credit excess to balance

**Three-Phase Flow:**

**Phase 1: Price Quote**
- Endpoint: `GET /v1/x402/price/:signatureType/:address?bytes=N`
- Returns: 200 OK with PaymentRequirements object
- Client learns: USDC amount required, payment timeout, recipient address, USDC contract

**Phase 2: Payment Verification & Settlement**
- Endpoint: `POST /v1/x402/payment/:signatureType/:address`
- Client sends: X-PAYMENT header with EIP-712 signed authorization
- Server validates: Signature, amount, expiration
- Server settles: Calls USDC contract's `receiveWithAuthorization()` on-chain
- Server credits: Creates balance reservation or credits account

**Phase 3: Fraud Detection**
- Endpoint: `POST /v1/x402/finalize` (called by upload service after upload)
- Server compares: Declared byte count vs actual data item size
- Tolerance: 5% variance (configurable via `X402_FRAUD_TOLERANCE_PERCENT`)
- Outcomes:
  - **Confirmed:** Within tolerance, payment accepted
  - **Refunded:** Actual < declared, proportional refund issued
  - **Fraud Penalty:** Actual > declared, payment kept as penalty

**Pricing:**
- Base price: Live Arweave network pricing (from arweave.net/price API)
- Conversion: Winston → USD → USDC (via CoinGecko AR/USD oracle)
- Buffer: 10% markup for price volatility (configurable)
- Minimum: 0.001 USDC (1,000 atomic units)

**Browser Support (Coinbase Onramp):**
- Detects browser clients via `Accept: text/html` header
- Returns HTML paywall with embedded Coinbase Commerce widget
- Users can buy USDC with credit card/bank transfer in-browser
- Requires `X_402_CDP_CLIENT_KEY` environment variable

**API Reference:**
- `GET /v1/x402/price/:signatureType/:address` - Get payment requirements (packages/payment-service/src/routes/x402Price.ts:39)
- `POST /v1/x402/payment/:signatureType/:address` - Verify and settle payment (packages/payment-service/src/routes/x402Payment.ts:36)
- `POST /v1/x402/finalize` - Finalize with fraud detection (packages/payment-service/src/routes/x402Finalize.ts:30)

**Configuration:**
```bash
# Enable x402 (default: true)
X402_ENABLED=true

# Coinbase CDP credentials (REQUIRED for mainnet)
CDP_API_KEY_ID=your-api-key-id
CDP_API_KEY_SECRET=your-api-key-secret
X_402_CDP_CLIENT_KEY=your-client-key  # For browser paywall

# Payment address (REQUIRED)
X402_PAYMENT_ADDRESS=0x1234...

# Network configuration
X402_BASE_ENABLED=true
BASE_MAINNET_RPC_URL=https://mainnet.base.org
X402_BASE_MIN_CONFIRMATIONS=1

# Pricing & fraud detection
X402_PRICING_BUFFER_PERCENT=10
X402_FRAUD_TOLERANCE_PERCENT=5
X402_PAYMENT_TIMEOUT_MS=3600000  # 1 hour
```

### 3.2 Cryptocurrency Payments (Secondary)

**Supported Blockchains:**
1. **Arweave (AR)** - Native token for Arweave storage
2. **Ethereum (ETH)** - Ethereum mainnet
3. **Solana (SOL)** - Solana mainnet
4. **Polygon (MATIC/POL)** - Polygon mainnet
5. **KYVE (KYVE)** - KYVE network
6. **Base ETH** - Ethereum on Base L2
7. **AR.IO (ARIO)** - AR.IO network token (for ArNS only, no fees)

**Payment Workflow:**
1. **Transaction Submission:**
   - Endpoint: `POST /v1/account/balance/:token` with `{ tx_id: "..." }`
   - User submits blockchain transaction hash
   - Server validates transaction on blockchain via gateway
   - Three outcomes:
     - **200:** Already confirmed and credited
     - **202:** Pending confirmation
     - **400:** Invalid transaction

2. **Background Confirmation:**
   - Worker: `creditPendingTx.worker.ts`
   - Polls blockchain every N seconds with exponential backoff
   - Checks for minimum confirmations (varies by blockchain)
   - On confirmation:
     - Moves to `credited_payment_transaction` table
     - Credits user Winston balance
     - Creates audit log entry
     - Sends Slack notification (if configured)

3. **Pricing Conversion:**
   - Non-AR tokens → USD → AR → Winston
   - Uses `TokenToFiatOracle` (CoinGecko API)
   - Infrastructure fee applied (5-15%, except ARIO and tokens in `TOKENS_WITHOUT_FEES`)
   - Special KYVE fee mode: `inclusive_kyve`

**Minimum Confirmations:**
- Arweave: 5 blocks
- Ethereum: 3 blocks
- Solana: 1 signature
- Polygon: 10 blocks
- KYVE: 1 block
- Base: 1 block

**Gateway Implementations:**
- Each blockchain has dedicated gateway class (packages/payment-service/src/gateway/)
- Abstract `Gateway` base class defines interface
- Methods: `validateTransaction()`, `getStatus()`, `getBalance()`, `pollForConfirmation()`

**API Reference:**
- `POST /v1/account/balance/:token` - Submit crypto transaction (packages/payment-service/src/routes/addPendingPaymentTx.ts:38)
- `GET /v1/info` - Get payment wallet addresses (packages/payment-service/src/routes/info.ts)

### 3.3 Stripe Credit Card Payments (Optional)

**Supported Currencies:**
- USD (US Dollar)
- EUR (Euro)
- GBP (British Pound)
- AUD (Australian Dollar)
- CAD (Canadian Dollar)
- JPY (Japanese Yen)
- BRL (Brazilian Real)
- INR (Indian Rupee)
- SGD (Singapore Dollar)
- HKD (Hong Kong Dollar)

**Payment Session Types:**

1. **Checkout Session** (Hosted Stripe page)
   - Endpoint: `GET /v1/top-up/checkout-session/:address/:currency/:amount`
   - Stripe handles entire payment flow
   - Supports crypto payment method (if return URL provided)
   - UI modes: `hosted` (redirect), `embedded` (iframe)

2. **Payment Intent** (Custom UI)
   - Endpoint: `GET /v1/top-up/payment-intent/:address/:currency/:amount`
   - Client builds custom payment UI
   - More control over checkout experience

**Promo Code Support:**
- Query param: `?promoCode[]=CODE1&promoCode[]=CODE2`
- Applies exclusive discounts before charging
- Validates:
  - Code is active (not expired)
  - User is in target group (all/new/existing)
  - Payment meets minimum amount
  - Max uses not exceeded
  - User hasn't used code before

**Email Gifting:**
- Enable with `GIFTING_ENABLED=true`
- Destination address type: `email`
- Recipients get email with redemption link
- Endpoint: `GET /v1/redeem?email=...&destinationAddress=...&id=...&token=...`
- Creates account at redemption address
- Transfers gifted Winston credits

**Webhook Handling:**
- Endpoint: `POST /v1/stripe-webhook`
- Validates webhook signature with `STRIPE_WEBHOOK_SECRET`
- Supported events:
  - `payment_intent.succeeded` → Credit user account
  - `charge.dispute.created` → Create chargeback receipt, debit account

**Automatic Tax Calculation:**
- Enable with `ENABLE_AUTO_STRIPE_TAX=true`
- Uses Stripe Tax API
- Tax code: `txcd_10000000` (Electronically Supplied Services)

**API Reference:**
- `GET /v1/top-up/:method/:address/:currency/:amount` - Create payment session (packages/payment-service/src/routes/topUp.ts:57)
- `POST /v1/stripe-webhook` - Handle webhooks (packages/payment-service/src/routes/stripe/stripeRoute.ts:25)
- `GET /v1/redeem` - Redeem gift (packages/payment-service/src/routes/redeem.ts:30)

**Configuration:**
```bash
STRIPE_ENABLED=true
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
ENABLE_AUTO_STRIPE_TAX=false
TOP_UP_QUOTE_EXPIRATION_MS=1800000  # 30 minutes
```

### 3.4 Balance Management

**Core Operations:**

1. **Check Balance**
   - Endpoint: `GET /v1/balance` (public, requires signature)
   - Returns:
     - `winc`: Spendable balance (after given approvals)
     - `controlledWinc`: Total owned balance
     - `effectiveBalance`: Spendable + received approvals
     - `givenApprovals[]`: Approvals granted to others
     - `receivedApprovals[]`: Approvals received from others

2. **Reserve Balance** (Protected route, inter-service only)
   - Endpoint: `GET /v1/reserve-balance/:token/:address?bytes=N&dataItemId=...`
   - Temporarily locks credits for pending upload
   - Supports multi-payer via `paidBy[]` query param
   - Payment directive: `list-only` or `list-or-signer`
   - Creates `balance_reservation` record
   - Tracks `overflow_spend` for multi-wallet scenarios

3. **Refund Balance** (Protected route, inter-service only)
   - Endpoint: `GET /v1/refund-balance/:token/:address?winstonCredits=N&dataItemId=...`
   - Releases reserved credits back to available balance
   - Used when upload fails or is cancelled

4. **Check Balance Availability** (Protected route, inter-service only)
   - Endpoint: `GET /v1/check-balance/:token/:address?bytes=N&paidBy[]=...`
   - Returns `{ userHasSufficientBalance, bytesCostInWinc, userBalanceInWinc, adjustments }`
   - Does NOT create reservation (dry run)

**Multi-Payer Support:**
- Upload can be paid by multiple wallets
- Payment flow:
  1. Check each `paidBy` address for delegated approvals to signer
  2. Deduct from approvals first (oldest expiration first)
  3. If insufficient, fallback to signer's balance (if directive allows)
  4. Track overflow spend in JSONB: `[{ paying_address, winc_amount }, ...]`
- Use cases:
  - Corporate wallets funding employee uploads
  - Sponsored uploads for community members
  - ArNS purchases funded by multiple contributors

**API Reference:**
- `GET /v1/balance` - Get balance info (packages/payment-service/src/routes/balance.ts:22)
- `GET /v1/reserve-balance/:token/:address` - Reserve credits (packages/payment-service/src/routes/reserveBalance.ts:28)
- `GET /v1/refund-balance/:token/:address` - Refund credits (packages/payment-service/src/routes/refundBalance.ts:27)
- `GET /v1/check-balance/:token/:address` - Check availability (packages/payment-service/src/routes/checkBalance.ts:32)

### 3.5 Delegated Payment Approvals

**Concept:** Allow one address to spend another address's credits

**Operations:**

1. **Create Approval**
   - Endpoint: `GET /v1/account/approvals/create?approvalDataItemId=...&payingAddress=...&approvedAddress=...&approvedWincAmount=...&expiresInSeconds=...`
   - Protected route (requires `PRIVATE_ROUTE_SECRET`)
   - Immediately debits paying address
   - Creates approval with `used_winc_amount = 0`
   - Optional expiration (nullable = no expiration)

2. **Get Approvals**
   - Endpoint: `GET /v1/account/approvals?payingAddress=...&approvedAddress=...`
   - Returns: `{ approvals[], amount, expiresBy }`
   - Backward compatible format for legacy clients

3. **Get All Approvals**
   - Endpoint: `GET /v1/account/approvals/get?userAddress=...`
   - Returns: `{ givenApprovals[], receivedApprovals[] }`
   - Comprehensive view of all approval relationships

4. **Revoke Approvals**
   - Endpoint: `GET /v1/account/approvals/revoke?revokeDataItemId=...&payingAddress=...&approvedAddress=...`
   - Protected route
   - Moves approvals to inactive table with reason `revoked`
   - Refunds unused Winston to paying address

**Lifecycle:**
- **Active:** In `delegated_payment_approval` table
- **Expired:** Moved to `inactive_delegated_payment_approval` (reason: `expired`)
- **Used:** Moved when `used_winc_amount >= approved_winc_amount` (reason: `used`)
- **Revoked:** Moved when revoke called (reason: `revoked`)

**Usage During Upload:**
- Upload service includes `paidBy[]` in reserve balance request
- Payment service checks approvals from each payer to signer
- Deducts from approvals first, then signer balance
- Increments `used_winc_amount` on each use
- Tracks overflow spend in reservation

**API Reference:**
- `GET /v1/account/approvals/create` - Create approval (packages/payment-service/src/routes/createApproval.ts:31)
- `GET /v1/account/approvals` - Get approvals (packages/payment-service/src/routes/getApprovals.ts:24)
- `GET /v1/account/approvals/get` - Get all approvals (packages/payment-service/src/routes/getAllApprovals.ts:23)
- `GET /v1/account/approvals/revoke` - Revoke approvals (packages/payment-service/src/routes/revokeApprovals.ts:26)

### 3.6 ArNS (Arweave Name System) Purchases

**What is ArNS?**
- Decentralized naming system on Arweave (like DNS for Web3)
- Human-readable names pointing to Arweave transaction IDs
- Managed by AR.IO Network smart contracts
- Requires ARIO tokens (AR.IO network token)

**Purchase Intents:**
1. **Buy-Name:** Purchase new ArNS name (permabuy or lease)
2. **Buy-Record:** Purchase existing ArNS name from owner
3. **Extend-Lease:** Extend lease duration for leased name
4. **Upgrade-Name:** Upgrade leased name to permabuy
5. **Increase-Undername-Limit:** Add more undername slots

**Pricing Flow:**

1. **Get Price Quote**
   - Endpoint: `GET /v1/arns/price/:intent/:name?type=lease&years=1`
   - Calls AR.IO Gateway contract for token cost
   - Returns: `{ mARIO, winc, fiatEstimate? }`
   - Optional fiat estimate if `currency` param provided

2. **Initiate Purchase**
   - Endpoint: `POST /v1/arns/purchase/:intent/:name?nonce=...&type=...&years=...`
   - Validates Turbo wallet has sufficient ARIO balance
   - Debits user's Winston balance (converted from mARIO)
   - Submits interaction to AR.IO contract
   - Returns: `{ purchaseReceipt, arioWriteResult: { id: messageId } }`
   - On failure: Marks as failed, refunds user

3. **Check Purchase Status**
   - Endpoint: `GET /v1/arns/purchase/:nonce`
   - Returns: `{ status: "pending"|"success"|"failed", ...details }`
   - Checks: `arns_purchase_receipt`, `failed_arns_purchase`, `arns_purchase_quote`

**Stripe Integration for ArNS:**
- Endpoint: `GET /v1/arns/quote/:method/:address/:currency/:intent/:name`
- Creates Stripe checkout session with ArNS metadata
- Handles Stripe minimums via `excess_winc` (charges minimum, tracks excess)
- On webhook: Credits balance, initiates ArNS purchase

**Multi-Wallet Funding:**
- Supports `paidBy[]` query param
- Multiple wallets can fund single ArNS purchase
- Tracks overflow spend in `arns_purchase_receipt.overflow_spend`

**Special Pricing:**
- ARIO token has NO infrastructure fees (`TOKENS_WITHOUT_FEES` includes `ario`)
- Fee mode: `invert` (adds fee to Winc, user gets more)
- Conversion: mARIO → Winston (no AR middleman)

**API Reference:**
- `GET /v1/arns/price/:intent/:name` - Get price quote (packages/payment-service/src/routes/priceArNSName.ts:27)
- `POST /v1/arns/purchase/:intent/:name` - Initiate purchase (packages/payment-service/src/routes/initiateArNSPurchase.ts:30)
- `GET /v1/arns/purchase/:nonce` - Get purchase status (packages/payment-service/src/routes/getArNSPurchaseStatus.ts)
- `GET /v1/arns/quote/:method/:address/:currency/:intent/:name` - Stripe quote (packages/payment-service/src/routes/arnsPurchaseQuote.ts)

**Configuration:**
```bash
ARNS_ENABLED=true
ARIO_GATEWAY_URL=https://api.arns.app  # AR.IO Gateway URL
TURBO_JWK_FILE=./turbo-wallet.json     # Turbo's ARIO wallet for purchases
```

### 3.7 Pricing & Rate Conversion

**Pricing Service Capabilities:**

1. **Byte-to-Winston Pricing**
   - Method: `getWCForBytes(bytes, userAddress?)`
   - Queries: `https://arweave.net/price/10GiB` (prorated)
   - Applies: Upload adjustment catalogs (discounts)
   - Returns: `{ finalPrice, networkPrice, adjustments[] }`

2. **Fiat Payment Pricing**
   - Method: `getWCForPayment({ payment, promoCodes, userAddress })`
   - Converts: Fiat → USD → AR → Winston
   - Applies: Exclusive adjustments (promo codes), Inclusive adjustments (infra fee)
   - Returns: `{ finalPrice, actualPaymentAmount, quotedPaymentAmount, adjustments[] }`

3. **Cryptocurrency Payment Pricing**
   - Method: `getWCForCryptoPayment({ amount, token, feeMode })`
   - Converts: Token → USD → AR → Winston
   - Fee modes:
     - `default`: Deduct fee from Winc (user gets less)
     - `invert`: Add fee to Winc (user gets more, for ArNS)
     - `none`: No fee (for ARIO and whitelisted tokens)
   - Returns: `{ finalPrice, actualPaymentAmount, inclusiveAdjustments[] }`

**Rate Oracles:**

1. **BytesToWinstonOracle**
   - Source: `https://arweave.net/price/{bytes}`
   - Caching: Configurable TTL
   - Strategy: 10 GiB proration (performance optimization)

2. **TokenToFiatOracle**
   - Source: CoinGecko API (`https://api.coingecko.com/api/v3/simple/price`)
   - Tokens: arweave, ethereum, solana, kyve, matic, ario
   - Caching: Configurable TTL
   - Fallback: Cached price on API failure

3. **X402PricingOracle**
   - Converts: Winston → USD → USDC (6 decimals)
   - Buffer: 10% markup for volatility
   - Minimum: 1,000 atomic units (0.001 USDC)
   - Caching: 1 minute for AR/USD rate

**API Endpoints:**
- `GET /v1/price/bytes/:amount` - Bytes to Winston (packages/payment-service/src/routes/priceBytes.ts)
- `GET /v1/price/:currency/:amount` - Fiat to Winston (packages/payment-service/src/routes/priceFiat.ts)
- `GET /v1/price/:token/:amount` - Crypto to Winston (packages/payment-service/src/routes/priceCrypto.ts)
- `GET /v1/rates` - All rates for 1 GiB (packages/payment-service/src/routes/rates.ts)
- `GET /v1/rates/:currency` - AR to fiat rate (packages/payment-service/src/routes/rates.ts)
- `GET /v1/currencies` - Supported currencies with limits (packages/payment-service/src/routes/currencies.ts)

### 3.8 Promotional Codes & Discounts

**Two Catalog Types:**

1. **Upload Adjustment Catalog** (Applied to byte pricing)
   - Table: `upload_adjustment_catalog`
   - Applied: During `getWCForBytes()` calculation
   - Operators: `multiply` (e.g., 0.6 for 40% off), `add` (fixed discount)
   - Limitations:
     - `byte_count_threshold`: Max bytes eligible (0 = unlimited)
     - `winc_limitation`: Max Winc per user per interval
     - `limitation_interval`: Time window (year/month/day/hour/minute)
   - Example: FWD Research Upload Subsidy (40% discount on uploads < 10 GiB)

2. **Payment Adjustment Catalog** (Applied to payment pricing)
   - Table: `payment_adjustment_catalog`
   - Applied: During `getWCForPayment()` calculation
   - Exclusivity:
     - `exclusive`: Applied before payment (user sees discount, promo codes)
     - `inclusive`: Applied within payment (user doesn't see, infra fee)
     - `inclusive_kyve`: Special KYVE-only fee
   - Example: Turbo Infrastructure Fee (5-15% inclusive)

**Single-Use Promo Codes:**
- Table: `single_use_code_payment_adjustment_catalog`
- Fields:
  - `code_value`: Promo code string (e.g., "TOKEN2049")
  - `target_user_group`: `all`, `new` (never topped up), `existing`
  - `max_uses`: Maximum redemptions (nullable = unlimited)
  - `minimum_payment_amount`: Minimum purchase (USD cents)
  - `maximum_discount_amount`: Discount cap (USD cents)
- Validation:
  - User is in target group
  - Payment meets minimum
  - Code not expired
  - Max uses not exceeded
  - User hasn't used code before
- Usage tracking: `getWincUsedForUploadAdjustmentCatalog()`

**Historical Promo Codes:**
- `TOKEN2049`: 20% off, new users only, expired 2023-09-30
- `YOUTUBE`: 20% off, new users only, currently active

**API Usage:**
- Query param: `?promoCode[]=CODE1&promoCode[]=CODE2`
- Applied to: Top-up, crypto payment, ArNS purchase quotes

---

## 4. Data Upload & Bundling Features

### 4.1 Upload Methods

**1. Single Data Item Upload**
- Endpoint: `POST /v1/tx`
- Max size: 4 GB single request
- Content-Type: `application/octet-stream`
- Signature: ANS-104 signed data item
- Payment: x402 header OR traditional balance
- Features:
  - Streaming upload for large files
  - In-memory processing for small files (<10KB)
  - Duplicate detection via in-flight cache
  - Blocklist and spam filtering
  - Immediate optical posting to AR.IO Gateway

**2. Multipart Upload** (For files > 4 GB or slow connections)
- Create session: `POST /v1/multipart`
- Upload chunks: `PUT /v1/multipart/:uploadId/:chunkOffset`
- Finalize: `POST /v1/multipart/:uploadId/finalize`
- Max size: 10 GB total
- Chunk size: 5 MB - 500 MB (negotiable, default 25 MB)
- AWS S3 multipart compatibility (10,000 part limit)
- Resume support for failed finalizations
- Async validation option

**3. Raw Data Upload** (AI-friendly, no ANS-104 signing required)
- Endpoint: `POST /v1/tx/raw`
- Max size: 10 GB
- Payment: **x402 ONLY** (no traditional balance)
- Signature: Bundler signs data item with its own wallet
- JSON envelope: `{ data: base64, tags: [...], target?: string, anchor?: string }`
- Automatic ANS-104 creation
- x402 payment metadata injected as tags: `x402_tx_hash`, `x402_payment_id`

**API Reference:**
- `POST /v1/tx` - Single upload (packages/upload-service/src/routes/dataItemPost.ts:113)
- `POST /v1/multipart` - Create session (packages/upload-service/src/routes/multiPartUploads.ts:121)
- `PUT /v1/multipart/:uploadId/:chunkOffset` - Upload chunk (packages/upload-service/src/routes/multiPartUploads.ts:354)
- `POST /v1/multipart/:uploadId/finalize` - Finalize upload (packages/upload-service/src/routes/multiPartUploads.ts:545)
- `GET /v1/multipart/:uploadId` - Get upload info (packages/upload-service/src/routes/multiPartUploads.ts:172)
- `GET /v1/multipart/:uploadId/status` - Get status (packages/upload-service/src/routes/multiPartUploads.ts:221)
- `POST /v1/tx/raw` - Raw data upload (packages/upload-service/src/routes/rawDataPost.ts:43)

### 4.2 Signature Types (Multi-Chain Support)

**Supported Signature Types:**
1. **Arweave (1)** - RSA-4096, native Arweave wallets
2. **Solana (2)** - Ed25519, Solana wallets
3. **Ethereum (3)** - ECDSA secp256k1, Ethereum/MetaMask wallets
4. **Kyve (4)** - Cosmos SDK, KYVE network wallets
5. **Multiaptos (5)** - Aptos blockchain
6. **InjectedAptos (6)** - Aptos wallet injection
7. **InjectedEthereum (7)** - EIP-191 personal sign
8. **TypedEthereum (8)** - EIP-712 typed structured data

**Signature Verification:**
- Validates cryptographic signature using `arbundles` library
- Extracts owner public key and address
- Sets `ctx.state.walletAddress` for route handlers
- Passthrough mode: Continues on failure, routes check and reject if needed

**Token Override:**
- Query param: `?token=kyve` (for KYVE signature type)
- Overrides signature type detection

**API Support:**
- Single uploads: All signature types
- Multipart uploads: All signature types
- Raw uploads: Uses bundler's signature (whitelisted wallet)

### 4.3 ANS-104 Bundling

**Bundle Planning:**
- Job: `planBundle` (packages/upload-service/src/jobs/plan.ts)
- Algorithm: First-fit decreasing (BundlePacker)
- Bundle limits:
  - Max size: 2 GB (configurable)
  - Max data items: 10,000 per bundle
- Feature type segregation:
  - Premium bundles (7 types): Warp, Redstone, FirstBatch, AO, KYVE, ArDrive, AR.IO
  - Standard bundles: Everything else
- Overdue handling: Expedites items past deadline (200 blocks)

**Bundle Preparation:**
- Job: `prepareBundle` (packages/upload-service/src/jobs/prepare.ts)
- Steps:
  1. Download data items from S3
  2. Fetch signatures (100 concurrent fetches)
  3. Assemble ANS-104 header (offsets, signatures, owners)
  4. Stream data items into payload
  5. Create Arweave transaction from bundle
  6. Sign transaction with JWK wallet
  7. Add bundle tags: `Bundle-Format: binary`, `Bundle-Version: 2.0.0`, `App-Name: AR.IO Bundler`
  8. Calculate data item offsets for retrieval
  9. Store bundle payload and TX to S3
  10. Insert bundle record to database

**Bundle Tags:**
- `Bundle-Format: binary` - ANS-104 binary format
- `Bundle-Version: 2.0.0` - ANS-104 version
- `App-Name: AR.IO Bundler` - Application name (configurable)
- Custom app names for premium bundles

**Offset Calculation:**
- Tracks byte offset of each data item in bundle
- Format: `{ dataItemId, bundleId, offset, size }`
- Batched for efficiency: 250 offsets per queue message
- Stored in PostgreSQL `data_item_offsets` table (replaced DynamoDB)

**Nested Bundle Support:**
- Job: `unbundleBdi` (packages/upload-service/src/jobs/unbundle-bdi.ts)
- Detects Bundle Data Items (BDIs) via Content-Type tag
- Extracts nested data items using `arbundles` library
- Stores nested items to PostgreSQL (<10KB) or S3 (≥10KB)
- Calculates offsets within parent BDI
- Enqueues nested items for optical posting

**API Reference:**
- Workers run automatically in background
- No direct API endpoints

### 4.4 Arweave Posting & Verification

**Bundle Posting:**
- Job: `postBundle` (packages/upload-service/src/jobs/post.ts)
- Steps:
  1. Post bundle transaction header to Arweave gateway
  2. Post to AR.IO admin queue for priority processing
  3. Record USD/AR conversion rate at posting time
  4. On error: Check wallet balance, demote to new_data_items if failed

**Bundle Seeding:**
- Job: `seedBundle` (packages/upload-service/src/jobs/seed.ts)
- Uploads bundle chunks to Arweave network
- Uses Arweave SDK for chunk streaming
- Timeout: 5 minutes (300,000 ms)

**Bundle Verification:**
- Job: `verifyBundle` (packages/upload-service/src/jobs/verify.ts)
- Confirmation threshold: 18 blocks
- Steps:
  1. Check transaction status on Arweave
  2. Validate bundle header matches database
  3. Process data items in batches of 100 (10 concurrent batches)
  4. Check GraphQL indexing status
  5. On success: Mark bundle as permanent
  6. On dropped (50+ blocks, no confirmations): Re-queue data items
  7. Clean up permanent items from cache

**Dropped Bundle Handling:**
- After 50 blocks without confirmation, bundle considered dropped
- All data items in bundle re-queued as `new_data_items`
- Bundles marked as failed
- Automatic re-bundling in next plan cycle

**API Reference:**
- Workers run automatically in background
- No direct API endpoints

### 4.5 AR.IO Gateway Integration (Optical Posting)

**What is Optical Posting?**
- Immediate data availability BEFORE Arweave confirmation
- Posts data item headers (not full data) to AR.IO Gateway
- Gateway caches and serves data instantly
- Full data posted to Arweave in background
- Result: Instant retrieval (seconds) vs. waiting for mining (minutes)

**Optical Post Job:**
- Queue: `upload-optical-post`
- Concurrency: 5 workers
- Triggered: Immediately after upload completion
- Data: Signed data item header (signature, owner, tags, target, content-type)

**Gateway Hierarchy:**

1. **Primary Optical Bridge** (Required)
   - URL: `OPTICAL_BRIDGE_URL` (e.g., http://localhost:4000/ar-io/admin/queue-data-item)
   - Authentication: `AR_IO_ADMIN_KEY` bearer token
   - Failure: Job fails if primary fails

2. **Optional Optical Bridges** (Best-effort)
   - URLs: `OPTIONAL_OPTICAL_BRIDGE_URLS` (comma-separated)
   - Authentication: Same `AR_IO_ADMIN_KEY`
   - Failure: Logged but doesn't fail job

3. **Canary Optical Bridge** (Testing)
   - URL: `CANARY_OPTICAL_BRIDGE_URL`
   - Sample rate: `CANARY_OPTICAL_SAMPLE_RATE` (0-100, default 0)
   - Purpose: Test new gateway versions
   - Failure: Logged but doesn't fail job

4. **ArDrive Gateways** (Dedicated)
   - URLs: `ARDRIVE_GATEWAY_OPTICAL_URLS` (format: `url|keyName`)
   - Per-gateway admin keys: `ARDRIVE_ADMIN_KEY_${keyName}`
   - Routes ArDrive-specific data items

**Filtering:**
- **Skipped:** Nested BDIs, allow-listed addresses (free uploads)
- **AO Filtering:** Low-priority AO messages excluded from optical posting
- **ArDrive Routing:** ArDrive data routed to dedicated ArDrive gateways only

**Circuit Breakers:**
- Library: `opossum`
- Configuration:
  - Timeout: 10 seconds
  - Error threshold: 50%
  - Reset timeout: 30 seconds
  - Volume threshold: 5 requests
- Sources: `optical_goldsky`, `optical_legacyGateway`, `optical_ardriveGateway`
- Metrics: `circuit_breaker_open_count`, `circuit_breaker_state`

**Bundle Queue Posting:**
- After bundle posts to Arweave, also queues to AR.IO Gateway
- Endpoint: `POST /ar-io/admin/queue-tx` with `{ id: bundleTxId }`
- Gateway indexes bundle for instant retrieval

**Configuration:**
```bash
OPTICAL_BRIDGING_ENABLED=true
OPTICAL_BRIDGE_URL=http://localhost:4000/ar-io/admin/queue-data-item
AR_IO_ADMIN_KEY=your-admin-key
OPTIONAL_OPTICAL_BRIDGE_URLS=http://192.168.2.235:4000/ar-io/admin/queue-data-item
CANARY_OPTICAL_BRIDGE_URL=http://canary-gateway:4000/ar-io/admin/queue-data-item
CANARY_OPTICAL_SAMPLE_RATE=10  # 10% of uploads
ARDRIVE_GATEWAY_OPTICAL_URLS=https://gateway.ardrive.io/ar-io/admin/queue-data-item|ardrive-gateway
ARDRIVE_ADMIN_KEY_ARDRIVE_GATEWAY=ardrive-admin-key
```

### 4.6 Data Storage Architecture

**Triple-Store Replication:**
1. **Redis Cache** (Hot storage, sub-second retrieval)
   - Data item headers
   - Validation results
   - In-flight tracking
2. **Filesystem Backup** (Warm storage, local redundancy)
   - Path: `FS_DATA_PATH` (default: ./upload-service-data)
   - Structure: `{id[0]}/{id[1]}/{id}` (2-level subdirectory)
   - Files: `raw_{id}` (data), `metadata_{id}` (JSON)
3. **S3 Object Store** (Cold storage, durable)
   - Bucket: `DATA_ITEM_BUCKET` (default: raw-data-items)
   - Backup bucket: `BACKUP_DATA_ITEM_BUCKET` (default: backup-data-items)
   - MinIO compatible (S3 API)

**Multipart Upload Storage:**
- Chunks: `{uploadId}/{chunkIndex}` in S3
- Uses AWS S3 multipart API
- ETag tracking for finalization

**Bundle Storage:**
- Payload: `bundles/{planId}` in S3
- Transaction: `bundles/{planId}.tx` in S3

**Cleanup:**
- Job: `cleanupFs` (packages/upload-service/src/jobs/cleanup-fs.ts)
- Deletes permanent data items from filesystem after 24 hours
- Batch size: 500 items
- Concurrency: 8 parallel deletions
- Heartbeat logging every 15 seconds
- Error tolerance: Up to 10 errors before abort

**Quarantine:**
- Invalid data items moved to quarantine namespace
- Metrics: `cache_quarantine_success_count`, `fs_backup_quarantine_success_count`
- TTL: 24 hours

### 4.7 Status & Metadata Retrieval

**Data Item Status:**
- Endpoint: `GET /v1/tx/:id`
- Returns:
  - `status`: `FINALIZED`, `CONFIRMED`, `FAILED`
  - `offset`: Bundle offset metadata (if available)
  - `blockHeight`: Block when bundle was mined
  - `winstonPrice`: Assessed Winston cost
- Cache-Control: 1 day for permanent, 15 seconds for pending

**Data Item Offsets:**
- Endpoint: `GET /v1/tx/:id/offset`
- Returns:
  - `id`: Data item ID
  - `bundleId`: Root bundle ID
  - `offset`: Byte offset in bundle
  - `size`: Data item size
  - `deadlineHeight`: Bundling deadline
  - `parentDataItemId`: Parent BDI (if nested)
  - `payloadContentLength`: Payload size
- Cache-Control: 60 seconds

**Service Information:**
- Endpoint: `GET /v1/info`
- Returns:
  - `version`: Receipt version (0.2.0)
  - `addresses`: Payment wallet addresses (Arweave, Ethereum, Solana, etc.)
  - `gateway`: Public-facing gateway FQDN
  - `freeUploadLimitBytes`: Free upload byte limit (505 KB)

**API Reference:**
- `GET /v1/tx/:id` - Get status (packages/upload-service/src/routes/status.ts:25)
- `GET /v1/tx/:id/offset` - Get offsets (packages/upload-service/src/routes/offsets.ts:21)
- `GET /v1/info` - Get service info (packages/upload-service/src/routes/info.ts)

### 4.8 Premium Bundle Features

**7 Premium Bundle Types:**

1. **Warp Dedicated Bundles**
   - For: SmartWeave contract data
   - Detection: Wallet address in `DEDICATED_WARP_WALLET_ADDRESSES`
   - App name: `Warp`

2. **Redstone Oracle Bundles**
   - For: Redstone price oracle data
   - Detection: Wallet address in `DEDICATED_REDSTONE_WALLET_ADDRESSES`
   - App name: `Redstone`

3. **FirstBatch Bundles**
   - For: FirstBatch platform data
   - Detection: Wallet address in `DEDICATED_FIRST_BATCH_WALLET_ADDRESSES`
   - App name: `FirstBatch`

4. **AO Dedicated Bundles**
   - For: AO hyperparallel computer messages
   - Detection: Process ID in `DEDICATED_AO_PROCESS_IDS`
   - App name: `ao`

5. **KYVE Bundles**
   - For: KYVE network data
   - Detection: Wallet address in `DEDICATED_KYVE_WALLET_ADDRESSES`
   - App name: `KYVE`

6. **ArDrive Bundles**
   - For: ArDrive decentralized storage
   - Detection: Wallet address in `DEDICATED_ARDRIVE_WALLET_ADDRESSES`
   - App name: `ArDrive`
   - Optical routing: ArDrive gateways only

7. **AR.IO Network Bundles**
   - For: AR.IO network processes
   - Detection: Process ID in `DEDICATED_ARIO_PROCESS_IDS`
   - App name: `AR.IO Network`

**Premium Bundle Benefits:**
- Segregated bundling (no mixing with standard data)
- Custom app names in bundle tags
- Faster bundling cycles
- Dedicated optical gateway routing (ArDrive)

**Configuration:**
```bash
DEDICATED_WARP_WALLET_ADDRESSES=addr1,addr2
DEDICATED_REDSTONE_WALLET_ADDRESSES=addr1,addr2
DEDICATED_FIRST_BATCH_WALLET_ADDRESSES=addr1,addr2
DEDICATED_AO_PROCESS_IDS=proc1,proc2
DEDICATED_KYVE_WALLET_ADDRESSES=addr1,addr2
DEDICATED_ARDRIVE_WALLET_ADDRESSES=addr1,addr2
DEDICATED_ARIO_PROCESS_IDS=proc1,proc2
```

### 4.9 Free Upload Features

**Allow-Listed Addresses:**
- Configuration: `ALLOW_LISTED_ADDRESSES` (comma-separated)
- Bypasses all payment checks
- Unlimited uploads (no balance required)
- Use cases: Team members, partners, testing wallets

**Free Upload Limit:**
- Size: 505 KB (configurable via `freeUploadLimitBytes`)
- Applies to: All users (not just allow-listed)
- Condition: Must be ArFS data (if `ALLOW_ARFS_DATA=true`)
- Detection: `ArFS` tag in data item

**Free Upload Allowlist Bypass:**
- Allow-listed signature types (configurable)
- Skips balance checks entirely
- Used for trusted integrations

**Configuration:**
```bash
ALLOW_LISTED_ADDRESSES=addr1,addr2,addr3
ALLOW_ARFS_DATA=true
FREE_UPLOAD_LIMIT_BYTES=517120  # 505 KB
SKIP_BALANCE_CHECKS=false  # Development only, bypasses all checks
```

---

## 5. Infrastructure & Deployment

### 5.1 Process Management (PM2)

**5 Managed Processes:**

1. **payment-service** (Cluster, 2 instances)
   - Port: 4001
   - Mode: Cluster (horizontal scaling)
   - Script: `./packages/payment-service/lib/index.js`
   - Database: `payment_service`

2. **upload-api** (Cluster, 2 instances)
   - Port: 3001
   - Mode: Cluster (horizontal scaling)
   - Script: `./packages/upload-service/lib/index.js`
   - Database: `upload_service`

3. **payment-workers** (Fork, 1 instance) **CRITICAL**
   - Mode: Fork (MUST be 1 to avoid duplicate processing)
   - Script: `./packages/payment-service/lib/workers/index.js`
   - Workers: `creditPendingTx`, `adminCreditTool`

4. **upload-workers** (Fork, 1 instance) **CRITICAL**
   - Mode: Fork (MUST be 1 to avoid duplicate job execution)
   - Script: `./packages/upload-service/lib/workers/allWorkers.js`
   - Workers: 11 BullMQ workers
   - Kill timeout: 30 seconds (graceful shutdown)

5. **bull-board** (Fork, 1 instance)
   - Port: 3002
   - Script: `./packages/upload-service/bull-board-server.js`
   - Dashboard: http://localhost:3002/admin/queues

**PM2 Commands:**
```bash
pm2 start infrastructure/pm2/ecosystem.config.js   # Start all services
pm2 logs                                            # View logs
pm2 logs payment-service                            # Service-specific logs
pm2 monit                                           # Real-time monitoring
pm2 stop all                                        # Stop all services
pm2 restart all                                     # Restart all services
pm2 delete all                                      # Remove all processes
pm2 list                                            # List all processes
```

**Configuration:**
```bash
API_INSTANCES=2       # Number of API instances
WORKER_INSTANCES=1    # MUST be 1 for workers
```

### 5.2 Database Architecture (PostgreSQL)

**2 Separate Databases:**

1. **payment_service**
   - Tables: 30+
   - Schema: Users, payments, receipts, balances, approvals, ArNS, x402
   - Migrations: 21 total (20230316 - 20251027)

2. **upload_service**
   - Tables: 15+
   - Schema: Data items, bundles, plans, multipart uploads, offsets, x402
   - Migrations: 23 total (20220831 - 20251029)
   - Partitioning: `permanent_data_items` partitioned by upload date

**Connection Configuration:**
```bash
DB_HOST=localhost
DB_PORT=5432
DB_USER=turbo_admin
DB_PASSWORD=your-password
DB_DATABASE=payment_service  # or upload_service

# Optional: Separate reader/writer endpoints (Aurora compatibility)
DB_WRITER_ENDPOINT=writer.db.internal
DB_READER_ENDPOINT=reader.db.internal
```

**Connection Pooling:**
- Reader pool: 10 connections
- Writer pool: 10 connections
- Knex.js query builder

**Migration Workflow:**
```bash
# Root-level
yarn db:migrate           # Migrate both services
yarn db:migrate:payment   # Payment service only
yarn db:migrate:upload    # Upload service only

# Service-specific
cd packages/payment-service
yarn db:migrate:latest    # Run pending migrations
yarn db:migrate:rollback  # Rollback last migration
yarn db:migrate:list      # List applied migrations
yarn db:migrate:make NAME # Create new migration
```

**IMPORTANT Migration Pattern:**
1. Add migration logic to migrator file (`src/database/migrator.ts` or `src/arch/db/migrator.ts`)
2. Generate migration: `yarn db:migrate:make NAME`
3. Edit generated file to call migrator function
4. Apply: `yarn db:migrate:latest`

### 5.3 Queue System (BullMQ + Redis)

**Redis Configuration:**
- Cache instance: Port 6379
- Queue instance: Port 6381 (separate from cache)

**13 Total Queues:**

**Upload Service (11 queues):**
1. `upload-plan-bundle` - Bundle planning (concurrency: 1)
2. `upload-prepare-bundle` - Bundle assembly (concurrency: 3)
3. `upload-post-bundle` - Arweave posting (concurrency: 2)
4. `upload-seed-bundle` - Chunk seeding (concurrency: 2)
5. `upload-verify-bundle` - Verification (concurrency: 3)
6. `upload-put-offsets` - Offset storage (concurrency: 5)
7. `upload-new-data-item` - Batch DB insert (concurrency: 5)
8. `upload-optical-post` - Optical posting (concurrency: 5)
9. `upload-unbundle-bdi` - BDI unbundling (concurrency: 2)
10. `upload-finalize-upload` - Multipart finalization (concurrency: 3)
11. `upload-cleanup-fs` - Filesystem cleanup (concurrency: 1)

**Payment Service (2 queues):**
1. `payment-pending-tx` - Crypto payment confirmation
2. `payment-admin-credit` - Admin credit operations

**Queue Features:**
- Retry: 3 attempts with exponential backoff (5s, 25s, 125s)
- Retention: Last 1,000 completed jobs (24 hours), last 5,000 failed jobs (7 days)
- Graceful shutdown: Waits for in-flight jobs to complete

**Bull Board Dashboard:**
- URL: http://localhost:3002/admin/queues
- Features:
  - Real-time job monitoring
  - Job retry/remove
  - Queue pause/resume/drain
  - Job details and logs
  - Performance metrics

**Configuration:**
```bash
REDIS_HOST=localhost
REDIS_PORT_QUEUES=6381
```

### 5.4 Object Storage (MinIO / S3)

**MinIO Configuration:**
- S3 API: Port 9000
- Console: Port 9001 (http://localhost:9001)
- Credentials: `minioadmin` / `minioadmin123` (configurable)

**Buckets:**
1. `raw-data-items` - Primary data item storage
2. `backup-data-items` - Backup/redundant storage

**S3 Client Features:**
- AWS SDK v3 (@aws-sdk/client-s3)
- Multi-region support
- Connection pooling (keep-alive)
- Exponential backoff retry (5 retries, 100ms base)
- Path-style URLs (required for MinIO)

**Environment Configuration:**
```bash
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin123
S3_REGION=us-east-1
S3_FORCE_PATH_STYLE=true  # Required for MinIO
DATA_ITEM_BUCKET=raw-data-items
BACKUP_DATA_ITEM_BUCKET=backup-data-items
```

**Storage Organization:**
- Data items: `{dataItemId}`
- Multipart chunks: `{uploadId}/{chunkIndex}`
- Bundles: `bundles/{planId}`

**Metadata:**
- `payload-content-type`: Content-Type from tags
- `payload-data-start`: Byte offset of payload start

### 5.5 Docker Compose Infrastructure

**6 Core Services:**

1. **PostgreSQL** (Port 5432)
   - Image: `postgres:16.1`
   - Databases: `payment_service`, `upload_service`
   - Init script: `infrastructure/postgres/init-databases.sql`
   - Volume: `postgres-data`

2. **Redis Cache** (Port 6379)
   - Image: `redis:7.2-alpine`
   - Purpose: Data item caching, API caching
   - Volume: `redis-cache-data`

3. **Redis Queues** (Port 6381)
   - Image: `redis:7.2-alpine`
   - Purpose: BullMQ job queues
   - Volume: `redis-queues-data`
   - Command: `redis-server --port 6381`

4. **MinIO** (Ports 9000, 9001)
   - Image: `minio/minio:latest`
   - S3 API: Port 9000
   - Console: Port 9001
   - Volume: `minio-data`
   - Network: `ar-io-network` (for gateway integration)

5. **MinIO Init** (One-time bucket creation)
   - Image: `minio/mc:latest`
   - Creates: `raw-data-items`, `backup-data-items` buckets
   - Sets public read access

6. **Migrators** (One-time database setup)
   - `payment-migrator`: Runs payment service migrations
   - `upload-migrator`: Runs upload service migrations

**Docker Compose Commands:**
```bash
docker compose up -d                     # Start all infrastructure
docker compose down                      # Stop all services
docker compose down -v                   # Stop and remove volumes
docker compose logs -f                   # Follow logs
docker compose restart                   # Restart all services

# Selective control
docker compose up postgres redis-cache redis-queues minio minio-init -d
docker compose stop minio
docker compose restart postgres
```

**External Network:**
- Network: `ar-io-network` (must exist)
- MinIO joins for AR.IO Gateway integration

### 5.6 Monitoring & Observability

**Winston Logging:**
- Format: JSON with timestamp
- Log levels: debug, info, warn, error
- Child loggers with context
- Environment variables:
  - `LOG_LEVEL` - Log level (default: info)
  - `LOG_FORMAT` - json or simple (default: simple)
  - `LOG_ALL_STACKTRACES` - Log all stack traces (default: false)
  - `DISABLE_LOGS` - Disable logging (default: false)

**Prometheus Metrics:**
- Endpoint: `GET /metrics`
- Default metrics: CPU, memory, event loop lag, GC stats
- Custom metrics:
  - Upload service: 25+ metrics (optical failures, circuit breakers, job durations)
  - Payment service: 10+ metrics (Stripe errors, crypto payments, chargebacks)

**OpenTelemetry Tracing (Optional):**
- Exporter: Honeycomb (OTLP)
- Instrumentation: AWS SDK, PostgreSQL, HTTP
- Configuration:
  - `OTEL_SAMPLE_RATE` - Sampling rate (default: 200)
  - `HONEYCOMB_API_KEY` - Honeycomb API key

**Circuit Breakers:**
- Library: `opossum`
- Sources: ElastiCache, FS backup, optical gateways
- Configuration:
  - Timeout: 10 seconds
  - Error threshold: 50%
  - Reset timeout: 30 seconds
  - Volume threshold: 5 requests
- Metrics: `circuit_breaker_open_count`, `circuit_breaker_state`

**Request Logging:**
- Middleware logs all HTTP requests
- Fields: method, URL, status, duration, IP, user agent

### 5.7 Port Allocation

| Service | Port | Description |
|---------|------|-------------|
| Upload API | 3001 | Data upload REST API |
| Bull Board | 3002 | Queue monitoring dashboard |
| AR.IO Gateway | 4000 | AR.IO Gateway (external, optional) |
| Payment API | 4001 | Payment processing REST API |
| PostgreSQL | 5432 | Database server |
| Redis Cache | 6379 | ElastiCache/Redis cache |
| Redis Queues | 6381 | BullMQ job queues |
| MinIO S3 API | 9000 | Object storage API |
| MinIO Console | 9001 | Web UI for MinIO |
| Prometheus | 9090 | Prometheus metrics (optional) |

### 5.8 Environment Configuration

**Shared Configuration (.env):**
```bash
# Core
NODE_ENV=production
PRIVATE_ROUTE_SECRET=your-secret-here  # Generate with: openssl rand -hex 32

# Database
DB_HOST=localhost
DB_PORT=5432
DB_USER=turbo_admin
DB_PASSWORD=your-password

# Redis
REDIS_CACHE_HOST=localhost
REDIS_CACHE_PORT=6379
REDIS_QUEUE_HOST=localhost
REDIS_QUEUE_PORT=6381

# MinIO/S3
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin123
S3_FORCE_PATH_STYLE=true
DATA_ITEM_BUCKET=raw-data-items
BACKUP_DATA_ITEM_BUCKET=backup-data-items

# AR.IO Gateway
OPTICAL_BRIDGING_ENABLED=true
OPTICAL_BRIDGE_URL=http://localhost:4000/ar-io/admin/queue-data-item
AR_IO_ADMIN_KEY=your-admin-key

# Upload Service
TURBO_JWK_FILE=./turbo-wallet.json
MAX_DATA_ITEM_SIZE=10737418240  # 10GB
ALLOW_LISTED_ADDRESSES=addr1,addr2

# Payment Service
PAYMENT_SERVICE_PORT=4001
UPLOAD_SERVICE_PORT=3001
```

**x402 Configuration (.env):**
```bash
X402_ENABLED=true
X402_PAYMENT_ADDRESS=0x1234...
CDP_API_KEY_ID=your-api-key-id
CDP_API_KEY_SECRET=your-api-key-secret
X_402_CDP_CLIENT_KEY=your-client-key
X402_BASE_ENABLED=true
BASE_MAINNET_RPC_URL=https://mainnet.base.org
X402_PRICING_BUFFER_PERCENT=10
X402_FRAUD_TOLERANCE_PERCENT=5
```

**Stripe Configuration (.env):**
```bash
STRIPE_ENABLED=true
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
ENABLE_AUTO_STRIPE_TAX=false
```

---

## 6. End-to-End Workflows

### 6.1 x402 Upload Flow (Primary)

**Step 1: Client Uploads Without Payment**
```http
POST /v1/tx HTTP/1.1
Content-Type: application/octet-stream
Content-Length: 1024000

<binary ANS-104 data item>
```

**Step 2: Server Returns Payment Requirements**
```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "x402Version": 1,
  "accepts": [{
    "scheme": "exact",
    "network": "base-mainnet",
    "maxAmountRequired": "1500",
    "resource": "/v1/tx",
    "description": "Upload 1 MB to Arweave",
    "mimeType": "application/json",
    "payTo": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
    "maxTimeoutSeconds": 3600,
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "extra": {
      "name": "USD Coin",
      "version": "2"
    }
  }]
}
```

**Step 3: Client Creates Payment Authorization**
```javascript
// Client-side (using ethers.js)
const authorization = {
  from: userAddress,
  to: payTo,
  value: maxAmountRequired,
  validAfter: 0,
  validBefore: Math.floor(Date.now() / 1000) + 3600,
  nonce: ethers.utils.hexlify(ethers.utils.randomBytes(32))
};

// EIP-712 domain
const domain = {
  name: "USD Coin",
  version: "2",
  chainId: 8453, // Base mainnet
  verifyingContract: asset
};

// EIP-712 types
const types = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" }
  ]
};

// Sign
const signature = await signer._signTypedData(domain, types, authorization);

// Create payment header
const paymentHeader = btoa(JSON.stringify({
  x402Version: 1,
  scheme: "exact",
  network: "base-mainnet",
  payload: {
    signature,
    authorization
  }
}));
```

**Step 4: Client Retries With Payment Header**
```http
POST /v1/tx HTTP/1.1
Content-Type: application/octet-stream
Content-Length: 1024000
X-PAYMENT: eyJ4NDAyVmVyc2lvbiI6MSwic2NoZW1lIjoiZXhhY3QiLCJuZXR3b3JrIjoiYmFzZS1tYWlubmV0IiwicGF5bG9hZCI6eyJzaWduYXR1cmUiOiIweC4uLiIsImF1dGhvcml6YXRpb24iOnsifX19

<binary ANS-104 data item>
```

**Step 5: Server Verifies & Settles Payment**
- Validates EIP-712 signature
- Calls USDC contract `receiveWithAuthorization()`
- Settles USDC on-chain
- Reserves Winston credits (hybrid mode: reserve + credit excess)
- Stores data item

**Step 6: Server Returns Success With Payment Response**
```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Payment-Response: eyJzdWNjZXNzIjp0cnVlLCJwYXltZW50SWQiOiJ1dWlkIiwidHhIYXNoIjoiMHguLi4iLCJuZXR3b3JrIjoiYmFzZS1tYWlubmV0Iiwid2luY1BhaWQiOiIxMjM0NTY3ODkwIn0=

{
  "id": "abc123...",
  "timestamp": 1234567890,
  "version": "0.2.0",
  "deadlineHeight": 1234800,
  "dataCaches": ["http://localhost:4000"],
  "fastFinalityIndexes": ["http://localhost:4000"],
  "winc": "1234567890"
}
```

**Step 7: Immediate Retrieval via AR.IO Gateway**
```http
GET http://localhost:4000/abc123... HTTP/1.1

HTTP/1.1 200 OK
Content-Type: image/png

<data item payload>
```

**Step 8: Background Fulfillment**
- Optical posting (seconds)
- Bundle planning (14 minutes)
- Bundle preparation (minutes)
- Arweave posting (minutes)
- Verification (18 confirmations)
- Permanent storage (hours)

**Step 9: Finalization & Fraud Detection**
```http
POST /v1/x402/finalize HTTP/1.1
Content-Type: application/json

{
  "dataItemId": "abc123...",
  "actualByteCount": 1024000
}

HTTP/1.1 200 OK

{
  "success": true,
  "status": "confirmed",
  "actualByteCount": 1024000,
  "refundWinc": "0"
}
```

### 6.2 Traditional Upload Flow (Balance-Based)

**Step 1: User Deposits Funds**

**Option A: Crypto Payment**
```http
POST /v1/account/balance/arweave HTTP/1.1
Content-Type: application/json

{
  "tx_id": "abc123..."
}

HTTP/1.1 202 Accepted

{
  "message": "Transaction pending confirmation"
}
```
- Background worker polls blockchain
- On confirmation: Credits balance, creates audit log entry

**Option B: Stripe Payment**
```http
GET /v1/top-up/checkout-session/abc123.../usd/500?successUrl=...&cancelUrl=...

HTTP/1.1 200 OK

{
  "payment_session": {
    "url": "https://checkout.stripe.com/pay/..."
  },
  "topUpQuote": {
    "topUpQuoteId": "uuid",
    "winstonCreditAmount": "123456789012"
  }
}
```
- User completes Stripe checkout
- Webhook credits balance

**Step 2: Client Uploads Data Item**
```http
POST /v1/tx HTTP/1.1
Content-Type: application/octet-stream
Content-Length: 1024000

<binary ANS-104 data item>
```

**Step 3: Upload Service Checks Balance**
- Calls: `GET /v1/check-balance/:token/:address?bytes=1024000`
- Payment service returns: `{ userHasSufficientBalance: true, bytesCostInWinc: "1234567890" }`

**Step 4: Upload Service Reserves Balance**
- Calls: `GET /v1/reserve-balance/:token/:address?bytes=1024000&dataItemId=abc123...`
- Payment service locks Winston credits
- Creates `balance_reservation` record

**Step 5: Upload Service Processes Upload**
- Stores to cache, filesystem, S3
- Enqueues jobs: newDataItem, opticalPost, unbundleBdi
- Returns receipt to client

**Step 6: On Success - Credits Consumed**
- Balance reservation remains
- Credits permanently deducted

**Step 7: On Failure - Credits Refunded**
- Upload service calls: `GET /v1/refund-balance/:token/:address?winstonCredits=1234567890&dataItemId=abc123...`
- Payment service releases reservation
- Credits returned to user

### 6.3 Multipart Upload Flow

**Step 1: Create Upload Session**
```http
POST /v1/multipart HTTP/1.1
Content-Type: application/json

{
  "size": 5000000000,
  "chunkSize": 26214400
}

HTTP/1.1 200 OK

{
  "id": "upload-uuid",
  "chunkSize": 26214400,
  "size": 5000000000
}
```

**Step 2: Upload Chunks**
```http
PUT /v1/multipart/upload-uuid/0 HTTP/1.1
Content-Type: application/octet-stream
Content-Length: 26214400

<chunk 0 data>

HTTP/1.1 200 OK

{
  "id": "upload-uuid",
  "chunkOffset": 0,
  "chunksUploaded": 1
}
```

Repeat for all chunks (0, 26214400, 52428800, ...)

**Step 3: Finalize Upload**
```http
POST /v1/multipart/upload-uuid/finalize HTTP/1.1
Content-Type: application/json

{
  "token": "arweave"
}

HTTP/1.1 200 OK

{
  "id": "data-item-uuid",
  "timestamp": 1234567890,
  "version": "0.2.0",
  "deadlineHeight": 1234800,
  "dataCaches": ["http://localhost:4000"],
  "fastFinalityIndexes": ["http://localhost:4000"],
  "winc": "9876543210"
}
```

**Background Processing:**
- Assembles chunks from S3
- Validates ANS-104 signature
- Checks/reserves balance
- Stores complete data item
- Enqueues fulfillment jobs

**Step 4: Check Status**
```http
GET /v1/multipart/upload-uuid/status HTTP/1.1

HTTP/1.1 200 OK

{
  "id": "upload-uuid",
  "status": "FINALIZED",
  "finalizedAt": "2023-10-29T12:34:56.789Z",
  "receipt": {
    "id": "data-item-uuid",
    ...
  }
}
```

### 6.4 ArNS Purchase Flow

**Step 1: Get Price Quote**
```http
GET /v1/arns/price/Buy-Name/my-name?type=permabuy HTTP/1.1

HTTP/1.1 200 OK

{
  "mARIO": "5000000",
  "winc": "987654321012"
}
```

**Step 2: Initiate Purchase**
```http
POST /v1/arns/purchase/Buy-Name/my-name?nonce=unique-id&type=permabuy HTTP/1.1

HTTP/1.1 200 OK

{
  "purchaseReceipt": {
    "nonce": "unique-id",
    "name": "my-name",
    "owner": "abc123...",
    "winc_qty": "987654321012",
    "mario_qty": "5000000",
    "intent": "Buy-Name",
    "type": "permabuy",
    "message_id": "arweave-tx-id"
  },
  "arioWriteResult": {
    "id": "arweave-tx-id",
    "target": "contract-address"
  }
}
```

**Step 3: Check Purchase Status**
```http
GET /v1/arns/purchase/unique-id HTTP/1.1

HTTP/1.1 200 OK

{
  "status": "success",
  "purchaseReceipt": {
    "nonce": "unique-id",
    "name": "my-name",
    "message_id": "arweave-tx-id"
  }
}
```

### 6.5 Fulfillment Pipeline Flow

**Automatic Background Processing:**

```
Upload Complete
    ↓
┌───────────────────────────────────────────────────────────────┐
│ Phase 1: Immediate Jobs (Seconds)                             │
├───────────────────────────────────────────────────────────────┤
│ • newDataItem: Insert to database                             │
│ • opticalPost: Post to AR.IO Gateway (instant retrieval)      │
│ • unbundleBdi: Detect & extract nested bundles                │
└───────────────────────────────────────────────────────────────┘
    ↓
┌───────────────────────────────────────────────────────────────┐
│ Phase 2: Bundle Planning (14 Minutes)                         │
├───────────────────────────────────────────────────────────────┤
│ • planBundle: Group data items into optimal bundles           │
│   - Feature type segregation (premium vs standard)            │
│   - Size-based planning (max 2 GB, 10,000 items)              │
│   - Overdue detection (200-block deadline)                    │
└───────────────────────────────────────────────────────────────┘
    ↓
┌───────────────────────────────────────────────────────────────┐
│ Phase 3: Bundle Preparation (Minutes)                         │
├───────────────────────────────────────────────────────────────┤
│ • prepareBundle: Assemble ANS-104 bundle                      │
│   - Download data items from S3                               │
│   - Fetch signatures (100 concurrent)                         │
│   - Create bundle header (offsets, signatures)                │
│   - Stream payload assembly                                   │
│   - Create & sign Arweave transaction                         │
│   - Calculate offsets (250 per batch)                         │
│   - Store bundle to S3                                        │
└───────────────────────────────────────────────────────────────┘
    ↓
┌───────────────────────────────────────────────────────────────┐
│ Phase 4: Arweave Posting (Minutes)                            │
├───────────────────────────────────────────────────────────────┤
│ • postBundle: Post transaction to Arweave                     │
│   - Post to Arweave gateway                                   │
│   - Post to AR.IO admin queue (priority)                      │
│   - Record USD/AR conversion rate                             │
│ • seedBundle: Upload chunks (5 min timeout)                   │
│   - Stream bundle for chunking                                │
│   - Upload chunks via Arweave SDK                             │
└───────────────────────────────────────────────────────────────┘
    ↓
┌───────────────────────────────────────────────────────────────┐
│ Phase 5: Verification (Hours - 18 Confirmations)              │
├───────────────────────────────────────────────────────────────┤
│ • verifyBundle: Confirm permanent storage                     │
│   - Check transaction status (18 confirmations)               │
│   - Validate bundle header matches database                   │
│   - Process data items (100 per batch, 10 concurrent)         │
│   - Check GraphQL indexing                                    │
│   - Mark bundle as permanent                                  │
│   - Detect dropped bundles (50+ blocks, no confirmations)     │
└───────────────────────────────────────────────────────────────┘
    ↓
┌───────────────────────────────────────────────────────────────┐
│ Phase 6: Finalization (Hours - 24 Hour Delay)                 │
├───────────────────────────────────────────────────────────────┤
│ • putOffsets: Write offset metadata to PostgreSQL             │
│   - Batch insert (500 items)                                  │
│   - TTL: 365 days                                             │
│ • cleanupFs: Remove filesystem backups                        │
│   - Only permanent items (24+ hours old)                      │
│   - Batch deletion (500 items, 8 concurrent)                  │
│   - Heartbeat logging (15 seconds)                            │
└───────────────────────────────────────────────────────────────┘
    ↓
Permanent Storage on Arweave + AR.IO Gateway
```

**Timeline:**
- **T+0s**: Upload complete, optical posting (instant retrieval)
- **T+14m**: Bundle planning
- **T+20m**: Bundle preparation
- **T+30m**: Arweave posting
- **T+2h**: 18 confirmations (verification)
- **T+24h**: Filesystem cleanup

---

## 7. Technical Specifications

### 7.1 Technology Stack

**Programming Language:**
- TypeScript 5.0
- Node.js 18+

**Web Framework:**
- Koa 3.0 (lightweight HTTP server)
- Koa Router (routing)
- Koa CORS (CORS middleware)

**Database:**
- PostgreSQL 16.1 (2 databases)
- Knex.js (query builder, migrations)

**Caching & Queues:**
- Redis 7.2-alpine (2 instances)
- IORedis (Redis client)
- BullMQ (job queue library)

**Object Storage:**
- MinIO (S3-compatible)
- AWS SDK v3 (@aws-sdk/client-s3)

**Process Management:**
- PM2 (5 processes: 2 APIs, 2 workers, 1 dashboard)

**Blockchain Integration:**
- Arweave - arweave package
- Ethereum - ethers.js
- Solana - @solana/web3.js
- AR.IO - @ar.io/sdk
- ANS-104 - arbundles

**Payment Integration:**
- Stripe - stripe package
- Coinbase CDP - Coinbase SDK
- x402 - EIP-3009, EIP-712

**Observability:**
- Winston (logging)
- Prometheus (metrics - prom-client)
- OpenTelemetry (tracing - optional)

**Resilience:**
- Circuit breakers - opossum
- Retry logic - axios-retry

**Testing:**
- Mocha (test runner)
- Chai (assertions)
- Sinon (mocking)
- ArLocal (local Arweave)

**Code Quality:**
- ESLint, Prettier
- Husky (git hooks)

### 7.2 Performance Characteristics

**Upload Limits:**
- Single upload: 4 GB per request
- Multipart upload: 10 GB total
- Chunk size: 5 MB - 500 MB (default: 25 MB)
- Chunks per upload: 10,000 max (AWS S3 limit)
- Free tier: 505 KB (ArFS data)

**Bundle Limits:**
- Max bundle size: 2 GB (configurable)
- Max data items per bundle: 10,000
- Bundle planning cycle: 14 minutes
- Bundling deadline: 200 blocks

**Queue Concurrency:**
- Plan: 1 worker (sequential planning)
- Prepare: 3 workers (parallel assembly)
- Post: 2 workers (parallel posting)
- Seed: 2 workers (parallel seeding)
- Verify: 3 workers (parallel verification)
- Put Offsets: 5 workers (parallel offset writes)
- New Data Item: 5 workers (parallel DB inserts)
- Optical: 5 workers (parallel gateway posting)
- Unbundle: 2 workers (parallel BDI extraction)
- Finalize: 3 workers (parallel multipart finalization)
- Cleanup: 1 worker (sequential cleanup)

**Batch Sizes:**
- Database inserts: 500 items (PostgreSQL)
- Offset batches: 250 offsets per message
- Verification batches: 100 data items (10 concurrent batches)
- Cleanup batches: 500 items (8 concurrent deletions)

**Retry Configuration:**
- Job retries: 3 attempts
- Backoff: Exponential (5s, 25s, 125s)
- S3 retries: 5 attempts (100ms, 200ms, 400ms, 800ms, 1600ms)
- Circuit breaker: 50% error threshold, 30s reset, 5 request volume

**Timeouts:**
- HTTP requests: 60 seconds
- S3 connections: 5 seconds
- Seed job: 5 minutes (300,000 ms)
- x402 payment: 1 hour (3,600,000 ms)

**Confirmation Thresholds:**
- Arweave: 5 blocks (pending TX), 18 blocks (permanent)
- Ethereum: 3 blocks
- Solana: 1 signature
- Polygon: 10 blocks
- KYVE: 1 block
- Base: 1 block

### 7.3 Storage Architecture

**Data Replication:**
- 3-tier storage: Cache (hot) → Filesystem (warm) → S3 (cold)
- Cache: Redis (sub-second retrieval)
- Filesystem: Local disk (FS_DATA_PATH)
- S3: MinIO/AWS S3 (durable, scalable)

**Data Retention:**
- Permanent items: Forever on Arweave
- Filesystem: 24 hours after permanent
- Cache: Indefinite (Redis eviction policies)
- S3: Indefinite
- Offset metadata: 365 days (configurable TTL)
- Queue jobs: 24 hours (completed), 7 days (failed)

**Database Partitioning:**
- `permanent_data_items`: Partitioned by upload date (monthly)
- Improves query performance for large tables

**Storage Paths:**
- Data items: `{id}`
- Multipart chunks: `{uploadId}/{chunkIndex}`
- Bundles: `bundles/{planId}`
- Filesystem: `{id[0]}/{id[1]}/{id}` (2-level subdirectory)

### 7.4 API Specifications

**Upload Service Endpoints:**
- `POST /v1/tx` - Single upload
- `POST /v1/tx/raw` - Raw data upload
- `POST /v1/multipart` - Create multipart session
- `PUT /v1/multipart/:uploadId/:chunkOffset` - Upload chunk
- `POST /v1/multipart/:uploadId/finalize` - Finalize multipart
- `GET /v1/multipart/:uploadId` - Get upload info
- `GET /v1/multipart/:uploadId/status` - Get upload status
- `GET /v1/tx/:id` - Get data item status
- `GET /v1/tx/:id/offset` - Get offset metadata
- `GET /v1/info` - Get service info

**Payment Service Endpoints:**
- `GET /v1/x402/price/:signatureType/:address` - x402 price quote
- `POST /v1/x402/payment/:signatureType/:address` - x402 payment
- `POST /v1/x402/finalize` - x402 finalization
- `POST /v1/account/balance/:token` - Submit crypto TX
- `GET /v1/top-up/:method/:address/:currency/:amount` - Create Stripe session
- `POST /v1/stripe-webhook` - Stripe webhook
- `GET /v1/redeem` - Redeem gift
- `GET /v1/balance` - Get balance
- `GET /v1/reserve-balance/:token/:address` - Reserve balance (protected)
- `GET /v1/refund-balance/:token/:address` - Refund balance (protected)
- `GET /v1/check-balance/:token/:address` - Check balance (protected)
- `GET /v1/account/approvals/create` - Create approval (protected)
- `GET /v1/account/approvals` - Get approvals
- `GET /v1/account/approvals/get` - Get all approvals
- `GET /v1/account/approvals/revoke` - Revoke approvals (protected)
- `GET /v1/arns/price/:intent/:name` - ArNS price quote
- `POST /v1/arns/purchase/:intent/:name` - ArNS purchase
- `GET /v1/arns/purchase/:nonce` - ArNS purchase status
- `GET /v1/price/bytes/:amount` - Byte pricing
- `GET /v1/price/:currency/:amount` - Fiat pricing
- `GET /v1/price/:token/:amount` - Crypto pricing
- `GET /v1/rates` - All rates for 1 GiB
- `GET /v1/rates/:currency` - AR to fiat rate
- `GET /v1/currencies` - Supported currencies
- `GET /v1/countries` - Supported countries
- `GET /v1/info` - Service info
- `GET /health` - Health check
- `GET /metrics` - Prometheus metrics

### 7.5 Security Features

**Authentication:**
- ANS-104 signature verification (9+ signature types)
- JWT authentication (inter-service communication)
- Protected routes with `PRIVATE_ROUTE_SECRET`
- Stripe webhook signature validation
- x402 EIP-712 signature validation

**Authorization:**
- Signature passthrough mode (routes handle auth)
- Protected routes require secret
- Allow-listed addresses bypass checks
- Delegated payment approvals

**Input Validation:**
- Content-Length header required
- Max upload size enforcement
- Chunk offset validation
- Address format validation (9+ types)
- Signature type validation
- ANS-104 format validation

**Fraud Prevention:**
- x402 byte count comparison (declared vs actual)
- Fraud tolerance: 5% variance
- Fraud penalty: Payment kept
- Overpayment refund: Proportional refund
- Duplicate detection (in-flight cache)

**Security Hardening:**
- Blocklist for banned addresses
- Spam detection (pattern-based)
- Excluded address list (crypto payments)
- Chargeback tracking & alerting
- Quarantine system for invalid data

**Infrastructure Security:**
- Circuit breakers for service resilience
- Retry strategies with exponential backoff
- Graceful shutdown (waits for job completion)
- Error tolerance (up to 10 errors for cleanup jobs)

---

## 8. Quick Reference

### 8.1 Essential Commands

**Initial Setup:**
```bash
yarn install
cp .env.sample .env
# Edit .env with your configuration
docker compose up -d
yarn db:migrate
yarn build
```

**Development:**
```bash
yarn dev:payment    # Terminal 1
yarn dev:upload     # Terminal 2
```

**Production:**
```bash
pm2 start infrastructure/pm2/ecosystem.config.js
pm2 logs
pm2 monit
pm2 stop all
```

**Testing:**
```bash
yarn test:unit                  # Fast unit tests
yarn test:integration:local     # Full integration tests
yarn test:docker                # Isolated Docker tests
```

**Database:**
```bash
yarn db:migrate                 # Migrate both services
yarn db:migrate:payment         # Payment service only
yarn db:migrate:upload          # Upload service only
```

**Monitoring:**
```bash
# Access dashboards
http://localhost:3001/v1/info   # Upload API
http://localhost:4001/v1/info   # Payment API
http://localhost:3002/admin/queues  # Bull Board
http://localhost:9001           # MinIO Console
```

### 8.2 Configuration Checklist

**Required Environment Variables:**
- ✅ `PRIVATE_ROUTE_SECRET` - Inter-service auth (generate with `openssl rand -hex 32`)
- ✅ `TURBO_JWK_FILE` - Arweave wallet for bundle signing
- ✅ `DB_PASSWORD` - PostgreSQL password
- ✅ `X402_PAYMENT_ADDRESS` - Ethereum address for x402 payments (if x402 enabled)

**Optional But Recommended:**
- ⚠️ `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` - Coinbase credentials for x402 mainnet
- ⚠️ `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` - Stripe integration
- ⚠️ `AR_IO_ADMIN_KEY` - AR.IO Gateway authentication
- ⚠️ `ALLOW_LISTED_ADDRESSES` - Free upload addresses

**Production Considerations:**
- 🔒 Never commit `.env` files to git
- 🔒 Rotate `PRIVATE_ROUTE_SECRET` regularly
- 🔒 Use separate `.env.prod` for production
- 🔒 Set `NODE_ENV=production`
- 🔒 Configure `LOG_LEVEL=info` or `warn`
- 🔒 Enable OpenTelemetry for production monitoring
- 🔒 Set up Prometheus scraping for metrics
- 🔒 Configure Slack webhooks for alerts

### 8.3 Common Troubleshooting

**Issue: 402 Payment Required errors on frontend**
- **Cause:** Frontend calling payment service URL instead of upload service
- **Fix:** Update frontend to call upload service at port 3001

**Issue: PM2 workers processing jobs twice**
- **Cause:** Worker instances > 1
- **Fix:** Ensure `WORKER_INSTANCES=1` and mode is `fork` (not `cluster`)

**Issue: Bundles not posting to Arweave**
- **Cause:** Insufficient AR wallet balance
- **Fix:** Fund wallet at `TURBO_JWK_FILE` address

**Issue: x402 payments failing**
- **Cause:** Missing Coinbase credentials or incorrect RPC URL
- **Fix:** Verify `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `BASE_MAINNET_RPC_URL`

**Issue: Database migration errors**
- **Cause:** Migrations written directly in generated files
- **Fix:** Follow migration pattern (add to migrator.ts, generate, edit, apply)

**Issue: Optical posting failures**
- **Cause:** AR.IO Gateway unreachable or missing admin key
- **Fix:** Verify `OPTICAL_BRIDGE_URL`, `AR_IO_ADMIN_KEY`, gateway is running

**Issue: MinIO connection errors**
- **Cause:** Wrong S3_ENDPOINT or missing `S3_FORCE_PATH_STYLE`
- **Fix:** Ensure `S3_ENDPOINT=http://localhost:9000`, `S3_FORCE_PATH_STYLE=true`

**Issue: Queue jobs stuck in "waiting"**
- **Cause:** Workers not running or Redis connection failed
- **Fix:** Check `pm2 logs upload-workers`, verify Redis on port 6381

**Issue: High memory usage**
- **Cause:** Large file uploads held in memory
- **Fix:** Uploads >10KB use streaming, check `MAX_DATA_ITEM_SIZE` setting

**Issue: Stripe webhook failures**
- **Cause:** Invalid webhook secret
- **Fix:** Verify `STRIPE_WEBHOOK_SECRET` matches Stripe dashboard

### 8.4 Key File Locations

**Configuration:**
- `/home/vilenarios/ar-io-bundler/.env` - Root environment
- `/home/vilenarios/ar-io-bundler/packages/payment-service/.env` - Payment config
- `/home/vilenarios/ar-io-bundler/packages/upload-service/.env` - Upload config
- `/home/vilenarios/ar-io-bundler/infrastructure/pm2/ecosystem.config.js` - PM2 config
- `/home/vilenarios/ar-io-bundler/docker-compose.yml` - Infrastructure

**Documentation:**
- `/home/vilenarios/ar-io-bundler/README.md` - Quick start
- `/home/vilenarios/ar-io-bundler/docs/architecture/ARCHITECTURE.md` - Deep dive
- `/home/vilenarios/ar-io-bundler/packages/payment-service/CLAUDE.md` - Payment guide
- `/home/vilenarios/ar-io-bundler/packages/upload-service/CLAUDE.md` - Upload guide

**Logs:**
- PM2 logs: `~/.pm2/logs/`
- Application logs: Configured via `LOG_FILE` env var

**Data:**
- PostgreSQL: `postgres-data` volume
- Redis cache: `redis-cache-data` volume
- Redis queues: `redis-queues-data` volume
- MinIO: `minio-data` volume
- Filesystem: `FS_DATA_PATH` (default: ./upload-service-data)

### 8.5 Getting Help

**Documentation:**
- Project README: `/home/vilenarios/ar-io-bundler/README.md`
- Architecture docs: `/home/vilenarios/ar-io-bundler/docs/architecture/ARCHITECTURE.md`
- Service guides: `packages/*/CLAUDE.md`

**External Resources:**
- AR.IO Gateway: https://docs.ar.io
- x402 Protocol: https://github.com/coinbase/x402
- ANS-104 Standard: https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-104.md
- Arweave Docs: https://docs.arweave.org
- Coinbase CDP: https://docs.cdp.coinbase.com

**Support:**
- GitHub Issues: (Project repository)
- Community: AR.IO Discord, Arweave Discord

---

## Appendix: Complete Feature Matrix

| Feature Category | Features | Status |
|------------------|----------|--------|
| **Payment Methods** | x402 USDC (Base, Ethereum, Polygon) | ✅ Primary |
| | Arweave (AR) | ✅ Supported |
| | Ethereum (ETH) | ✅ Supported |
| | Solana (SOL) | ✅ Supported |
| | Polygon (MATIC/POL) | ✅ Supported |
| | KYVE | ✅ Supported |
| | Base ETH | ✅ Supported |
| | AR.IO (ARIO) | ✅ Supported (ArNS only) |
| | Stripe (10+ currencies) | ✅ Supported |
| | Email gifting | ✅ Optional |
| **Upload Methods** | Single data item upload (4 GB) | ✅ Supported |
| | Multipart upload (10 GB) | ✅ Supported |
| | Raw data upload (AI-friendly) | ✅ Supported |
| | 9+ signature types | ✅ Supported |
| **Bundling** | ANS-104 compliance | ✅ Full compliance |
| | Intelligent packing | ✅ Supported |
| | Premium bundles (7 types) | ✅ Supported |
| | Nested bundle extraction | ✅ Supported |
| | Offset tracking | ✅ Supported |
| **Instant Retrieval** | AR.IO Gateway optical posting | ✅ Supported |
| | Multi-gateway support | ✅ Supported |
| | Circuit breakers | ✅ Supported |
| **Balance Management** | Multi-wallet payment | ✅ Supported |
| | Delegated approvals | ✅ Supported |
| | Balance reservations | ✅ Supported |
| | Refunds | ✅ Supported |
| **ArNS** | Name purchases | ✅ Supported |
| | 5 purchase intents | ✅ Supported |
| | Multi-wallet funding | ✅ Supported |
| **Pricing** | Promotional codes | ✅ Supported |
| | Dynamic currency limits | ✅ Supported |
| | Live rate conversion | ✅ Supported |
| **Infrastructure** | PM2 process management | ✅ Supported |
| | Docker Compose orchestration | ✅ Supported |
| | PostgreSQL (2 databases) | ✅ Supported |
| | Redis (cache + queues) | ✅ Supported |
| | MinIO S3-compatible storage | ✅ Supported |
| | BullMQ (13 queues) | ✅ Supported |
| **Monitoring** | Winston logging | ✅ Supported |
| | Prometheus metrics | ✅ Supported |
| | OpenTelemetry tracing | ✅ Optional |
| | Bull Board dashboard | ✅ Supported |
| **Security** | Signature verification | ✅ Supported |
| | x402 fraud detection | ✅ Supported |
| | Blocklist & spam filtering | ✅ Supported |
| | Circuit breakers | ✅ Supported |
| | Protected routes | ✅ Supported |

---

**END OF GUIDE**

For the latest updates and detailed implementation notes, refer to:
- `/home/vilenarios/ar-io-bundler/docs/architecture/ARCHITECTURE.md`
- `/home/vilenarios/ar-io-bundler/packages/payment-service/CLAUDE.md`
- `/home/vilenarios/ar-io-bundler/packages/upload-service/CLAUDE.md`
