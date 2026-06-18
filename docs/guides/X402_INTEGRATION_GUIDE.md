# x402 Payment Integration Guide

**AR.IO Bundler x402 Implementation**

**Version:** 1.0.0
**Last Updated:** October 2025
**Protocol:** x402-1 (Coinbase x402 Standard)
**Payment Standard:** EIP-3009 (TransferWithAuthorization)
**Signature Standard:** EIP-712 (Typed Structured Data)

---

## Table of Contents

1. [Overview](#1-overview)
2. [x402 Protocol Fundamentals](#2-x402-protocol-fundamentals)
3. [AR.IO Bundler x402 Architecture](#3-ario-bundler-x402-architecture)
4. [Signed Data Items with x402](#4-signed-data-items-with-x402)
5. [Unsigned Data Blobs with x402](#5-unsigned-data-blobs-with-x402)
6. [Payment Modes](#6-payment-modes)
7. [Fraud Detection & Finalization](#7-fraud-detection--finalization)
8. [Network Configuration](#8-network-configuration)
9. [Implementation Examples](#9-implementation-examples)
10. [Testing & Debugging](#10-testing--debugging)
11. [Security Considerations](#11-security-considerations)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Overview

### 1.1 What is x402?

x402 is an industry-standard protocol developed by Coinbase for enabling **HTTP 402 Payment Required** responses with blockchain-based payments. It enables:

- **AI Agent Payments**: AI agents can autonomously pay for API services
- **Gasless USDC Transfers**: Uses EIP-3009 for meta-transactions (no ETH needed for gas)
- **Pay-Per-Use APIs**: Pay exactly for what you consume
- **Decentralized Payments**: No centralized payment processor required

### 1.2 Why x402 for AR.IO Bundler?

**Traditional Balance Model Problems:**
1. Users must pre-fund accounts (friction)
2. No way to pay for exact usage (overpayment)
3. Not AI-agent friendly (agents can't manage accounts)
4. Requires centralized balance tracking

**x402 Solution:**
1. ✅ **Pay-as-you-go**: Pay only for each upload
2. ✅ **No account required**: Anonymous uploads possible
3. ✅ **AI-friendly**: Agents can pay autonomously with USDC
4. ✅ **Instant settlements**: On-chain payment verification
5. ✅ **Standard protocol**: Compatible with Coinbase Commerce ecosystem

### 1.3 AR.IO Bundler x402 Implementation

AR.IO Bundler implements x402 as the **PRIMARY payment method** for:

**✅ Signed ANS-104 Data Items** (`POST /v1/tx`)
- User signs data item with their Arweave/Ethereum/Solana wallet
- User pays with x402 USDC payment
- Data item uploaded to Arweave with original signature intact

**✅ Unsigned Data Blobs** (`POST /v1/tx/raw`)
- User sends raw data (no ANS-104 signature)
- User pays with x402 USDC payment
- Bundler signs data item with its own wallet
- Data item uploaded to Arweave with bundler signature + x402 payment metadata

---

## 2. x402 Protocol Fundamentals

### 2.1 Three-Phase Payment Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ Phase 1: Price Quote (GET Request without payment)              │
├─────────────────────────────────────────────────────────────────┤
│ Client → Server:  "How much for 1 MB upload?"                   │
│ Server → Client:  "200 OK with payment requirements"            │
│                   (NOT 402! Spec changed in x402-1)             │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ Phase 2: Payment & Upload (Same request with payment header)    │
├─────────────────────────────────────────────────────────────────┤
│ Client → Server:  "Here's 1 MB data + payment authorization"    │
│                   • X-PAYMENT header (base64 JSON)              │
│                   • EIP-3009 transfer authorization             │
│                   • EIP-712 signature                           │
│                                                                 │
│ Server validates: • Signature verification                      │
│                   • Amount verification                         │
│                   • Expiration check                            │
│                   • On-chain settlement                         │
│                                                                 │
│ Server → Client:  "200 OK with receipt"                        │
│                   • X-Payment-Response header                   │
│                   • Upload receipt with payment ID              │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ Phase 3: Finalization (After upload processed)                  │
├─────────────────────────────────────────────────────────────────┤
│ Server processes: • Compare declared vs actual byte count       │
│                   • Fraud detection (±5% tolerance)             │
│                   • Refund overpayment or penalize fraud        │
│                                                                 │
│ Three outcomes:   • CONFIRMED (within tolerance)                │
│                   • REFUNDED (actual < declared)                │
│                   • FRAUD_PENALTY (actual > declared)           │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Payment Requirements Object

When client requests without payment, server returns payment requirements:

```json
{
  "x402Version": 1,
  "accepts": [{
    "scheme": "exact",
    "network": "base-mainnet",
    "maxAmountRequired": "1500",
    "resource": "/v1/tx",
    "description": "Upload 1 MB to Arweave via AR.IO Bundler",
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

**Key Fields:**
- `scheme`: "exact" (EIP-3009 payment scheme)
- `network`: Blockchain network (base-mainnet, ethereum, polygon)
- `maxAmountRequired`: USDC amount in smallest unit (6 decimals)
- `asset`: USDC contract address
- `payTo`: Recipient Ethereum address
- `maxTimeoutSeconds`: Payment authorization timeout

### 2.3 Payment Header Format

Client includes X-PAYMENT header (base64-encoded JSON):

```json
{
  "x402Version": 1,
  "scheme": "exact",
  "network": "base-mainnet",
  "payload": {
    "signature": "0x1234567890abcdef...",
    "authorization": {
      "from": "0xUserAddress...",
      "to": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
      "value": "1500",
      "validAfter": 0,
      "validBefore": 1730000000,
      "nonce": "0xabcdef..."
    }
  }
}
```

**EIP-712 Signature:** The `signature` field is an EIP-712 signature of the `authorization` object using USDC contract's domain and types.

**EIP-3009 Authorization:** The `authorization` object conforms to USDC's `transferWithAuthorization` or `receiveWithAuthorization` function parameters.

### 2.4 Payment Response Header

Server includes X-Payment-Response header in success response (base64-encoded JSON):

```json
{
  "success": true,
  "paymentId": "uuid-payment-id",
  "txHash": "0xabcdef1234567890...",
  "network": "base-mainnet",
  "wincPaid": "1234567890",
  "wincReserved": "1000000000",
  "wincCredited": "234567890",
  "mode": "hybrid"
}
```

---

## 3. AR.IO Bundler x402 Architecture

### 3.1 Service Responsibilities

```
┌──────────────────────────────────────────────────────────────────┐
│                    Upload Service (Port 3001)                     │
├──────────────────────────────────────────────────────────────────┤
│ • POST /v1/tx         - Signed data items with x402              │
│ • POST /v1/tx/raw     - Unsigned data blobs with x402 (REQUIRED) │
│ • Validates Content-Length header                                │
│ • Extracts X-PAYMENT header                                      │
│ • Calls payment service for verification & settlement            │
│ • Stores data item with payment metadata                         │
│ • Returns receipt with X-Payment-Response header                 │
└──────────────────────────────────────────────────────────────────┘
                            ↓ (HTTP REST API)
┌──────────────────────────────────────────────────────────────────┐
│                   Payment Service (Port 4001)                     │
├──────────────────────────────────────────────────────────────────┤
│ • GET /v1/x402/price/:signatureType/:address                     │
│   → Returns payment requirements (200 OK)                        │
│                                                                  │
│ • POST /v1/x402/payment/:signatureType/:address                  │
│   → Verifies EIP-712 signature                                   │
│   → Settles USDC payment on-chain (EIP-3009)                     │
│   → Creates payment record in PostgreSQL                         │
│   → Returns payment result                                       │
│                                                                  │
│ • POST /v1/x402/finalize                                         │
│   → Fraud detection (declared vs actual bytes)                   │
│   → Refund/penalty calculation                                   │
│   → Updates payment status                                       │
└──────────────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────────┐
│                      Blockchain Networks                          │
├──────────────────────────────────────────────────────────────────┤
│ • Base Mainnet (Primary) - Low fees, fast finality               │
│ • Ethereum Mainnet       - Highest security                      │
│ • Polygon Mainnet        - Alternative L2                        │
│                                                                  │
│ USDC Contract Methods:                                           │
│ • receiveWithAuthorization(...)  - Meta-transaction payment      │
└──────────────────────────────────────────────────────────────────┘
```

### 3.2 Database Schema

**PostgreSQL Tables (upload_service database):**

```sql
-- x402 payment transactions
CREATE TABLE x402_payment_transaction (
  id UUID PRIMARY KEY,
  user_address TEXT NOT NULL,           -- Arweave/Ethereum/Solana address
  user_address_type TEXT NOT NULL,      -- arweave, ethereum, solana
  tx_hash TEXT NOT NULL,                -- Blockchain transaction hash
  network TEXT NOT NULL,                -- base-mainnet, ethereum, polygon
  token_address TEXT NOT NULL,          -- USDC contract address
  usdc_amount TEXT NOT NULL,            -- USDC paid (6 decimals)
  winc_amount TEXT NOT NULL,            -- Winston equivalent
  mode TEXT NOT NULL,                   -- payg, topup, hybrid
  data_item_id TEXT,                    -- Upload ID (null for topup)
  declared_byte_count BIGINT,           -- User-declared size
  actual_byte_count BIGINT,             -- Verified size after upload
  status TEXT NOT NULL,                 -- pending_validation, confirmed, refunded, fraud_penalty
  paid_at TIMESTAMP NOT NULL,
  finalized_at TIMESTAMP,
  refund_winc TEXT,                     -- Refund amount if applicable
  payer_address TEXT NOT NULL           -- Ethereum address that authorized payment
);

-- x402 payment reservations (for PAYG/hybrid modes)
CREATE TABLE x402_payment_reservation (
  data_item_id TEXT PRIMARY KEY,
  x402_payment_id UUID NOT NULL REFERENCES x402_payment_transaction(id),
  winc_reserved TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL,
  expires_at TIMESTAMP NOT NULL         -- Auto-expire after 1 hour
);
```

### 3.3 Component Architecture

**packages/upload-service/src/arch/x402Service.ts:**
```typescript
export interface X402Service {
  // Get payment requirements for upload
  getPaymentRequirements(params: {
    byteCount: number;
    network: string;
  }): PaymentRequirements;

  // Verify payment authorization signature
  verifyPayment(params: {
    paymentHeader: string;
    byteCount: number;
  }): Promise<{ isValid: boolean; invalidReason?: string }>;

  // Settle payment on-chain
  settlePayment(params: {
    authorization: Authorization;
    signature: string;
    network: string;
  }): Promise<{ success: boolean; transactionHash?: string; error?: string }>;
}
```

**packages/upload-service/src/utils/x402Pricing.ts:**
```typescript
export class X402PricingOracle {
  // Convert Winston to USDC atomic units
  async getUSDCForWinston(winston: Winston): Promise<string> {
    // 1. Get AR/USD rate from CoinGecko
    // 2. Convert Winston → AR → USD → USDC
    // 3. Add 10% pricing buffer
    // 4. Enforce 1000 atomic unit minimum (0.001 USDC)
  }

  // Convert USDC to Winston
  async getWinstonForUSDC(usdcAtomicUnits: string): Promise<Winston> {
    // Reverse conversion for refund calculations
  }
}
```

**packages/payment-service/src/routes/x402Price.ts:**
- Returns payment requirements for all enabled networks
- Browser detection: Returns HTML paywall for browsers
- API clients: Returns JSON payment requirements

**packages/payment-service/src/routes/x402Payment.ts:**
- Validates payment header
- Verifies EIP-712 signature
- Settles payment on-chain
- Creates payment record
- Handles payment modes (payg/topup/hybrid)

**packages/payment-service/src/routes/x402Finalize.ts:**
- Compares declared vs actual byte count
- Calculates refund/penalty
- Updates payment status
- Creates audit log entries

---

## 4. Signed Data Items with x402

### 4.1 Overview

**Use Case:** User has their own Arweave/Ethereum/Solana wallet and wants to upload signed data items while paying with USDC.

**Flow:**
1. User creates ANS-104 data item signed with their wallet
2. User gets price quote from server
3. User creates x402 payment authorization
4. User uploads data item + payment in single request
5. Server verifies payment, settles USDC, stores data item
6. Data item posted to Arweave with **user's signature** (not bundler's)

**Endpoint:** `POST /v1/tx`

### 4.2 Request Format

**Without Payment (Price Quote):**
```http
POST /v1/tx HTTP/1.1
Host: localhost:3001
Content-Type: application/octet-stream
Content-Length: 1024000

<binary ANS-104 data item>
```

**Server Response (Payment Requirements):**
```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "x402Version": 1,
  "accepts": [
    {
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
    },
    {
      "scheme": "exact",
      "network": "ethereum",
      "maxAmountRequired": "1500",
      ...
    }
  ]
}
```

**With Payment (Actual Upload):**
```http
POST /v1/tx HTTP/1.1
Host: localhost:3001
Content-Type: application/octet-stream
Content-Length: 1024000
X-PAYMENT: eyJ4NDAyVmVyc2lvbiI6MSwic2NoZW1lIjoiZXhhY3QiLCJuZXR3b3JrIjoiYmFzZS1tYWlubmV0IiwicGF5bG9hZCI6eyJzaWduYXR1cmUiOiIweC4uLiIsImF1dGhvcml6YXRpb24iOnsiZnJvbSI6IjB4Li4uIiwidG8iOiIweC4uLiIsInZhbHVlIjoiMTUwMCIsInZhbGlkQWZ0ZXIiOjAsInZhbGlkQmVmb3JlIjoxNzMwMDAwMDAwLCJub25jZSI6IjB4Li4uIn19fQ==

<binary ANS-104 data item>
```

**Server Response (Success with Payment):**
```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Payment-Response: eyJzdWNjZXNzIjp0cnVlLCJwYXltZW50SWQiOiJ1dWlkIiwidHhIYXNoIjoiMHguLi4iLCJuZXR3b3JrIjoiYmFzZS1tYWlubmV0Iiwid2luY1BhaWQiOiIxMjM0NTY3ODkwIiwid2luY1Jlc2VydmVkIjoiMTAwMDAwMDAwMCIsIndpbmNDcmVkaXRlZCI6IjIzNDU2Nzg5MCIsIm1vZGUiOiJoeWJyaWQifQ==

{
  "id": "data-item-id-abc123",
  "timestamp": 1730000000,
  "version": "0.2.0",
  "deadlineHeight": 1234800,
  "dataCaches": ["http://localhost:4000"],
  "fastFinalityIndexes": ["http://localhost:4000"],
  "winc": "1234567890",
  "owner": "user-public-address"
}
```

### 4.3 Implementation Details

**File:** `packages/upload-service/src/routes/dataItemPost.ts`

**Key Logic:**

```typescript
// Line 206-238: Extract X-PAYMENT header
const paymentHeader = ctx.request.headers['x-payment'];
if (paymentHeader) {
  // Decode and parse payment
  const paymentData = JSON.parse(
    Buffer.from(paymentHeader, 'base64').toString('utf-8')
  );

  // Validate required Content-Length header
  if (!contentLength) {
    throw new BadRequest('Content-Length header required for x402 payments');
  }

  // Store payment data for later verification
  ctx.state.x402Payment = paymentData;
}

// Line 331-374: Verify and settle x402 payment
if (ctx.state.x402Payment) {
  const paymentResult = await paymentService.verifyAndSettleX402Payment({
    paymentHeader: ctx.request.headers['x-payment'],
    dataItemId: id,
    byteCount: contentLength,
    nativeAddress: ownerPublicAddress,
    signatureType,
    mode: 'hybrid'  // Default mode
  });

  if (!paymentResult.success) {
    throw new PaymentError('x402 payment verification failed');
  }

  // Store payment ID for later reference
  ctx.state.x402PaymentId = paymentResult.paymentId;
}

// Line 1006-1031: Add X-Payment-Response header to response
if (ctx.state.x402PaymentId) {
  const paymentResponse = {
    success: true,
    paymentId: ctx.state.x402PaymentId,
    txHash: paymentResult.txHash,
    network: paymentResult.network,
    wincPaid: paymentResult.wincPaid,
    wincReserved: paymentResult.wincReserved,
    wincCredited: paymentResult.wincCredited,
    mode: paymentResult.mode
  };

  ctx.set(
    'X-Payment-Response',
    Buffer.from(JSON.stringify(paymentResponse)).toString('base64')
  );
}
```

**Fraud Detection:**

```typescript
// After upload processed, compare declared vs actual size
const actualByteCount = dataItem.size;
const declaredByteCount = contentLength;

await paymentService.finalizeX402Payment({
  dataItemId: id,
  actualByteCount
});

// In payment service (x402Finalize.ts:30-157):
const tolerance = X402_FRAUD_TOLERANCE_PERCENT; // 5%
const lowerBound = declared * (1 - tolerance / 100);
const upperBound = declared * (1 + tolerance / 100);

if (actual >= lowerBound && actual <= upperBound) {
  status = 'confirmed';  // Within tolerance
} else if (actual < lowerBound) {
  status = 'refunded';
  refund = calculateProportionalRefund(declared, actual);
} else {
  status = 'fraud_penalty';  // Keep payment as penalty
}
```

### 4.4 Payment Modes for Signed Data Items

**PAYG (Pay-As-You-Go):**
- Payment covers ONLY this specific upload
- Creates x402_payment_reservation
- No balance credit
- Reservation expires after 1 hour if not used

**Topup:**
- Payment credits entire amount to user account balance
- No reservation for this upload
- Uses traditional balance system for upload
- Good for users who will upload multiple times

**Hybrid (Default):**
- Reserves min(paid, cost) for this upload
- Credits max(0, paid - cost) to balance
- Best of both worlds
- Example: Pay $2, upload costs $1.50, reserve $1.50, credit $0.50

---

## 5. Unsigned Data Blobs with x402

### 5.1 Overview

**Use Case:** AI agents or users who don't have Arweave wallets but want to upload data to Arweave using USDC payments.

**Key Difference from Signed Data Items:**
- User sends **raw data** (not ANS-104)
- Bundler creates and signs ANS-104 data item
- x402 payment is **REQUIRED** (no traditional balance option)
- Payment metadata injected as data item tags

**Flow:**
1. User sends raw data (binary or JSON envelope)
2. User gets price quote
3. User creates x402 payment authorization
4. User uploads data + payment in single request
5. Server verifies payment, settles USDC
6. Server creates ANS-104 data item signed with **bundler's wallet**
7. Server adds x402 payment metadata as tags
8. Data item posted to Arweave with bundler signature

**Endpoint:** `POST /v1/tx/raw`

### 5.2 Request Format

**JSON Envelope (Recommended):**
```http
POST /v1/tx/raw HTTP/1.1
Host: localhost:3001
Content-Type: application/json
Content-Length: 2048
X-PAYMENT: <base64-payment-header>

{
  "data": "SGVsbG8gV29ybGQh",
  "tags": [
    {"name": "Content-Type", "value": "text/plain"},
    {"name": "App-Name", "value": "MyApp"}
  ],
  "target": "",
  "anchor": ""
}
```

**Binary + Headers (Alternative):**
```http
POST /v1/tx/raw HTTP/1.1
Host: localhost:3001
Content-Type: image/png
Content-Length: 1024000
X-PAYMENT: <base64-payment-header>
X-Content-Type: image/png
X-Tags: [{"name":"Description","value":"Cat photo"}]

<binary data>
```

**Server Response:**
```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Payment-Response: <base64-payment-response>

{
  "id": "bundler-signed-data-item-id",
  "timestamp": 1730000000,
  "version": "0.2.0",
  "deadlineHeight": 1234800,
  "dataCaches": ["http://localhost:4000"],
  "fastFinalityIndexes": ["http://localhost:4000"],
  "winc": "1234567890",
  "owner": "bundler-public-address",
  "tags": [
    {"name": "Content-Type", "value": "image/png"},
    {"name": "x402_tx_hash", "value": "0xabcdef..."},
    {"name": "x402_payment_id", "value": "uuid"},
    {"name": "x402_network", "value": "base-mainnet"},
    {"name": "x402_payer", "value": "0xUserAddress..."}
  ]
}
```

### 5.3 Implementation Details

**File:** `packages/upload-service/src/routes/rawDataPost.ts`

**Key Logic:**

```typescript
// Line 74-199: x402 payment is REQUIRED for raw data uploads
const paymentHeader = ctx.request.headers['x-payment'];
if (!paymentHeader) {
  // Return payment requirements (no traditional balance fallback)
  return await handlePaymentRequired(ctx);
}

// Extract payment data
const paymentData = JSON.parse(
  Buffer.from(paymentHeader, 'base64').toString('utf-8')
);

// Validate Content-Length
const contentLength = parseInt(ctx.request.headers['content-length'] || '0');
if (!contentLength) {
  throw new BadRequest('Content-Length header required for x402 payments');
}

// Line 125-129: Get USDC price for upload
const { winstonCost } = await getWinstonCostForBytes(contentLength);
const usdcAmount = await x402PricingOracle.getUSDCForWinston(winstonCost);

// Line 157-199: Verify and settle payment
const paymentResult = await paymentService.verifyAndSettleX402Payment({
  paymentHeader,
  dataItemId: generateId(),  // Pre-generate ID
  byteCount: contentLength,
  nativeAddress: extractAddressFromPayment(paymentData),
  signatureType: 3,  // Ethereum (x402 uses Ethereum addresses)
  mode: 'payg'  // Default for raw uploads
});

// Line 205-236: Create ANS-104 data item with bundler signature
const dataItem = createDataItem({
  data: rawData,
  tags: [
    ...userTags,
    // Inject x402 payment metadata
    { name: 'x402_tx_hash', value: paymentResult.txHash },
    { name: 'x402_payment_id', value: paymentResult.paymentId },
    { name: 'x402_network', value: paymentResult.network },
    { name: 'x402_payer', value: paymentData.payload.authorization.from }
  ],
  target: userTarget,
  anchor: userAnchor
});

// Sign with bundler's JWK wallet
await dataItem.sign(getArweaveWallet());

// Line 268-278: Store x402 payment record
await database.insertX402Payment({
  id: paymentResult.paymentId,
  dataItemId: dataItem.id,
  txHash: paymentResult.txHash,
  network: paymentResult.network,
  usdcAmount,
  wincAmount: winstonCost,
  declaredByteCount: contentLength,
  payerAddress: paymentData.payload.authorization.from
});
```

### 5.4 x402 Payment Metadata Tags

**Automatically Injected Tags:**

| Tag Name | Description | Example |
|----------|-------------|---------|
| `x402_tx_hash` | Blockchain transaction hash | `0xabcdef1234567890...` |
| `x402_payment_id` | Internal payment UUID | `550e8400-e29b-41d4-a716-446655440000` |
| `x402_network` | Blockchain network | `base-mainnet` |
| `x402_payer` | Ethereum address that paid | `0x742d35Cc...` |

**Why These Tags Matter:**
1. **Audit Trail**: Permanent on-chain payment proof
2. **Dispute Resolution**: Link data to payment transaction
3. **Analytics**: Track payment sources and networks
4. **Compliance**: Regulatory requirements for payment tracking

### 5.5 Raw Data Upload Advantages

**For AI Agents:**
- No need to understand ANS-104 format
- No need to manage Arweave wallets
- Simple HTTP POST with data + payment
- Automatic signature handling

**For Developers:**
- Simpler integration (no arbundles library needed)
- No client-side signing complexity
- Works with any programming language
- Standard HTTP + JSON

**Trade-offs:**
- Data item signed by bundler (not user)
- x402 payment REQUIRED (no balance option)
- Slightly higher trust in bundler

---

## 6. Payment Modes

### 6.1 PAYG (Pay-As-You-Go)

**Concept:** Payment covers ONLY this specific upload.

**Database Records:**
```sql
-- x402_payment_transaction
INSERT INTO x402_payment_transaction (
  id, user_address, tx_hash, network, usdc_amount,
  winc_amount, mode, data_item_id, declared_byte_count,
  status, paid_at, payer_address
) VALUES (
  'uuid', 'abc123...', '0xabc...', 'base-mainnet', '1500',
  '1234567890', 'payg', 'data-item-id', 1024000,
  'confirmed', NOW(), '0x742d...'
);

-- x402_payment_reservation
INSERT INTO x402_payment_reservation (
  data_item_id, x402_payment_id, winc_reserved,
  created_at, expires_at
) VALUES (
  'data-item-id', 'uuid', '1234567890',
  NOW(), NOW() + INTERVAL '1 hour'
);
```

**Use Case:**
- One-time uploads
- AI agents paying per request
- No account management desired

**Implementation:**
```typescript
// In x402Payment.ts
if (mode === 'payg') {
  // Create reservation only
  await database.createX402PaymentReservation({
    dataItemId,
    x402PaymentId: paymentId,
    wincReserved: wincAmount,
    expiresAt: new Date(Date.now() + 3600000)  // 1 hour
  });

  return {
    wincPaid: wincAmount,
    wincReserved: wincAmount,
    wincCredited: '0'
  };
}
```

### 6.2 Topup

**Concept:** Payment credits entire amount to user account balance.

**Database Records:**
```sql
-- x402_payment_transaction (no data_item_id)
INSERT INTO x402_payment_transaction (
  id, user_address, tx_hash, network, usdc_amount,
  winc_amount, mode, data_item_id, status, paid_at
) VALUES (
  'uuid', 'abc123...', '0xabc...', 'base-mainnet', '5000',
  '4000000000', 'topup', NULL, 'confirmed', NOW()
);

-- user table balance update
UPDATE user
SET winston_credit_balance = winston_credit_balance + 4000000000
WHERE user_address = 'abc123...';

-- audit_log
INSERT INTO audit_log (
  user_address, winston_credit_amount, change_reason, change_id
) VALUES (
  'abc123...', 4000000000, 'x402_topup', 'uuid'
);
```

**Use Case:**
- Users who will upload multiple times
- Pre-funding account for convenience
- Avoiding payment overhead per upload

**Implementation:**
```typescript
// In x402Payment.ts
if (mode === 'topup') {
  // Credit entire amount to balance
  await database.adjustUserWinstonBalance({
    userAddress: nativeAddress,
    winstonAmount: wincAmount,
    changeReason: 'x402_topup',
    changeId: paymentId
  });

  return {
    wincPaid: wincAmount,
    wincReserved: '0',
    wincCredited: wincAmount
  };
}
```

### 6.3 Hybrid (Default)

**Concept:** Reserve for upload + credit excess to balance.

**Example Calculation:**
```javascript
const wincPaid = 2000000000;      // User paid
const uploadCost = 1500000000;     // Upload costs

const wincReserved = Math.min(wincPaid, uploadCost);  // 1500000000
const wincCredited = Math.max(0, wincPaid - uploadCost);  // 500000000
```

**Database Records:**
```sql
-- x402_payment_transaction
INSERT INTO x402_payment_transaction (
  id, winc_amount, mode, data_item_id, ...
) VALUES (
  'uuid', '2000000000', 'hybrid', 'data-item-id', ...
);

-- x402_payment_reservation (for upload)
INSERT INTO x402_payment_reservation (
  data_item_id, x402_payment_id, winc_reserved, ...
) VALUES (
  'data-item-id', 'uuid', '1500000000', ...
);

-- user balance update (excess)
UPDATE user
SET winston_credit_balance = winston_credit_balance + 500000000
WHERE user_address = 'abc123...';

-- audit_log (excess credit)
INSERT INTO audit_log (
  user_address, winston_credit_amount, change_reason, change_id
) VALUES (
  'abc123...', 500000000, 'x402_hybrid_excess', 'uuid'
);
```

**Use Case:**
- Best of both worlds (DEFAULT)
- Overpayments automatically credited
- Single upload with future credit

**Implementation:**
```typescript
// In x402Payment.ts
if (mode === 'hybrid') {
  const uploadCost = await getUploadCost(byteCount);
  const wincReserved = Math.min(wincAmount, uploadCost);
  const wincCredited = Math.max(BigInt(0), BigInt(wincAmount) - BigInt(uploadCost));

  // Create reservation for upload
  await database.createX402PaymentReservation({
    dataItemId,
    x402PaymentId: paymentId,
    wincReserved: wincReserved.toString()
  });

  // Credit excess to balance
  if (wincCredited > 0) {
    await database.adjustUserWinstonBalance({
      userAddress: nativeAddress,
      winstonAmount: wincCredited.toString(),
      changeReason: 'x402_hybrid_excess',
      changeId: paymentId
    });
  }

  return {
    wincPaid: wincAmount,
    wincReserved: wincReserved.toString(),
    wincCredited: wincCredited.toString()
  };
}
```

---

## 7. Fraud Detection & Finalization

### 7.1 The Problem

**Declared vs Actual Byte Count:**
- Client declares size in Content-Length header
- Payment calculated based on declared size
- Actual data item might be different size
- **Fraud Risk:** Client lies about size to pay less

**Example Attack:**
```
Client declares: 1 KB (Content-Length: 1024)
Server charges: $0.0001 (based on 1 KB)
Client sends:    1 MB (actual data)
Server stores:   1 MB (costs $0.10)
Result:          Server loses $0.0999
```

### 7.2 Fraud Detection Algorithm

**File:** `packages/payment-service/src/routes/x402Finalize.ts`

**Logic:**
```typescript
// Line 30-157: Finalization with fraud detection
export async function finalizeX402Payment({
  dataItemId,
  actualByteCount
}: {
  dataItemId: string;
  actualByteCount: number;
}) {
  // 1. Fetch payment record
  const payment = await database.getX402PaymentByDataItemId(dataItemId);
  const declaredByteCount = payment.declared_byte_count;

  // 2. Calculate tolerance bounds
  const tolerance = X402_FRAUD_TOLERANCE_PERCENT || 5;  // 5% default
  const lowerBound = declaredByteCount * (1 - tolerance / 100);
  const upperBound = declaredByteCount * (1 + tolerance / 100);

  // 3. Determine outcome
  let status: 'confirmed' | 'refunded' | 'fraud_penalty';
  let refundWinc = '0';

  if (actualByteCount >= lowerBound && actualByteCount <= upperBound) {
    // Within tolerance - CONFIRMED
    status = 'confirmed';
  } else if (actualByteCount < lowerBound) {
    // Actual < declared - REFUND overpayment
    status = 'refunded';
    refundWinc = calculateProportionalRefund(
      payment.winc_amount,
      declaredByteCount,
      actualByteCount
    );

    // Credit refund to user balance
    await database.adjustUserWinstonBalance({
      userAddress: payment.user_address,
      winstonAmount: refundWinc,
      changeReason: 'x402_overpayment_refund',
      changeId: payment.id
    });
  } else {
    // Actual > declared - FRAUD PENALTY
    status = 'fraud_penalty';

    // Keep payment as penalty
    logger.warn('x402 fraud detected', {
      dataItemId,
      declaredByteCount,
      actualByteCount,
      userAddress: payment.user_address
    });

    // Create fraud audit log
    await database.createAuditLog({
      userAddress: payment.user_address,
      winstonAmount: '0',
      changeReason: 'x402_fraud_penalty',
      changeId: payment.id
    });
  }

  // 4. Update payment record
  await database.updateX402Payment({
    id: payment.id,
    actualByteCount,
    status,
    refundWinc,
    finalizedAt: new Date()
  });

  return {
    success: true,
    status,
    actualByteCount,
    refundWinc
  };
}
```

### 7.3 Refund Calculation

**Proportional Refund Formula:**
```typescript
function calculateProportionalRefund(
  wincPaid: string,
  declaredBytes: number,
  actualBytes: number
): string {
  // Price per byte: wincPaid / declaredBytes
  const pricePerByte = BigInt(wincPaid) / BigInt(declaredBytes);

  // Fair cost: actualBytes * pricePerByte
  const fairCost = BigInt(actualBytes) * pricePerByte;

  // Refund: wincPaid - fairCost
  const refund = BigInt(wincPaid) - fairCost;

  return refund.toString();
}
```

**Example:**
```
Declared: 1000 KB
Actual:   800 KB
Paid:     $1.00 (1,000,000 USDC atomic units)

Price per KB: $1.00 / 1000 = $0.001
Fair cost:    800 * $0.001 = $0.80
Refund:       $1.00 - $0.80 = $0.20

User gets $0.20 refund credited to balance
```

### 7.4 Tolerance Configuration

**Environment Variable:**
```bash
X402_FRAUD_TOLERANCE_PERCENT=5
```

**Why 5% Tolerance?**
1. **ANS-104 Overhead:** Data item encoding adds ~100 bytes overhead
2. **Tag Overhead:** Tags add variable bytes
3. **Rounding Errors:** Byte count calculations may vary slightly
4. **Network Overhead:** HTTP chunking may affect Content-Length

**Adjusting Tolerance:**
- **Lower (1-2%):** Stricter fraud detection, more refunds/penalties
- **Higher (10%):** More lenient, fewer refunds/penalties
- **Production:** 5% is recommended balance

### 7.5 Finalization Call Flow

```
Upload Complete
    ↓
Upload Service: Data item processed and stored
    ↓
Upload Service: Calls Payment Service finalization
    ↓
POST /v1/x402/finalize
{
  "dataItemId": "abc123...",
  "actualByteCount": 1024000
}
    ↓
Payment Service: Fraud detection algorithm
    ↓
Payment Service: Update payment status + refund if needed
    ↓
Response:
{
  "success": true,
  "status": "confirmed",
  "actualByteCount": 1024000,
  "refundWinc": "0"
}
```

---

## 8. Network Configuration

### 8.1 Supported Networks

**Base Mainnet (Primary - Recommended):**
```bash
X402_BASE_ENABLED=true
BASE_MAINNET_RPC_URL=https://mainnet.base.org
X402_BASE_MIN_CONFIRMATIONS=1
X402_FACILITATOR_URL_BASE=https://facilitator.base.org  # Optional
```

**Features:**
- ✅ Low gas fees (~$0.01 per transaction)
- ✅ Fast finality (2 second blocks)
- ✅ Ethereum L2 security
- ✅ USDC native support
- ✅ Coinbase ecosystem integration

**Ethereum Mainnet (High Security):**
```bash
X402_ETH_ENABLED=false  # Disabled by default (high gas fees)
ETHEREUM_MAINNET_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
X402_ETH_MIN_CONFIRMATIONS=3
X402_FACILITATOR_URL_ETH=https://facilitator.ethereum.org
```

**Features:**
- ✅ Highest security (Ethereum mainnet)
- ⚠️ High gas fees (~$5-50 per transaction)
- ⚠️ Slower finality (12 second blocks)
- Use case: High-value uploads only

**Polygon Mainnet (Alternative L2):**
```bash
X402_POLYGON_ENABLED=false  # Disabled by default
POLYGON_MAINNET_RPC_URL=https://polygon-rpc.com
X402_POLYGON_MIN_CONFIRMATIONS=10
X402_FACILITATOR_URL_POLYGON=https://facilitator.polygon.org
```

**Features:**
- ✅ Low gas fees (~$0.001 per transaction)
- ✅ Fast finality (2 second blocks)
- ⚠️ Lower security than Ethereum mainnet
- Use case: Cost-sensitive applications

**Base Sepolia Testnet (Development):**
```bash
X402_BASE_TESTNET_ENABLED=true  # For development only
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
X402_FACILITATOR_URL_BASE_TESTNET=https://x402.org/facilitator  # Public facilitator
```

**Features:**
- ✅ Free testnet USDC
- ✅ Same interface as mainnet
- ✅ Public facilitator available
- Use case: Development and testing

### 8.2 USDC Contract Addresses

**Base Mainnet:**
```
0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```

**Ethereum Mainnet:**
```
0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
```

**Polygon Mainnet:**
```
0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
```

**Base Sepolia Testnet:**
```
0x036CbD53842c5426634e7929541eC2318f3dCF7e
```

### 8.3 Multi-Network Support

**Client chooses network when creating payment:**
```json
{
  "x402Version": 1,
  "scheme": "exact",
  "network": "base-mainnet",  // Client specifies network
  "payload": { ... }
}
```

**Server supports multiple networks simultaneously:**
- Price quote returns payment requirements for ALL enabled networks
- Client chooses preferred network
- Server validates payment against chosen network

**Network Selection Criteria:**
1. **Gas Costs:** Base < Polygon < Ethereum
2. **Security:** Ethereum > Base > Polygon
3. **Speed:** Base = Polygon > Ethereum
4. **Ecosystem:** Base (Coinbase) vs Polygon (Matic)

---

## 9. Implementation Examples

### 9.1 JavaScript Client (Signed Data Items)

**Using ethers.js and arbundles:**

```javascript
import { ethers } from 'ethers';
import { DataItem } from 'arbundles';
import Arweave from 'arweave';

// 1. Create ANS-104 data item
const arweave = Arweave.init({});
const dataItem = new DataItem(Buffer.from('Hello World!'));
await dataItem.sign(arweaveJWK);

// 2. Get price quote
const response1 = await fetch('http://localhost:3001/v1/tx', {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: dataItem.getRaw()
});

const paymentRequirements = await response1.json();
const baseNetwork = paymentRequirements.accepts.find(
  n => n.network === 'base-mainnet'
);

// 3. Create EIP-3009 authorization
const signer = new ethers.Wallet(ethereumPrivateKey);
const authorization = {
  from: await signer.getAddress(),
  to: baseNetwork.payTo,
  value: baseNetwork.maxAmountRequired,
  validAfter: 0,
  validBefore: Math.floor(Date.now() / 1000) + 3600,
  nonce: ethers.utils.hexlify(ethers.utils.randomBytes(32))
};

// 4. Sign with EIP-712
const domain = {
  name: 'USD Coin',
  version: '2',
  chainId: 8453, // Base mainnet
  verifyingContract: baseNetwork.asset
};

const types = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' }
  ]
};

const signature = await signer._signTypedData(domain, types, authorization);

// 5. Create payment header
const paymentHeader = {
  x402Version: 1,
  scheme: 'exact',
  network: 'base-mainnet',
  payload: { signature, authorization }
};

const paymentHeaderBase64 = Buffer.from(
  JSON.stringify(paymentHeader)
).toString('base64');

// 6. Upload with payment
const response2 = await fetch('http://localhost:3001/v1/tx', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/octet-stream',
    'Content-Length': dataItem.getRaw().length.toString(),
    'X-PAYMENT': paymentHeaderBase64
  },
  body: dataItem.getRaw()
});

const receipt = await response2.json();
const paymentResponse = JSON.parse(
  Buffer.from(
    response2.headers.get('X-Payment-Response'),
    'base64'
  ).toString('utf-8')
);

console.log('Upload successful!');
console.log('Data Item ID:', receipt.id);
console.log('Payment ID:', paymentResponse.paymentId);
console.log('TX Hash:', paymentResponse.txHash);
console.log('Winc Reserved:', paymentResponse.wincReserved);
console.log('Winc Credited:', paymentResponse.wincCredited);
```

### 9.2 Python Client (Unsigned Data Blobs)

**Using requests and web3.py:**

```python
import requests
import base64
import json
from web3 import Web3
from eth_account.messages import encode_structured_data

# 1. Prepare raw data
data = b"Hello from Python!"
tags = [
    {"name": "Content-Type", "value": "text/plain"},
    {"name": "App-Name", "value": "PythonApp"}
]

payload = {
    "data": base64.b64encode(data).decode('utf-8'),
    "tags": tags
}

# 2. Get price quote
response1 = requests.post(
    'http://localhost:3001/v1/tx/raw',
    json=payload,
    headers={'Content-Length': str(len(json.dumps(payload)))}
)

payment_requirements = response1.json()
base_network = next(
    n for n in payment_requirements['accepts']
    if n['network'] == 'base-mainnet'
)

# 3. Create EIP-3009 authorization
w3 = Web3()
account = w3.eth.account.from_key(ethereum_private_key)

authorization = {
    "from": account.address,
    "to": base_network['payTo'],
    "value": int(base_network['maxAmountRequired']),
    "validAfter": 0,
    "validBefore": int(time.time()) + 3600,
    "nonce": w3.keccak(text=str(random.random())).hex()
}

# 4. Sign with EIP-712
structured_data = {
    "types": {
        "EIP712Domain": [
            {"name": "name", "type": "string"},
            {"name": "version", "type": "string"},
            {"name": "chainId", "type": "uint256"},
            {"name": "verifyingContract", "type": "address"}
        ],
        "TransferWithAuthorization": [
            {"name": "from", "type": "address"},
            {"name": "to", "type": "address"},
            {"name": "value", "type": "uint256"},
            {"name": "validAfter", "type": "uint256"},
            {"name": "validBefore", "type": "uint256"},
            {"name": "nonce", "type": "bytes32"}
        ]
    },
    "primaryType": "TransferWithAuthorization",
    "domain": {
        "name": "USD Coin",
        "version": "2",
        "chainId": 8453,
        "verifyingContract": base_network['asset']
    },
    "message": authorization
}

signed = account.sign_message(encode_structured_data(structured_data))

# 5. Create payment header
payment_header = {
    "x402Version": 1,
    "scheme": "exact",
    "network": "base-mainnet",
    "payload": {
        "signature": signed.signature.hex(),
        "authorization": authorization
    }
}

payment_header_base64 = base64.b64encode(
    json.dumps(payment_header).encode('utf-8')
).decode('utf-8')

# 6. Upload with payment
response2 = requests.post(
    'http://localhost:3001/v1/tx/raw',
    json=payload,
    headers={
        'Content-Length': str(len(json.dumps(payload))),
        'X-PAYMENT': payment_header_base64
    }
)

receipt = response2.json()
payment_response = json.loads(
    base64.b64decode(response2.headers['X-Payment-Response'])
)

print(f"Upload successful!")
print(f"Data Item ID: {receipt['id']}")
print(f"Payment ID: {payment_response['paymentId']}")
print(f"TX Hash: {payment_response['txHash']}")
print(f"Owner: {receipt['owner']}")  # Bundler's address

# Check tags include x402 metadata
x402_tags = [t for t in receipt['tags'] if t['name'].startswith('x402_')]
print(f"x402 Tags: {x402_tags}")
```

### 9.3 cURL Examples

**Get Price Quote:**
```bash
# For signed data item
curl -X POST http://localhost:3001/v1/tx \
  -H "Content-Type: application/octet-stream" \
  -H "Content-Length: 1024000" \
  --data-binary @data-item.bin

# For raw data
curl -X POST http://localhost:3001/v1/tx/raw \
  -H "Content-Type: application/json" \
  -H "Content-Length: 256" \
  -d '{"data":"SGVsbG8=","tags":[{"name":"Content-Type","value":"text/plain"}]}'
```

**Upload with Payment:**
```bash
# 1. Get payment header (from client-side EIP-712 signing)
PAYMENT_HEADER="eyJ4NDAyVmVyc2lvbiI6MSwic2NoZW1lIjoiZXhhY3QiLCJuZXR3b3JrIjoiYmFzZS1tYWlubmV0IiwicGF5bG9hZCI6eyJzaWduYXR1cmUiOiIweC4uLiIsImF1dGhvcml6YXRpb24iOnsiZnJvbSI6IjB4Li4uIiwidG8iOiIweC4uLiIsInZhbHVlIjoiMTUwMCIsInZhbGlkQWZ0ZXIiOjAsInZhbGlkQmVmb3JlIjoxNzMwMDAwMDAwLCJub25jZSI6IjB4Li4uIn19fQ=="

# 2. Upload signed data item with payment
curl -X POST http://localhost:3001/v1/tx \
  -H "Content-Type: application/octet-stream" \
  -H "Content-Length: 1024000" \
  -H "X-PAYMENT: $PAYMENT_HEADER" \
  --data-binary @data-item.bin \
  -i  # Include headers to see X-Payment-Response

# 3. Upload raw data with payment
curl -X POST http://localhost:3001/v1/tx/raw \
  -H "Content-Type: application/json" \
  -H "Content-Length: 256" \
  -H "X-PAYMENT: $PAYMENT_HEADER" \
  -d '{"data":"SGVsbG8=","tags":[{"name":"Content-Type","value":"text/plain"}]}' \
  -i
```

---

## 10. Testing & Debugging

### 10.1 Base Sepolia Testnet Setup

**1. Get Testnet ETH:**
- Faucet: https://sepoliafaucet.com/
- Or: https://www.alchemy.com/faucets/base-sepolia

**2. Get Testnet USDC:**
- Bridge from Sepolia ETH: https://bridge.base.org/
- Or use USDC faucet (if available)

**3. Configure Bundler:**
```bash
X402_BASE_TESTNET_ENABLED=true
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
X402_PAYMENT_ADDRESS=0xYourTestAddress
X402_FACILITATOR_URL_BASE_TESTNET=https://x402.org/facilitator
```

### 10.2 Testing Workflow

**Step 1: Price Quote Test**
```bash
curl -X POST http://localhost:3001/v1/tx/raw \
  -H "Content-Type: application/json" \
  -H "Content-Length: 256" \
  -d '{"data":"test","tags":[]}' | jq .
```

**Expected Response:**
```json
{
  "x402Version": 1,
  "accepts": [{
    "scheme": "exact",
    "network": "base-sepolia",
    "maxAmountRequired": "1000",
    ...
  }]
}
```

**Step 2: Create Test Payment**
```javascript
// Use ethers.js to create testnet payment
const signer = new ethers.Wallet(testnetPrivateKey);
// ... (same as production but with Base Sepolia chainId: 84532)
```

**Step 3: Upload Test**
```bash
curl -X POST http://localhost:3001/v1/tx/raw \
  -H "Content-Type: application/json" \
  -H "Content-Length: 256" \
  -H "X-PAYMENT: $TEST_PAYMENT_HEADER" \
  -d '{"data":"test","tags":[]}' \
  -i
```

**Step 4: Verify Payment**
```bash
# Check PostgreSQL
psql -d upload_service -c "SELECT * FROM x402_payment_transaction ORDER BY paid_at DESC LIMIT 1;"

# Check on BaseScan
https://sepolia.basescan.org/tx/0xYourTxHash
```

### 10.3 Debugging Tools

**PostgreSQL Queries:**
```sql
-- Recent x402 payments
SELECT
  id, user_address, tx_hash, network,
  usdc_amount, winc_amount, mode,
  status, paid_at, finalized_at
FROM x402_payment_transaction
ORDER BY paid_at DESC
LIMIT 10;

-- Payment reservations
SELECT
  r.data_item_id, r.winc_reserved,
  p.tx_hash, p.network, p.status
FROM x402_payment_reservation r
JOIN x402_payment_transaction p ON r.x402_payment_id = p.id
WHERE r.expires_at > NOW();

-- Fraud cases
SELECT
  id, data_item_id, declared_byte_count,
  actual_byte_count, status, refund_winc
FROM x402_payment_transaction
WHERE status IN ('refunded', 'fraud_penalty')
ORDER BY finalized_at DESC;
```

**PM2 Logs:**
```bash
# Watch x402 payment processing
pm2 logs upload-api --lines 0 | grep -i x402

pm2 logs payment-service --lines 0 | grep -i x402

# Watch for errors
pm2 logs --err --lines 100
```

**Network Debugging:**
```bash
# Check RPC endpoint
curl -X POST https://sepolia.base.org \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'

# Expected: {"jsonrpc":"2.0","id":1,"result":"0x14a34"} (84532 in hex)
```

### 10.4 Common Test Scenarios

**Test 1: Underpayment (Fraud Detection)**
```javascript
// Declare 1 MB, send 2 MB
const declaredSize = 1024 * 1024;  // 1 MB
const actualData = Buffer.alloc(2 * 1024 * 1024);  // 2 MB

// Result: fraud_penalty status, payment kept
```

**Test 2: Overpayment (Refund)**
```javascript
// Declare 2 MB, send 1 MB
const declaredSize = 2 * 1024 * 1024;  // 2 MB
const actualData = Buffer.alloc(1024 * 1024);  // 1 MB

// Result: refunded status, proportional refund credited
```

**Test 3: Within Tolerance**
```javascript
// Declare 1000 KB, send 1020 KB (2% difference, within 5% tolerance)
const declaredSize = 1000 * 1024;
const actualData = Buffer.alloc(1020 * 1024);

// Result: confirmed status, no refund
```

**Test 4: PAYG Mode**
```javascript
// Upload with mode=payg, check reservation
const paymentResult = await verifyAndSettleX402Payment({
  mode: 'payg',
  ...
});

// Verify: x402_payment_reservation record exists
// Verify: No balance credit
```

**Test 5: Hybrid Mode**
```javascript
// Pay $2, upload costs $1
const overpayment = 2000000;  // $2 USDC
const uploadCost = 1000000;   // $1 worth of Winc

// Verify: $1 reserved, $1 credited to balance
```

---

## 11. Security Considerations

### 11.1 EIP-712 Signature Verification

**Critical Validation:**
```typescript
// In x402Service.ts
export function verifyEIP712Signature(
  authorization: Authorization,
  signature: string,
  domain: EIP712Domain
): boolean {
  // 1. Reconstruct EIP-712 hash
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' }
    ]
  };

  // 2. Recover signer from signature
  const recoveredAddress = ethers.utils.verifyTypedData(
    domain,
    types,
    authorization,
    signature
  );

  // 3. Verify signer matches 'from' address
  return recoveredAddress.toLowerCase() === authorization.from.toLowerCase();
}
```

**Security Checks:**
1. ✅ Signature must be valid EIP-712 signature
2. ✅ Signer must match `authorization.from` address
3. ✅ `authorization.to` must match service address
4. ✅ `authorization.validBefore` must be in future
5. ✅ `authorization.value` must be >= required amount
6. ✅ Nonce must be unique (USDC contract enforces this)

### 11.2 Replay Attack Prevention

**USDC Contract Nonce Tracking:**
- Each authorization has unique nonce
- USDC contract tracks used nonces per address
- Reusing nonce → transaction reverts
- Bundler doesn't need to track nonces (contract handles it)

**Expiration Enforcement:**
```typescript
// Check validBefore timestamp
const now = Math.floor(Date.now() / 1000);
if (authorization.validBefore < now) {
  throw new PaymentError('Payment authorization expired');
}

// Check validAfter timestamp
if (authorization.validAfter > now) {
  throw new PaymentError('Payment authorization not yet valid');
}
```

### 11.3 Amount Verification

**Exact Amount Matching:**
```typescript
// Payment requirements specify exact amount
const required = paymentRequirements.maxAmountRequired;
const provided = authorization.value;

if (BigInt(provided) < BigInt(required)) {
  throw new PaymentError(
    `Insufficient payment: ${provided} < ${required}`
  );
}
```

**Why "maxAmountRequired"?**
- Allows client to overpay (refunded in hybrid/topup modes)
- Prevents underpayment attacks
- Exact amount enforcement at contract level

### 11.4 Network Validation

**Network Mismatch Prevention:**
```typescript
// Client specifies network in payment header
const clientNetwork = paymentData.network;

// Server validates network is enabled
if (!x402Networks[clientNetwork]?.enabled) {
  throw new PaymentError(`Network ${clientNetwork} not enabled`);
}

// Verify chainId matches network
const provider = new ethers.providers.JsonRpcProvider(
  x402Networks[clientNetwork].rpcUrl
);
const chainId = await provider.getNetwork().then(n => n.chainId);
const expectedChainId = networkToChainId[clientNetwork];

if (chainId !== expectedChainId) {
  throw new PaymentError(`ChainId mismatch: ${chainId} != ${expectedChainId}`);
}
```

### 11.5 DoS Attack Mitigation

**Content-Length Required:**
```typescript
// Prevent clients from streaming unlimited data
if (!ctx.request.headers['content-length']) {
  throw new BadRequest('Content-Length header required for x402 payments');
}

// Validate Content-Length is reasonable
const contentLength = parseInt(ctx.request.headers['content-length']);
if (contentLength > MAX_DATA_ITEM_SIZE) {
  throw new PayloadTooLarge(`Data item exceeds ${MAX_DATA_ITEM_SIZE} bytes`);
}
```

**Payment Before Processing:**
```typescript
// Verify and settle payment BEFORE processing data
await verifyAndSettleX402Payment({ ... });

// Only after payment confirmed, process upload
await processUpload({ ... });
```

**Reservation Expiration:**
```sql
-- Auto-expire unused reservations after 1 hour
DELETE FROM x402_payment_reservation
WHERE expires_at < NOW();
```

### 11.6 Private Key Security

**NEVER expose private keys in:**
- ❌ Client-side JavaScript
- ❌ Git repositories
- ❌ Environment variables (unless encrypted)
- ❌ Logs or error messages

**Use:**
- ✅ Hardware wallets (Ledger, Trezor)
- ✅ Key management services (AWS KMS, Google Cloud KMS)
- ✅ Browser extension wallets (MetaMask)
- ✅ Secure enclave (mobile apps)

**Server-Side Security:**
```bash
# Bundler's JWK wallet
TURBO_JWK_FILE=/secure/path/wallet.json
chmod 600 /secure/path/wallet.json
chown bundler:bundler /secure/path/wallet.json

# Payment receiving address (can be public)
X402_PAYMENT_ADDRESS=0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb
```

---

## 12. Troubleshooting

### 12.1 Common Errors

**Error: "Content-Length header required for x402 payments"**
```
Cause: X-PAYMENT header present but no Content-Length
Fix:   Always include Content-Length when using x402
```

**Error: "Payment authorization expired"**
```
Cause: validBefore timestamp is in the past
Fix:   Increase validBefore to at least 1 hour in future
```

**Error: "Invalid EIP-712 signature"**
```
Cause: Signature doesn't match authorization or domain
Fix:   Verify domain.chainId matches network
       Verify types match USDC contract exactly
       Verify signer has USDC balance for payment
```

**Error: "Network not enabled"**
```
Cause: Requested network not configured on server
Fix:   Check X402_BASE_ENABLED, X402_ETH_ENABLED env vars
       Verify RPC URLs are correct
```

**Error: "Insufficient payment"**
```
Cause: authorization.value < maxAmountRequired
Fix:   Pay exact amount or more (excess refunded in hybrid/topup modes)
```

**Error: "USDC transfer failed: Nonce already used"**
```
Cause: Nonce reused (replay attack or duplicate request)
Fix:   Generate fresh nonce for each payment
       Use: ethers.utils.hexlify(ethers.utils.randomBytes(32))
```

**Error: "USDC transfer failed: Insufficient balance"**
```
Cause: User doesn't have enough USDC
Fix:   Check USDC balance on blockchain explorer
       Fund wallet with USDC
```

### 12.2 Debugging Checklist

**Client-Side:**
- [ ] Content-Length header matches actual data size
- [ ] X-PAYMENT header is base64-encoded valid JSON
- [ ] EIP-712 domain.chainId matches network (8453 for Base mainnet)
- [ ] authorization.from is user's Ethereum address
- [ ] authorization.to matches server's payment address
- [ ] authorization.value >= maxAmountRequired
- [ ] authorization.validBefore is in future (unix timestamp)
- [ ] Nonce is unique 32-byte hex string
- [ ] User has sufficient USDC balance
- [ ] User has sufficient ETH for gas (if not using meta-transaction)

**Server-Side:**
- [ ] X402_ENABLED=true
- [ ] Network enabled (X402_BASE_ENABLED=true)
- [ ] RPC URL configured and accessible
- [ ] X402_PAYMENT_ADDRESS set correctly
- [ ] USDC contract address correct for network
- [ ] Database tables exist (x402_payment_transaction, x402_payment_reservation)
- [ ] Payment service accessible from upload service
- [ ] Logs show payment verification steps

**Blockchain:**
- [ ] Transaction appears on block explorer
- [ ] Transaction status is "Success"
- [ ] USDC balance decreased for payer
- [ ] USDC balance increased for recipient
- [ ] Gas fees paid

### 12.3 Monitoring & Alerts

**Key Metrics:**
```sql
-- x402 payment success rate
SELECT
  status,
  COUNT(*) as count,
  COUNT(*) * 100.0 / SUM(COUNT(*)) OVER () as percentage
FROM x402_payment_transaction
WHERE paid_at > NOW() - INTERVAL '1 day'
GROUP BY status;

-- Average payment amount
SELECT
  network,
  AVG(CAST(usdc_amount AS NUMERIC)) / 1000000 as avg_usdc,
  COUNT(*) as count
FROM x402_payment_transaction
WHERE paid_at > NOW() - INTERVAL '1 day'
GROUP BY network;

-- Fraud detection stats
SELECT
  COUNT(*) FILTER (WHERE status = 'fraud_penalty') as fraud_count,
  COUNT(*) FILTER (WHERE status = 'refunded') as refund_count,
  COUNT(*) FILTER (WHERE status = 'confirmed') as confirmed_count
FROM x402_payment_transaction
WHERE finalized_at > NOW() - INTERVAL '1 day';
```

**Prometheus Metrics:**
```
x402_payment_success_total
x402_payment_failure_total
x402_payment_fraud_total
x402_payment_refund_total
x402_payment_amount_usdc
x402_verification_duration_seconds
```

**Alerting Rules:**
```yaml
# High fraud rate
- alert: HighX402FraudRate
  expr: rate(x402_payment_fraud_total[1h]) > 0.1
  annotations:
    summary: "High x402 fraud rate detected"

# Payment verification failures
- alert: X402PaymentFailures
  expr: rate(x402_payment_failure_total[5m]) > 5
  annotations:
    summary: "Elevated x402 payment failures"

# Low payment volume (potential outage)
- alert: LowX402PaymentVolume
  expr: rate(x402_payment_success_total[1h]) < 1
  annotations:
    summary: "Low x402 payment volume"
```

---

## Appendix A: x402 Standards References

**x402 Protocol:**
- Repository: https://github.com/coinbase/x402
- Specification: https://github.com/coinbase/x402/blob/main/spec.md
- Version: x402-1

**EIP-3009 (TransferWithAuthorization):**
- EIP: https://eips.ethereum.org/EIPS/eip-3009
- Use Case: Gasless USDC transfers via meta-transactions
- Implementations: Circle USDC, USDT

**EIP-712 (Typed Structured Data):**
- EIP: https://eips.ethereum.org/EIPS/eip-712
- Use Case: Human-readable signature messages
- Security: Prevents signature phishing

**USDC Contract:**
- Documentation: https://www.circle.com/en/usdc-multichain
- Audits: https://www.circle.com/en/usdc/audits
- Contract Source: https://etherscan.io/address/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48#code

---

## Appendix B: Network ChainIDs

| Network | ChainID (Decimal) | ChainID (Hex) |
|---------|-------------------|---------------|
| Ethereum Mainnet | 1 | 0x1 |
| Base Mainnet | 8453 | 0x2105 |
| Polygon Mainnet | 137 | 0x89 |
| Base Sepolia | 84532 | 0x14a34 |

---

## Appendix C: USDC Decimals

**USDC uses 6 decimals:**
```
1 USDC = 1,000,000 atomic units
0.001 USDC = 1,000 atomic units (minimum payment)
$10 USDC = 10,000,000 atomic units
```

**Conversion Examples:**
```javascript
// USDC to atomic units
const usdcAmount = 1.5;  // $1.50
const atomicUnits = Math.floor(usdcAmount * 1e6);  // 1500000

// Atomic units to USDC
const atomicUnits = 2500000;
const usdcAmount = atomicUnits / 1e6;  // 2.5
```

---

## Appendix D: File References

**Upload Service:**
- `packages/upload-service/src/routes/dataItemPost.ts` - Signed data items with x402
- `packages/upload-service/src/routes/rawDataPost.ts` - Unsigned blobs with x402
- `packages/upload-service/src/arch/x402Service.ts` - x402 service interface
- `packages/upload-service/src/utils/x402Pricing.ts` - Winston ↔ USDC conversion
- `packages/upload-service/src/utils/createDataItem.ts` - ANS-104 creation with x402 tags

**Payment Service:**
- `packages/payment-service/src/routes/x402Price.ts` - Price quote endpoint
- `packages/payment-service/src/routes/x402Payment.ts` - Payment verification & settlement
- `packages/payment-service/src/routes/x402Finalize.ts` - Fraud detection

**Database:**
- `packages/upload-service/src/arch/db/postgres.ts` - x402 payment queries
- `packages/upload-service/src/migrations/20251029163940_x402_payments_table.ts` - Schema

**Configuration:**
- `packages/payment-service/src/constants.ts` - x402 network config
- `.env` - Environment variables

---

**END OF GUIDE**

For questions or support:
- GitHub Issues: https://github.com/vilenarios/ar-io-bundler/issues
- Documentation: /docs/AR-IO-BUNDLER-FEATURE-GUIDE.md
- Architecture: /docs/architecture/ARCHITECTURE.md
