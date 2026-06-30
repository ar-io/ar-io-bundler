# AR.IO Bundler Fee Configuration Guide

## Overview

The AR.IO Bundler supports multiple ways to configure fees and pricing for your bundler service. Fees are applied as **adjustments** to the base Arweave network cost, allowing you to cover infrastructure costs and generate revenue.

## Fee Structure

### How Fees Work

When a user uploads data:

1. **Base Cost**: Calculated from your local AR.IO Gateway's `/price` endpoint (in Winston)
2. **Adjustments Applied**: Fees are applied as database-configured adjustments
3. **Final Price**: User pays the adjusted price

**Example:**
- Base network cost: 1,000,000 Winston
- Infrastructure fee (multiply by 0.766): User pays **766,000 Winston** to you
- You post the bundle paying the full 1,000,000 Winston to Arweave
- Your revenue: **-234,000 Winston loss** (this is a cost subsidy!)

**Important**: The default `multiply 0.766` means you're **subsidizing** uploads at a loss. You should adjust this!

## Current Fee Configuration

### Check Current Fees

```bash
docker exec ar-io-bundler-postgres psql -U turbo_admin -d payment_service -c \
  "SELECT adjustment_name, operator, operator_magnitude, adjustment_description,
   adjustment_start_date, adjustment_end_date
   FROM payment_adjustment_catalog
   WHERE adjustment_end_date IS NULL
   ORDER BY adjustment_start_date DESC;"
```

**Current Configuration:**
- **Turbo Infrastructure Fee**: `multiply 0.766` (User pays 76.6% of cost)
- **Kyve Turbo Infrastructure Fee**: `multiply 0.5` (User pays 50% for KYVE tokens)

## Fee Configuration Methods

### Method 1: Database Configuration (Recommended)

Fees are stored in the `payment_adjustment_catalog` table. This allows dynamic fee changes without code changes.

#### Add a New Fee (Markup)

To charge 20% above cost (1.20x):

```sql
docker exec -i ar-io-bundler-postgres psql -U turbo_admin -d payment_service << 'EOF'
INSERT INTO payment_adjustment_catalog (
  catalog_id,
  adjustment_name,
  adjustment_description,
  operator,
  operator_magnitude,
  adjustment_exclusivity,
  adjustment_priority,
  adjustment_start_date
) VALUES (
  gen_random_uuid(),
  'AR.IO Bundler Service Fee',
  'Service fee to cover infrastructure, bandwidth, and operational costs',
  'multiply',
  '1.20',
  'inclusive',
  500,
  NOW()
);
EOF
```

#### Update Existing Fee

To change the current fee from 0.766 to 1.15 (15% markup):

```sql
docker exec -i ar-io-bundler-postgres psql -U turbo_admin -d payment_service << 'EOF'
-- End the old fee
UPDATE payment_adjustment_catalog
SET adjustment_end_date = NOW()
WHERE adjustment_name = 'Turbo Infrastructure Fee'
AND adjustment_end_date IS NULL;

-- Add new fee starting now
INSERT INTO payment_adjustment_catalog (
  catalog_id,
  adjustment_name,
  adjustment_description,
  operator,
  operator_magnitude,
  adjustment_exclusivity,
  adjustment_priority,
  adjustment_start_date
) VALUES (
  gen_random_uuid(),
  'AR.IO Bundler Service Fee',
  'Infrastructure and operational fee',
  'multiply',
  '1.15',
  'inclusive',
  500,
  NOW()
);
EOF
```

### Method 2: Environment Variable Subsidization

The `SUBSIDIZED_WINC_PERCENTAGE` environment variable provides a **discount** to users.

**Location**: `.env` files in both services

```bash
# Winc Subsidization (optional, default: 0)
SUBSIDIZED_WINC_PERCENTAGE=0
```

**How it works:**
- `0` = No subsidization (users pay full cost + fees)
- `10` = 10% discount (users pay 90% of calculated cost)
- `50` = 50% discount (users pay 50% of calculated cost)
- `100` = Free uploads (you pay everything)

**Example:**
```bash
# Give 10% discount on all uploads
SUBSIDIZED_WINC_PERCENTAGE=10
```

**Restart required**: Services must be restarted after changing this value.

## Operator Types

The `operator` field determines how the fee is applied:

### `multiply` (Most Common)

Multiplies the base cost by the magnitude.

**Examples:**
- `multiply 1.20` = User pays 120% of cost (20% markup) ✅ **PROFIT**
- `multiply 1.15` = User pays 115% of cost (15% markup) ✅ **PROFIT**
- `multiply 1.00` = User pays exact cost (break-even)
- `multiply 0.80` = User pays 80% of cost (20% subsidy) ❌ **LOSS**
- `multiply 0.766` = User pays 76.6% of cost (23.4% subsidy) ❌ **LOSS**

### `add`

Adds a fixed Winston amount to the cost.

**Example:**
```sql
operator = 'add',
operator_magnitude = '1000000000'  -- Add 1000 Winston to every upload
```

### `subtract`

Subtracts a fixed Winston amount (creates discount).

**Example:**
```sql
operator = 'subtract',
operator_magnitude = '500000000'  -- Subtract 500 Winston from cost
```

## Recommended Fee Structures

### 1. Profitable Bundler (15% Markup)

```sql
docker exec -i ar-io-bundler-postgres psql -U turbo_admin -d payment_service << 'EOF'
UPDATE payment_adjustment_catalog
SET adjustment_end_date = NOW()
WHERE adjustment_end_date IS NULL;

INSERT INTO payment_adjustment_catalog (
  catalog_id,
  adjustment_name,
  adjustment_description,
  operator,
  operator_magnitude,
  adjustment_exclusivity,
  adjustment_priority,
  adjustment_start_date
) VALUES (
  gen_random_uuid(),
  'AR.IO Bundler Service Fee',
  'Service fee covering infrastructure, bandwidth, support, and operational costs',
  'multiply',
  '1.15',
  'inclusive',
  500,
  NOW()
);
EOF
```

**Result**: Users pay 15% above cost, you profit 15%.

### 2. Break-Even Bundler

```sql
docker exec -i ar-io-bundler-postgres psql -U turbo_admin -d payment_service << 'EOF'
UPDATE payment_adjustment_catalog
SET adjustment_end_date = NOW()
WHERE adjustment_end_date IS NULL;

INSERT INTO payment_adjustment_catalog (
  catalog_id,
  adjustment_name,
  adjustment_description,
  operator,
  operator_magnitude,
  adjustment_exclusivity,
  adjustment_priority,
  adjustment_start_date
) VALUES (
  gen_random_uuid(),
  'AR.IO Bundler Pass-Through',
  'Pass-through pricing at network cost',
  'multiply',
  '1.00',
  'inclusive',
  500,
  NOW()
);
EOF
```

**Result**: Users pay exact Arweave network cost, you break even.

### 3. Community Bundler (Subsidized)

```bash
# In both .env files
SUBSIDIZED_WINC_PERCENTAGE=25
```

```sql
docker exec -i ar-io-bundler-postgres psql -U turbo_admin -d payment_service << 'EOF'
UPDATE payment_adjustment_catalog
SET adjustment_end_date = NOW()
WHERE adjustment_end_date IS NULL;

INSERT INTO payment_adjustment_catalog (
  catalog_id,
  adjustment_name,
  adjustment_description,
  operator,
  operator_magnitude,
  adjustment_exclusivity,
  adjustment_priority,
  adjustment_start_date
) VALUES (
  gen_random_uuid(),
  'Community Support Pricing',
  'Subsidized pricing for community support',
  'multiply',
  '1.00',
  'inclusive',
  500,
  NOW()
);
EOF
```

**Result**: Users pay 75% of network cost (25% subsidized by you).

### 4. Premium Bundler (30% Markup)

```sql
docker exec -i ar-io-bundler-postgres psql -U turbo_admin -d payment_service << 'EOF'
UPDATE payment_adjustment_catalog
SET adjustment_end_date = NOW()
WHERE adjustment_end_date IS NULL;

INSERT INTO payment_adjustment_catalog (
  catalog_id,
  adjustment_name,
  adjustment_description,
  operator,
  operator_magnitude,
  adjustment_exclusivity,
  adjustment_priority,
  adjustment_start_date
) VALUES (
  gen_random_uuid(),
  'Premium Bundler Service',
  'Premium service including enterprise support, SLA, priority processing',
  'multiply',
  '1.30',
  'inclusive',
  500,
  NOW()
);
EOF
```

**Result**: Users pay 30% above cost for premium service.

## Field Descriptions

### `adjustment_exclusivity`

- `inclusive`: Fee is included in quoted price (recommended)
- `exclusive`: Fee is added on top of quoted price

### `adjustment_priority`

Controls order of fee application when multiple fees exist:
- Lower number = Applied first
- Default: `500`
- Use if you have multiple adjustments

### `adjustment_start_date` / `adjustment_end_date`

Allows time-based fee changes:
- Set `end_date` to expire old fees
- New fee with current `start_date` takes over
- `NULL` end_date means active indefinitely

## Testing Your Fee Configuration

After changing fees, test pricing:

```bash
# Get price for 1MB upload
curl "http://localhost:4001/v1/price/bytes/1000000"

# Response shows your fee applied
{
  "winc": "2900000000",  # Your price after fees
  "adjustments": [
    {
      "name": "AR.IO Bundler Service Fee",
      "description": "Service fee...",
      "operator": "multiply",
      "operatorMagnitude": "1.15",
      "adjustmentAmount": "-2521739130",  # Fee charged
      "currencyType": "arweave"
    }
  ]
}
```

## Financial Examples

### Example 1: 15% Markup (Recommended)

**Base Cost from Gateway**: 1,000,000 Winston (0.001 AR)

With `multiply 1.15`:
- **User Pays**: 1,150,000 Winston
- **You Post to Arweave**: 1,000,000 Winston
- **Your Profit**: 150,000 Winston (15%)

At $10/AR:
- User pays: $0.0115
- You pay: $0.01
- Your profit: $0.0015 per MB

### Example 2: Current Default (LOSS!)

**Base Cost from Gateway**: 1,000,000 Winston

With `multiply 0.766`:
- **User Pays**: 766,000 Winston
- **You Post to Arweave**: 1,000,000 Winston
- **Your LOSS**: -234,000 Winston (-23.4%)

You're losing 23.4% on every upload!

### Example 3: Break-Even

**Base Cost from Gateway**: 1,000,000 Winston

With `multiply 1.00`:
- **User Pays**: 1,000,000 Winston
- **You Post to Arweave**: 1,000,000 Winston
- **Your Profit/Loss**: 0 (break-even)

## Best Practices

1. **Start with Break-Even**: Use `multiply 1.00` initially
2. **Monitor Costs**: Track your actual infrastructure costs
3. **Add Markup Gradually**: Add 5-10% markup to cover operational costs
4. **Consider Market Rates**: Check what other bundlers charge
5. **Document Changes**: Keep track of fee changes over time
6. **Test Before Production**: Always test pricing after changes

## Advanced: Multiple Fees

You can have multiple active fees for different use cases:

```sql
-- Base infrastructure fee (15%)
INSERT INTO payment_adjustment_catalog (...) VALUES (
  gen_random_uuid(),
  'Infrastructure Fee',
  'Base infrastructure costs',
  'multiply',
  '1.15',
  'inclusive',
  500,  -- Applied first
  NOW()
);

-- Additional support fee (5%)
INSERT INTO payment_adjustment_catalog (...) VALUES (
  gen_random_uuid(),
  'Support Fee',
  'Customer support and maintenance',
  'multiply',
  '1.05',
  'inclusive',
  600,  -- Applied second
  NOW()
);
```

**Result**: Fees compound (1.15 × 1.05 = 1.2075 or ~20.75% total)

## Quick Reference

### Common Fee Settings

| Operator | Magnitude | User Pays | Your Profit/Loss |
|----------|-----------|-----------|------------------|
| multiply | 1.50 | 150% | +50% profit |
| multiply | 1.30 | 130% | +30% profit |
| multiply | 1.20 | 120% | +20% profit |
| multiply | 1.15 | 115% | +15% profit ✅ |
| multiply | 1.10 | 110% | +10% profit ✅ |
| multiply | 1.05 | 105% | +5% profit |
| multiply | 1.00 | 100% | Break-even |
| multiply | 0.90 | 90% | -10% loss |
| multiply | 0.80 | 80% | -20% loss |
| multiply | 0.766 | 76.6% | -23.4% loss ❌ |

### Commands Cheat Sheet

```bash
# View current fees
docker exec ar-io-bundler-postgres psql -U turbo_admin -d payment_service -c \
  "SELECT * FROM payment_adjustment_catalog WHERE adjustment_end_date IS NULL;"

# Test pricing
curl "http://localhost:4001/v1/price/bytes/1000000"

# Restart services after .env changes
./scripts/restart.sh
```

## ArNS Provisioning Surcharge (`ANT_SPAWN_WINC_SURCHARGE`)

Separate from the upload fee adjustments above, the **ArNS-with-credits** feature
has a single fee knob for cost recovery on provisioned name purchases.

```bash
# .env (payment service). Winc surcharge, default 0.
ANT_SPAWN_WINC_SURCHARGE=0
```

**What it does:** when a buyer has **no ANT** of their own and `ARNS_PROVISIONING_ENABLED=true`,
Turbo spawns a fresh Metaplex Core ANT owned by its server wallet, which costs the
signer real **SOL** (rent ~0.02 SOL + gas). `ANT_SPAWN_WINC_SURCHARGE` is folded
into that provisioned buy's credit debit so you recover the spawn SOL rent.

- Denominated in **winc** (the same credit unit as upload pricing), added to the
  name's purchase price for that buy.
- **Only applies to provisioned buys** (no `processId`/`antId` supplied). A
  bring-your-own-ANT buy, an extend, or an upgrade is **not** surcharged.
- Default `0` = no surcharge (you absorb the SOL rent). Set it to roughly the
  winc-equivalent of the spawn rent + a margin to break even on provisioning.
- Requires a **restart** to apply (payment service env). See
  `docs/guides/ARNS_INTEGRATION_GUIDE.md` for the full ArNS feature/ops detail.

## Support

For questions about fee configuration:
- Review pricing code: `packages/payment-service/src/pricing/`
- Check database migrations: `packages/payment-service/src/database/migration.ts`
- See adjustment types: `packages/payment-service/src/database/dbTypes.ts`

---

**Important**: The default configuration subsidizes uploads at a loss. Update your fees to ensure sustainable operation!
