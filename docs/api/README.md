# API Reference

AR.IO Bundler exposes two REST APIs for data uploads and payment processing.

## API Endpoints

### Upload Service
**Base URL**: `http://localhost:3001`

The Upload Service handles data item uploads and bundle management.

#### Quick Reference

Routes are served at both the root and a `/v1` prefix; the `/v1` forms are shown.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/tx` (or `/v1/tx/:token`) | POST | Upload a signed ANS-104 data item (x402 or balance) |
| `/v1/x402/upload/unsigned` | POST | Upload raw bytes; bundler signs (x402 required) |
| `/v1/x402/upload/signed` | POST | Signed data-item upload paid via x402 |
| `/v1/tx/:id/status` | GET | Check data item status |
| `/v1/tx/:id/offsets` | GET | Get data item offset information |
| `/v1/chunks/:token/-1/-1` | GET | Create a multipart upload (returns uploadId) |
| `/v1/chunks/:token/:uploadId/:chunkOffset` | POST | Upload a chunk at byte offset |
| `/v1/chunks/:token/:uploadId/-1` | POST | Finalize the upload (sync) |
| `/v1/chunks/:token/:uploadId/finalize` | POST | Finalize the upload (async) |
| `/v1/chunks/:token/:uploadId/status` | GET | Get multipart upload status |
| `/v1/price/x402/data-item/:token/:byteCount` | GET | x402 price quote for a data item |
| `/info` (or `/v1/info`) | GET | Service info |
| `/health` | GET | Health check |
| `/api-docs`, `/openapi.json` | GET | Swagger UI / OpenAPI document |

### Payment Service
**Base URL**: `http://localhost:4001`

The Payment Service manages user balances and payment processing.

#### Quick Reference

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/balance` | GET | Get user balance |
| `/v1/account/balance/:token` | POST | Add a pending crypto payment |
| `/v1/reserve-balance` | GET | Reserve balance for an operation |
| `/v1/refund-balance` | GET | Refund reserved balance |
| `/v1/top-up/:method/:address/:currency/:amount` | GET | Create a top-up (e.g. Stripe) |
| `/v1/stripe-webhook` | POST | Stripe webhook handler |
| `/v1/redeem` | GET | Redeem a gift/promo code |
| `/v1/price/bytes/:bytes` | GET | Storage price (Winston) for a byte count |
| `/v1/x402/price/:signatureType/:address` | GET | Get x402 payment quote (USDC) |
| `/v1/x402/payment/:signatureType/:address` | POST | Verify and settle x402 payment |
| `/v1/x402/finalize` | POST | Finalize x402 payment (fraud detection) |
| `/v1/arns/price/:intent/:name` | GET | Get ArNS name price |
| `/v1/arns/purchase/:intent/:name` | POST | Purchase ArNS name |
| `/v1/arns/purchase/:nonce` | GET | Check purchase status |
| `/v1/account/approvals` | POST | Create payment approval |
| `/v1/account/approvals` | GET | List approvals |
| `/v1/account/approvals/:id` | DELETE | Revoke approval |
| `/v1/rates` | GET | Get conversion rates |
| `/v1/currencies` | GET | List supported currencies |
| `/v1/info` | GET | Service info and health |

## x402 Payment Protocol

AR.IO Bundler implements Coinbase's **x402 payment standard** for HTTP 402 Payment Required workflows. x402 enables gasless USDC payments via EIP-3009 (TransferWithAuthorization) and EIP-712 signatures.

### Supported Networks
- **Base Mainnet** (primary) - Chain ID 8453
- **Ethereum Mainnet** - Chain ID 1
- **Polygon Mainnet** - Chain ID 137

### Payment Flow

1. **Upload without payment** → Server returns `402 Payment Required` with payment requirements
2. **Client creates EIP-3009 payment authorization** and signs with EIP-712
3. **Retry upload with X-PAYMENT header** → Server verifies, settles USDC, and processes upload
4. **Server returns receipt** with `X-Payment-Response` header containing payment confirmation

### Key Headers

- **X-Payment-Required: x402-1** - Set on 402 responses to indicate x402 support
- **X-PAYMENT** - Client sends base64-encoded JSON payment authorization
- **X-Payment-Response** - Server returns base64-encoded JSON payment confirmation

### Upload Types

**Signed Data Items** (`POST /v1/tx`):
- User creates ANS-104 data item with their wallet
- Can use x402 payment OR traditional balance
- Data item retains user's signature

**Unsigned Data Blobs** (`POST /v1/x402/upload/unsigned`):
- User sends raw bytes without ANS-104 signing
- x402 payment REQUIRED (no balance fallback)
- Bundler creates the ANS-104 item and signs it with its own wallet (`RAW_DATA_ITEM_JWK_FILE`)
- Payment metadata injected as tags (e.g. `Payer-Address`, `Upload-Type`)

### Comprehensive Guide

For complete x402 implementation details, examples, and troubleshooting:

**[X402 Integration Guide](../guides/X402_INTEGRATION_GUIDE.md)**

## Detailed Documentation

For complete API documentation including request/response examples, authentication methods, and error handling, see:

**[Architecture Documentation - API Reference Section](../architecture/ARCHITECTURE.md#api-reference)**

## Interactive API Documentation

Both services provide Swagger UI for interactive API exploration:

- **Upload Service**: http://localhost:3001/api-docs (OpenAPI at `/openapi.json`)
- **Payment Service**: http://localhost:4001/api-docs (if configured)

## Authentication

### Upload Service
- **Signature-based**: Data items must be signed with Arweave/Ethereum/Solana keys (ANS-104)
- **x402 Payment**: EIP-712 signatures for USDC payment authorization (via X-PAYMENT header)
- **JWT Tokens**: For internal service communication
- **Traditional Balance**: JWT-authenticated balance deduction

### Payment Service
- **JWT Tokens**: User authentication for balance operations
- **x402 Protocol**: EIP-712 signature verification for USDC payments
- **Signature Verification**: For crypto payment submissions
- **Stripe Webhooks**: HMAC signature verification

## Example Usage

### Upload Signed Data Item (Traditional Balance)

```bash
# Upload ANS-104 data item using JWT-authenticated balance
curl -X POST http://localhost:3001/v1/tx \
  -H "Content-Type: application/octet-stream" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  --data-binary @signed-data-item.bin
```

### Upload Signed Data Item (x402 Payment)

```bash
# Step 1: Upload without payment to get 402 response
curl -X POST http://localhost:3001/v1/tx \
  -H "Content-Type: application/octet-stream" \
  -H "Content-Length: 1024" \
  --data-binary @signed-data-item.bin

# Returns 402 with payment requirements in response body

# Step 2: Create EIP-3009 payment authorization and sign with EIP-712
# (Use web3 library to create signature - see X402_INTEGRATION_GUIDE.md)

# Step 3: Retry with X-PAYMENT header
curl -X POST http://localhost:3001/v1/tx \
  -H "Content-Type: application/octet-stream" \
  -H "Content-Length: 1024" \
  -H "X-PAYMENT: eyJ2ZXJzaW9uIjoiMS4wIiwicGF5bG9hZCI6eyJhdXRob3JpemF0aW9uIjp7ImZyb20iOi..." \
  --data-binary @signed-data-item.bin

# Returns 200 with X-Payment-Response header containing payment confirmation
```

### Upload Unsigned Data Blob (x402 Required)

```bash
# Step 1: POST raw bytes to get 402 payment requirements
curl -X POST http://localhost:3001/v1/x402/upload/unsigned \
  -H "Content-Type: text/plain" \
  --data-binary @file.txt

# Step 2: Retry with the X-PAYMENT header (EIP-712 transferWithAuthorization)
curl -X POST http://localhost:3001/v1/x402/upload/unsigned \
  -H "Content-Type: text/plain" \
  -H "X-PAYMENT: eyJ2ZXJzaW9uIjoiMS4wIiwicGF5bG9hZCI6..." \
  --data-binary @file.txt
```

### Get x402 Price Quote

```bash
# Payment-service x402 price quote (signatureType 3 = Ethereum), bytes via query
curl "http://localhost:4001/v1/x402/price/3/0xYourEthereumAddress?bytes=1024"

# Or the upload-service quote with the byte count as a path segment:
curl "http://localhost:3001/v1/price/x402/data-item/ethereum/1024"

# Returns payment requirements including USDC amount, contract, recipient
```

### Check Balance

```bash
curl http://localhost:4001/v1/balance \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### Get Traditional Price Quote

```bash
curl "http://localhost:4001/v1/price/bytes/1048576"
# Returns the Winston price for 1 MiB of storage
```

## Client Libraries

Compatible with Arweave ecosystem tools:
- **arbundles** - ANS-104 data item creation
- **@ardrive/turbo-sdk** - Upload client
- **arweave-js** - Arweave interactions

## Rate Limits

Currently no rate limits enforced. For production deployments, consider:
- Reverse proxy rate limiting (nginx/Caddy)
- API gateway integration
- Balance-based throttling

## Error Codes

Standard HTTP status codes:
- `200 OK` - Success
- `202 Accepted` - Async operation initiated
- `400 Bad Request` - Invalid request (malformed data, missing parameters)
- `401 Unauthorized` - Authentication required (JWT token missing/invalid)
- `402 Payment Required` - Insufficient balance OR x402 payment required
  - Response includes `X-Payment-Required: x402-1` header for x402 workflows
  - Response body contains payment requirements (USDC amount, contract, recipient)
- `404 Not Found` - Resource not found (data item, upload session)
- `413 Payload Too Large` - Data item exceeds size limit (10 GiB)
- `422 Unprocessable Entity` - x402 payment verification failed
- `500 Internal Server Error` - Server error

## Support

For issues or questions:
- [Main Documentation](../README.md)
- [Architecture Guide](../architecture/ARCHITECTURE.md)
- [X402 Integration Guide](../guides/X402_INTEGRATION_GUIDE.md)
- [GitHub Issues](https://github.com/ar-io/ar-io-bundler/issues)
