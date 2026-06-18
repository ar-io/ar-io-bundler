# High Availability and Disaster Recovery Guide

**Version:** 1.0.0
**Last Updated:** 2025-10-28
**Status:** Comprehensive Architecture Guide

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Current Architecture Analysis](#current-architecture-analysis)
3. [High Availability Requirements](#high-availability-requirements)
4. [Component-by-Component HA Strategy](#component-by-component-ha-strategy)
5. [Deployment Topologies](#deployment-topologies)
6. [Disaster Recovery](#disaster-recovery)
7. [Implementation Roadmap](#implementation-roadmap)
8. [Cost Analysis](#cost-analysis)
9. [Monitoring and Alerting](#monitoring-and-alerting)
10. [Runbooks](#runbooks)

---

## Executive Summary

### Current State

The AR.IO Bundler currently operates as a **single-node deployment** with all components (APIs, databases, cache, storage, workers) running on one machine. This presents multiple Single Points of Failure (SPOFs):

- ❌ **No redundancy**: Hardware failure = complete outage
- ❌ **No geographic distribution**: Data center outage = complete outage
- ❌ **No load distribution**: Limited to single-machine capacity
- ❌ **No failover**: Recovery requires manual intervention
- ❌ **No backup automation**: Data loss risk

### Target State Options

We present **three HA deployment levels** with increasing availability and cost:

| Level | Availability | Annual Downtime | RTO | RPO | Estimated Cost | Complexity |
|-------|-------------|-----------------|-----|-----|----------------|------------|
| **Level 1: Basic HA** | 99.9% (3 nines) | ~8.76 hours/year | 5-15 min | 5 min | 3-5x base | Medium |
| **Level 2: Standard HA** | 99.95% (3.5 nines) | ~4.38 hours/year | 1-5 min | 1 min | 5-8x base | High |
| **Level 3: Geographic HA** | 99.99% (4 nines) | ~52 min/year | 30 sec | 10 sec | 10-15x base | Very High |

**Recommended Path:** Progressive implementation from Level 1 → Level 2 → Level 3

---

## Current Architecture Analysis

### Component Inventory

```
┌─────────────────────────────────────────────────────────┐
│                   Single Node (SPOF)                     │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  Payment API │  │  Upload API  │  │Bull Board UI │  │
│  │  (Port 4001) │  │  (Port 3001) │  │  (Port 3002) │  │
│  │  PM2 x2      │  │  PM2 x2      │  │  PM2 x1      │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │Upload Workers│  │  PostgreSQL  │  │    Redis     │  │
│  │ PM2 x1 (fork)│  │  2 databases │  │  2 instances │  │
│  │  11 queues   │  │   port 5432  │  │ 6379 / 6381  │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐                    │
│  │    MinIO     │  │  Arweave JWK │                    │
│  │  Object Store│  │  Wallet File │                    │
│  │ 9000 / 9001  │  │  (Critical!) │                    │
│  └──────────────┘  └──────────────┘                    │
└─────────────────────────────────────────────────────────┘
```

### Single Points of Failure (SPOFs)

| Component | Impact if Failed | Current Mitigation | HA Priority |
|-----------|------------------|-------------------|-------------|
| **Server Hardware** | Complete outage | None | 🔴 Critical |
| **PostgreSQL** | No payments, no uploads | None | 🔴 Critical |
| **Redis Cache** | Degraded performance | None | 🟡 High |
| **Redis Queues** | No bundling, job loss | None | 🔴 Critical |
| **MinIO** | No uploads, no bundling | None | 🔴 Critical |
| **Payment API** | No payments accepted | PM2 auto-restart | 🟡 High |
| **Upload API** | No uploads accepted | PM2 auto-restart | 🟡 High |
| **Workers** | No bundle processing | PM2 auto-restart | 🟡 High |
| **Network** | Complete outage | None | 🔴 Critical |
| **Power** | Complete outage | None | 🔴 Critical |

### State Management Analysis

**Stateless Components** (Easy to scale horizontally):
- ✅ Payment Service API (JWT auth only)
- ✅ Upload Service API (mostly stateless)
- ✅ Bull Board UI (read-only dashboard)

**Stateful Components** (Requires careful HA design):
- ⚠️ PostgreSQL (payment transactions, upload metadata)
- ⚠️ Redis Queues (BullMQ job state)
- ⚠️ Redis Cache (session data, rate limits)
- ⚠️ MinIO (data items, bundles)
- ⚠️ Multipart upload state (in-flight uploads)
- ⚠️ x402 payment state (pending validation)

**Critical Consistency Requirements:**
1. **x402 payments**: Must never be double-processed or lost
2. **Balance reservations**: Must be atomic and consistent
3. **Bundle jobs**: Must not duplicate or lose data items
4. **Data items**: Must not be lost during storage
5. **Payment finalization**: Must be idempotent

---

## High Availability Requirements

### Business Requirements

**Define Your SLA (Service Level Agreement):**

| Metric | Definition | Example Targets |
|--------|------------|-----------------|
| **Availability** | Uptime percentage | 99.9% (8.76h down/year) |
| **RTO** | Recovery Time Objective | 5 minutes maximum |
| **RPO** | Recovery Point Objective | 5 minutes data loss max |
| **Performance** | Response time under load | P95 < 500ms |
| **Throughput** | Requests per second | 1000 RPS sustained |

**Critical User Journeys** (Must remain operational):
1. ✅ x402 payment processing (< 3 second end-to-end)
2. ✅ Data item upload (< 10 seconds for 1MB)
3. ✅ Balance queries (< 100ms)
4. ✅ ArNS purchases (< 5 seconds)
5. ✅ Bundle posting to Arweave (asynchronous, can tolerate delays)

### Technical Requirements

**Must Have:**
- 🔴 **No data loss**: PostgreSQL backups + replication
- 🔴 **Automatic failover**: Database, cache, APIs
- 🔴 **Load balancing**: Distribute traffic across instances
- 🔴 **Health checks**: Automated failure detection
- 🔴 **Monitoring**: Real-time visibility into system health

**Should Have:**
- 🟡 **Geographic distribution**: Multi-region deployment
- 🟡 **Auto-scaling**: Dynamic capacity based on load
- 🟡 **Blue-green deployments**: Zero-downtime updates
- 🟡 **Chaos engineering**: Regular failure testing

**Nice to Have:**
- ⚪ **Multi-cloud**: Avoid cloud vendor lock-in
- ⚪ **Edge caching**: CDN for static assets
- ⚪ **Active-active**: Full redundancy across regions

---

## Component-by-Component HA Strategy

### 1. Application Layer (APIs)

**Current:** 2 instances per service via PM2 cluster mode on single node

**HA Strategy:**

#### Option A: Multi-Node PM2 (Simple)
```
┌────────────────┐    ┌────────────────┐    ┌────────────────┐
│    Node 1      │    │    Node 2      │    │    Node 3      │
│                │    │                │    │                │
│ Payment API x2 │    │ Payment API x2 │    │ Payment API x2 │
│ Upload API x2  │    │ Upload API x2  │    │ Upload API x2  │
└────────────────┘    └────────────────┘    └────────────────┘
         │                     │                     │
         └─────────────────────┼─────────────────────┘
                               │
                      ┌────────▼────────┐
                      │  Load Balancer  │
                      │   (HAProxy)     │
                      └─────────────────┘
```

**Implementation:**
```yaml
# HAProxy config (/etc/haproxy/haproxy.cfg)
frontend api_frontend
    bind *:80
    bind *:443 ssl crt /etc/ssl/certs/bundler.pem
    acl is_payment path_beg /v1/x402 /v1/balance /v1/top-up
    acl is_upload path_beg /v1/tx /v1/upload
    use_backend payment_backend if is_payment
    use_backend upload_backend if is_upload

backend payment_backend
    balance roundrobin
    option httpchk GET /health
    server payment1 10.0.1.10:4001 check
    server payment2 10.0.1.11:4001 check
    server payment3 10.0.1.12:4001 check

backend upload_backend
    balance roundrobin
    option httpchk GET /v1/info
    server upload1 10.0.1.10:3001 check
    server upload2 10.0.1.11:3001 check
    server upload3 10.0.1.12:3001 check
```

**Pros:**
- ✅ Simple to implement
- ✅ Works with existing PM2 setup
- ✅ Low operational overhead

**Cons:**
- ❌ Manual node management
- ❌ No auto-scaling
- ❌ Requires careful coordination

#### Option B: Kubernetes (Advanced)
```yaml
# k8s/payment-service-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
spec:
  replicas: 3
  selector:
    matchLabels:
      app: payment-service
  template:
    metadata:
      labels:
        app: payment-service
    spec:
      containers:
      - name: payment-service
        image: ar-io-bundler/payment-service:latest
        ports:
        - containerPort: 4001
        env:
        - name: DB_HOST
          valueFrom:
            secretKeyRef:
              name: db-credentials
              key: host
        livenessProbe:
          httpGet:
            path: /health
            port: 4001
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 4001
          initialDelaySeconds: 5
          periodSeconds: 5
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "2Gi"
            cpu: "2000m"
---
apiVersion: v1
kind: Service
metadata:
  name: payment-service
spec:
  type: LoadBalancer
  selector:
    app: payment-service
  ports:
  - port: 4001
    targetPort: 4001
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: payment-service-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-service
  minReplicas: 3
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

**Pros:**
- ✅ Auto-scaling based on load
- ✅ Self-healing (automatic restarts)
- ✅ Rolling updates with zero downtime
- ✅ Resource management
- ✅ Industry standard

**Cons:**
- ❌ Steep learning curve
- ❌ Additional infrastructure complexity
- ❌ Requires Kubernetes expertise

**Recommendation:** Start with **Option A (HAProxy)**, migrate to **Option B (Kubernetes)** as team matures.

---

### 2. Database Layer (PostgreSQL)

**Current:** Single PostgreSQL instance with 2 databases (`payment_service`, `upload_service`)

**Critical Requirements:**
- ACID compliance (x402 payments must be atomic)
- Low latency (< 10ms queries)
- High availability (automatic failover)
- Point-in-time recovery

#### Option A: PostgreSQL Streaming Replication + Patroni

```
┌──────────────────┐         ┌──────────────────┐
│   Primary Node   │────────▶│  Standby Node    │
│  PostgreSQL +    │ Async   │  PostgreSQL +    │
│    Patroni       │ Stream  │    Patroni       │
│  (Read/Write)    │         │   (Read-Only)    │
└─────────┬────────┘         └─────────┬────────┘
          │                            │
          │    ┌──────────────────┐    │
          └────│   etcd Cluster   │────┘
               │  (3 nodes for    │
               │   quorum)        │
               └──────────────────┘

Automatic failover: Standby promotes to Primary in ~10 seconds
```

**Implementation:**
```bash
# Install Patroni on all PostgreSQL nodes
apt-get install python3-pip postgresql-16
pip3 install patroni[etcd] python-etcd

# Patroni config (/etc/patroni.yml)
scope: bundler-postgres
namespace: /db/
name: postgres1

restapi:
  listen: 0.0.0.0:8008
  connect_address: 10.0.1.10:8008

etcd:
  hosts: 10.0.2.10:2379,10.0.2.11:2379,10.0.2.12:2379

bootstrap:
  dcs:
    ttl: 30
    loop_wait: 10
    retry_timeout: 10
    maximum_lag_on_failover: 1048576
    postgresql:
      use_pg_rewind: true
      parameters:
        max_connections: 200
        shared_buffers: 2GB
        effective_cache_size: 6GB
        maintenance_work_mem: 512MB
        checkpoint_completion_target: 0.9
        wal_buffers: 16MB
        default_statistics_target: 100
        random_page_cost: 1.1
        effective_io_concurrency: 200
        work_mem: 5MB
        min_wal_size: 1GB
        max_wal_size: 4GB
        max_worker_processes: 4
        max_parallel_workers_per_gather: 2
        max_parallel_workers: 4

postgresql:
  listen: 0.0.0.0:5432
  connect_address: 10.0.1.10:5432
  data_dir: /var/lib/postgresql/16/main
  pgpass: /tmp/pgpass
  authentication:
    replication:
      username: replicator
      password: <strong-password>
    superuser:
      username: postgres
      password: <strong-password>
  parameters:
    unix_socket_directories: '/var/run/postgresql'
```

**Client Connection (Application):**
```bash
# Use Patroni REST API to get current primary
DB_HOST=$(curl -s http://patroni-cluster:8008/primary | jq -r .host)

# Or use HAProxy to route to primary
# HAProxy checks Patroni REST API and routes writes to primary
```

**Pros:**
- ✅ Automatic failover (~10 second RTO)
- ✅ Read replicas for load distribution
- ✅ Built-in health checking
- ✅ No data loss with synchronous replication

**Cons:**
- ❌ Requires etcd cluster (3+ nodes)
- ❌ Complex initial setup
- ❌ Requires PostgreSQL expertise

#### Option B: Managed Database Service

**AWS RDS Multi-AZ:**
```hcl
# Terraform config
resource "aws_db_instance" "bundler_payment" {
  identifier = "bundler-payment-db"
  engine     = "postgres"
  engine_version = "16.1"
  instance_class = "db.t3.large"
  allocated_storage = 100
  storage_type = "gp3"

  multi_az = true  # Automatic failover

  backup_retention_period = 7
  backup_window = "03:00-04:00"
  maintenance_window = "Mon:04:00-Mon:05:00"

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  performance_insights_enabled = true
  monitoring_interval = 60

  tags = {
    Environment = "production"
    Component   = "payment-database"
  }
}
```

**Pros:**
- ✅ Fully managed (no ops overhead)
- ✅ Automatic backups
- ✅ Automatic failover (< 60 sec)
- ✅ Point-in-time recovery
- ✅ Monitoring included

**Cons:**
- ❌ Higher cost
- ❌ Vendor lock-in
- ❌ Less control over configuration
- ❌ Network latency if not co-located

**Recommendation:**
- **Self-hosted:** Use **Option A (Patroni)** for full control
- **Managed:** Use **Option B (RDS Multi-AZ)** for simplicity

---

### 3. Cache Layer (Redis)

**Current:** 2 Redis instances (cache on 6379, queues on 6381) on single node

**HA Strategy:**

#### Redis Sentinel (Automatic Failover)

```
┌────────────────────────────────────────────────────────┐
│                  Redis Sentinel Cluster                │
│                                                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐   │
│  │  Sentinel 1 │  │  Sentinel 2 │  │  Sentinel 3 │   │
│  │  (Monitor)  │  │  (Monitor)  │  │  (Monitor)  │   │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘   │
│         │                │                │           │
│         └────────────────┼────────────────┘           │
│                          │                            │
│         ┌────────────────▼────────────────┐           │
│         │                                 │           │
│  ┌──────▼──────┐   ┌──────────────┐   ┌──▼───────┐  │
│  │   Primary   │───│   Replica 1  │   │ Replica 2│  │
│  │ Redis Cache │   │              │   │          │  │
│  │  (R/W)      │   │  (Read-Only) │   │ (R-Only) │  │
│  └─────────────┘   └──────────────┘   └──────────┘  │
│                                                       │
│  Automatic failover: Replica promotes in ~5 seconds  │
└───────────────────────────────────────────────────────┘
```

**Implementation:**
```bash
# Redis config (/etc/redis/redis.conf) - Primary
bind 0.0.0.0
port 6379
requirepass <strong-password>
masterauth <strong-password>
save 900 1
save 300 10
save 60 10000

# Redis config - Replicas
replicaof 10.0.1.10 6379
replica-read-only yes

# Sentinel config (/etc/redis/sentinel.conf)
port 26379
sentinel monitor cache-primary 10.0.1.10 6379 2
sentinel auth-pass cache-primary <strong-password>
sentinel down-after-milliseconds cache-primary 5000
sentinel parallel-syncs cache-primary 1
sentinel failover-timeout cache-primary 10000
```

**Client Connection (Application):**
```typescript
// packages/payment-service/src/cache.ts
import Redis from 'ioredis';

const redis = new Redis({
  sentinels: [
    { host: '10.0.2.10', port: 26379 },
    { host: '10.0.2.11', port: 26379 },
    { host: '10.0.2.12', port: 26379 },
  ],
  name: 'cache-primary',
  password: process.env.REDIS_PASSWORD,
  retryStrategy: (times) => Math.min(times * 50, 2000),
  reconnectOnError: (err) => {
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) {
      // Reconnect when promoted replica is still read-only
      return true;
    }
    return false;
  },
});
```

**Separate Setup for BullMQ Queues:**
```bash
# Redis Queues (port 6381) - separate Sentinel cluster
sentinel monitor queue-primary 10.0.1.10 6381 2
sentinel auth-pass queue-primary <strong-password>
sentinel down-after-milliseconds queue-primary 5000
```

**Pros:**
- ✅ Automatic failover (~5 seconds)
- ✅ Read replicas for caching layer
- ✅ Simple configuration
- ✅ Battle-tested

**Cons:**
- ❌ Single master (write bottleneck)
- ❌ Requires 3+ Sentinel nodes
- ❌ Manual sharding if dataset too large

**Alternative: Managed Redis**
```bash
# AWS ElastiCache Redis with Multi-AZ
# Automatic failover, backups, patching
# Higher cost, no operational overhead
```

**Recommendation:** Use **Redis Sentinel** for both cache and queue instances.

---

### 4. Object Storage (MinIO)

**Current:** Single MinIO instance on single node

**HA Strategy:**

#### Option A: MinIO Distributed Mode

```
┌────────────────────────────────────────────────────────┐
│           MinIO Distributed (Erasure Coding)           │
│                                                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐│
│  │  Node 1  │  │  Node 2  │  │  Node 3  │  │ Node 4 ││
│  │ 4x disks │  │ 4x disks │  │ 4x disks │  │4x disks││
│  └──────────┘  └──────────┘  └──────────┘  └────────┘│
│                                                        │
│  Data split across nodes with EC:4 (4 data + 2 parity)│
│  Tolerates 2 node failures with zero data loss        │
└────────────────────────────────────────────────────────┘
```

**Minimum:** 4 nodes with 4 drives each (16 drives total)

**Implementation:**
```bash
# Start MinIO distributed on each node
export MINIO_ROOT_USER=minioadmin
export MINIO_ROOT_PASSWORD=minioadmin123

minio server \
  http://minio{1...4}.internal:9000/mnt/disk{1...4}/minio \
  --console-address ":9001" \
  --address ":9000"
```

**Pros:**
- ✅ No SPOF (tolerates N/2 node failures)
- ✅ Erasure coding for data protection
- ✅ Self-healing
- ✅ Load balanced automatically

**Cons:**
- ❌ Requires 4+ nodes minimum
- ❌ High storage overhead (EC:4 = 1.5x raw capacity)
- ❌ Network bandwidth intensive

#### Option B: Managed S3 (AWS S3, Backblaze B2, Wasabi)

```typescript
// packages/upload-service/src/arch/s3ObjectStore.ts
import { S3Client } from '@aws-sdk/client-s3';

const s3Client = new S3Client({
  region: 'us-east-1',
  // AWS S3: 99.999999999% durability (11 nines)
  // Automatic replication across 3+ availability zones
});
```

**Pros:**
- ✅ Highest durability (11 nines)
- ✅ Unlimited scalability
- ✅ No operational overhead
- ✅ Geographic replication

**Cons:**
- ❌ Bandwidth costs (egress charges)
- ❌ API rate limits
- ❌ Vendor lock-in
- ❌ Higher per-GB costs

**Recommendation:**
- **High volume**: Use **MinIO Distributed** (4+ nodes)
- **Simplicity**: Use **Managed S3** (AWS/Backblaze/Wasabi)

---

### 5. Workers (BullMQ)

**Current:** Single worker instance (fork mode) to prevent duplicate processing

**Challenge:** Workers must coordinate to avoid duplicate job processing while providing redundancy

**HA Strategy:**

#### Multiple Workers with Proper Concurrency

```
┌────────────────────────────────────────────────────────┐
│                  Worker Pool (3 nodes)                 │
│                                                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐│
│  │   Node 1     │  │   Node 2     │  │   Node 3     ││
│  │              │  │              │  │              ││
│  │ planBundle   │  │ planBundle   │  │ planBundle   ││
│  │ prepare x2   │  │ prepare x2   │  │ prepare x2   ││
│  │ postBundle   │  │ postBundle   │  │ postBundle   ││
│  │ verify       │  │ verify       │  │ verify       ││
│  └──────────────┘  └──────────────┘  └──────────────┘│
│         │                  │                  │        │
│         └──────────────────┼──────────────────┘        │
│                            │                           │
│                   ┌────────▼────────┐                  │
│                   │  Redis Queues   │                  │
│                   │  (Sentinel HA)  │                  │
│                   └─────────────────┘                  │
│                                                        │
│  BullMQ handles job distribution and locking          │
└────────────────────────────────────────────────────────┘
```

**Implementation:**
```typescript
// packages/upload-service/src/workers/allWorkers.ts
import { Worker } from 'bullmq';

// planBundle worker - only 1 active across cluster
export const planWorker = new Worker(
  'plan-bundle',
  async (job) => {
    // Job processing logic
  },
  {
    connection: redisConnection,
    concurrency: 1, // Only 1 job at a time
    // BullMQ distributed lock ensures only 1 worker processes
  }
);

// prepareBundle worker - multiple concurrent across cluster
export const prepareWorker = new Worker(
  'prepare-bundle',
  async (job) => {
    // Job processing logic
  },
  {
    connection: redisConnection,
    concurrency: 3, // 3 concurrent per node = 9 total
    // Each job is locked, no duplicates
  }
);
```

**Key Considerations:**
1. **BullMQ handles distributed locking** - no custom coordination needed
2. **Set appropriate concurrency** per worker type
3. **Idempotent job handlers** - safe to retry
4. **Job timeouts** - prevent stuck jobs from blocking queue

**Worker Scaling Strategy:**

| Worker Type | Concurrency per Node | Scaling Strategy |
|-------------|---------------------|------------------|
| **planBundle** | 1 | Single instance across cluster (cron trigger) |
| **prepareBundle** | 3-5 | Scale based on queue depth |
| **postBundle** | 2 | Limited by Arweave API rate limits |
| **verifyBundle** | 5 | High concurrency (read-only checks) |
| **opticalPost** | 3 | Limited by AR.IO Gateway rate limits |
| **putOffsets** | 10 | High concurrency (PostgreSQL writes) |
| **cleanupFs** | 2 | Low priority, infrequent |

**Kubernetes Worker Deployment:**
```yaml
# k8s/upload-workers-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: upload-workers
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: workers
        image: ar-io-bundler/upload-workers:latest
        env:
        - name: REDIS_QUEUE_HOST
          value: "redis-sentinel-service"
        - name: WORKER_CONCURRENCY_PREPARE
          value: "3"
        - name: WORKER_CONCURRENCY_POST
          value: "2"
        resources:
          requests:
            memory: "2Gi"
            cpu: "1000m"
```

**Pros:**
- ✅ Automatic job distribution
- ✅ No duplicate processing (BullMQ locks)
- ✅ Worker redundancy
- ✅ Horizontal scaling

**Cons:**
- ❌ Requires careful concurrency tuning
- ❌ Depends on Redis availability

**Recommendation:** Deploy **3 worker nodes** with appropriate concurrency per queue type.

---

### 6. Critical State: Arweave JWK Wallet

**Current:** Single `wallet.json` file on disk

**Challenge:** All nodes need access to JWK wallet for bundle signing

**HA Strategy:**

#### Option A: Shared Secret Store (Kubernetes Secret / Vault)

```yaml
# Create Kubernetes Secret from wallet file
kubectl create secret generic arweave-wallet \
  --from-file=wallet.json=./wallet.json \
  --namespace=ar-io-bundler

# Mount in worker pods
apiVersion: apps/v1
kind: Deployment
metadata:
  name: upload-workers
spec:
  template:
    spec:
      containers:
      - name: workers
        volumeMounts:
        - name: wallet
          mountPath: /secrets
          readOnly: true
        env:
        - name: TURBO_JWK_FILE
          value: "/secrets/wallet.json"
      volumes:
      - name: wallet
        secret:
          secretName: arweave-wallet
          items:
          - key: wallet.json
            path: wallet.json
```

#### Option B: HashiCorp Vault

```bash
# Store wallet in Vault
vault kv put secret/arweave/wallet @wallet.json

# Application fetches at startup
export VAULT_ADDR='http://vault.internal:8200'
export VAULT_TOKEN='s.abc123...'
vault kv get -format=json secret/arweave/wallet > /tmp/wallet.json
```

**Pros:**
- ✅ Centralized secret management
- ✅ Access control and audit logs
- ✅ Encryption at rest
- ✅ Automatic distribution to nodes

**Cons:**
- ❌ Additional infrastructure dependency
- ❌ Vault itself needs to be HA

**Recommendation:** Use **Kubernetes Secrets** (simple) or **Vault** (enterprise-grade).

---

## Deployment Topologies

### Level 1: Basic HA (99.9% - 3 Nines)

**Target:** Small-medium workloads, cost-conscious, 8.76 hours downtime/year acceptable

```
┌──────────────────────────────────────────────────────────┐
│                      Internet                            │
└──────────────────────┬───────────────────────────────────┘
                       │
              ┌────────▼────────┐
              │   HAProxy LB    │  (2 nodes, keepalived)
              │  Floating IP    │
              └────────┬────────┘
                       │
        ┌──────────────┼──────────────┐
        │              │              │
   ┌────▼────┐    ┌────▼────┐   ┌────▼────┐
   │ Node 1  │    │ Node 2  │   │ Node 3  │
   │         │    │         │   │         │
   │ API x2  │    │ API x2  │   │ Workers │
   └────┬────┘    └────┬────┘   └────┬────┘
        │              │              │
        └──────────────┼──────────────┘
                       │
              ┌────────▼────────┐
              │   PostgreSQL    │  (Primary + 1 Standby)
              │   + Patroni     │
              └─────────────────┘
              ┌─────────────────┐
              │  Redis Sentinel │  (3 instances)
              │  Cache + Queues │
              └─────────────────┘
              ┌─────────────────┐
              │  MinIO or S3    │
              └─────────────────┘
```

**Components:**
- **3 application nodes**: 2 API nodes + 1 worker node
- **2 database nodes**: Primary + 1 standby (Patroni)
- **3 Redis Sentinel nodes**: Automatic failover
- **2 HAProxy nodes**: Active-passive with floating IP
- **MinIO**: Either 4-node distributed OR managed S3

**Estimated Costs (AWS):**
| Component | Instance Type | Count | Monthly Cost |
|-----------|---------------|-------|--------------|
| API Nodes | t3.large | 2 | $120 |
| Worker Node | t3.xlarge | 1 | $120 |
| PostgreSQL | RDS Multi-AZ db.t3.large | 1 | $240 |
| Redis | ElastiCache r6g.large Multi-AZ | 2 | $280 |
| S3 Storage | Standard (1TB) | - | $23 |
| Load Balancer | ALB | 1 | $23 |
| **Total** | | | **~$806/month** |

**Base cost (single node):** ~$200/month
**Multiplier:** ~4x

---

### Level 2: Standard HA (99.95% - 3.5 Nines)

**Target:** Production workloads, 4.38 hours downtime/year acceptable

```
┌──────────────────────────────────────────────────────────┐
│                 Internet (Multi-AZ)                      │
└──────────────────────┬───────────────────────────────────┘
                       │
              ┌────────▼────────┐
              │  Cloud Load     │  (AWS ALB/NLB)
              │  Balancer       │  (Auto-scaling groups)
              └────────┬────────┘
                       │
        ┌──────────────┼──────────────┬─────────────┐
        │              │              │             │
   ┌────▼────┐    ┌────▼────┐   ┌────▼────┐  ┌────▼────┐
   │ AZ-A    │    │ AZ-B    │   │ AZ-C    │  │ AZ-A    │
   │ API x2  │    │ API x2  │   │ API x2  │  │Workers  │
   └────┬────┘    └────┬────┘   └────┬────┘  └────┬────┘
        │              │              │            │
        └──────────────┼──────────────┼────────────┘
                       │              │
              ┌────────▼────────┐     │
              │  RDS Multi-AZ   │     │
              │  PostgreSQL     │     │
              │  Auto-failover  │     │
              └─────────────────┘     │
              ┌─────────────────┐     │
              │ ElastiCache     │     │
              │ Redis Multi-AZ  │     │
              │ 2 clusters      │     │
              └─────────────────┘     │
              ┌─────────────────┐     │
              │   S3 Standard   │     │
              │  (11 9s durable)│     │
              └─────────────────┘     │
              ┌─────────────────┐     │
              │  CloudWatch     │◄────┘
              │  Monitoring     │
              └─────────────────┘
```

**Components:**
- **9+ application nodes**: 6 API (2 per AZ) + 3+ workers
- **RDS Multi-AZ**: Automatic failover < 60 seconds
- **ElastiCache Multi-AZ**: 2 clusters (cache + queues)
- **S3**: Managed object storage
- **Auto-scaling**: Based on CPU/memory/queue depth
- **CloudWatch**: Monitoring + alerting

**Estimated Costs (AWS):**
| Component | Instance Type | Count | Monthly Cost |
|-----------|---------------|-------|--------------|
| API Nodes | t3.large (ASG) | 6 | $360 |
| Worker Nodes | t3.xlarge (ASG) | 3 | $360 |
| PostgreSQL | RDS Multi-AZ db.r6g.large | 1 | $430 |
| Redis | ElastiCache r6g.large Multi-AZ | 2 | $280 |
| S3 Storage | Standard (1TB) | - | $23 |
| Load Balancer | ALB | 1 | $23 |
| CloudWatch | Logs + Metrics | - | $50 |
| **Total** | | | **~$1,526/month** |

**Multiplier:** ~7.5x base cost

---

### Level 3: Geographic HA (99.99% - 4 Nines)

**Target:** Mission-critical, global workloads, < 1 hour downtime/year

```
┌──────────────────────────────────────────────────────────┐
│              Global Load Balancer (Route 53)             │
│          GeoDNS + Health Checks + Failover               │
└──────────────────┬───────────────────────────────────────┘
                   │
        ┌──────────┼──────────┐
        │                     │
   ┌────▼────────┐      ┌────▼────────┐
   │  Region 1   │      │  Region 2   │
   │  (Primary)  │◄────▶│  (Standby)  │
   │             │ Rep  │             │
   │ Full Stack  │      │ Full Stack  │
   │   Multi-AZ  │      │   Multi-AZ  │
   └─────────────┘      └─────────────┘
        │                     │
        └──────────┬──────────┘
                   │
              ┌────▼────┐
              │ Aurora  │
              │ Global  │
              │Database │
              │ < 1sec  │
              │ replica │
              │  lag    │
              └─────────┘
```

**Region 1 (Primary - us-east-1):**
- 9 application nodes (3 AZs)
- Aurora PostgreSQL Multi-AZ
- ElastiCache Multi-AZ
- S3 with Cross-Region Replication

**Region 2 (Standby - eu-west-1):**
- 9 application nodes (3 AZs)
- Aurora Read Replica (promoted on failover)
- ElastiCache Multi-AZ
- S3 replica bucket

**Failover Strategy:**
- **Route 53 Health Checks**: Automatic DNS failover (60 sec)
- **Aurora Global Database**: < 1 second replication lag
- **S3 CRR**: Asynchronous replication
- **Active-Standby**: Region 2 promotes to active on Region 1 failure

**Estimated Costs (AWS):**
| Component | Monthly Cost |
|-----------|--------------|
| Region 1 (full stack) | $1,800 |
| Region 2 (full stack) | $1,800 |
| Aurora Global Database | $600 |
| S3 Cross-Region Replication | $100 |
| Route 53 Health Checks | $10 |
| CloudFront CDN | $50 |
| **Total** | **~$4,360/month** |

**Multiplier:** ~22x base cost

---

## Disaster Recovery

### Backup Strategy

#### 1. PostgreSQL Backups

**Automated Backups:**
```bash
# Cron job for continuous archiving
0 */1 * * * /usr/bin/pg_basebackup \
  -h localhost \
  -U postgres \
  -D /backup/pg_$(date +\%Y\%m\%d_\%H\%M) \
  --format=tar \
  --gzip \
  --checkpoint=fast

# WAL archiving (continuous)
archive_mode = on
archive_command = 'aws s3 cp %p s3://bundler-backups/wal/%f'
```

**Point-in-Time Recovery (PITR):**
```bash
# Restore to specific timestamp
pg_restore \
  --dbname=payment_service \
  --clean \
  --if-exists \
  /backup/pg_20251028_1200.tar.gz

# Apply WAL files up to specific time
recovery_target_time = '2025-10-28 12:00:00'
```

**Backup Retention:**
- **Hourly** backups: Keep 24 hours
- **Daily** backups: Keep 7 days
- **Weekly** backups: Keep 4 weeks
- **Monthly** backups: Keep 12 months

#### 2. Redis Backups

```bash
# AOF (Append-Only File) for durability
appendonly yes
appendfsync everysec

# RDB snapshots
save 900 1
save 300 10
save 60 10000

# Backup to S3
0 2 * * * redis-cli --rdb /tmp/dump.rdb && \
  aws s3 cp /tmp/dump.rdb s3://bundler-backups/redis/dump_$(date +\%Y\%m\%d).rdb
```

#### 3. MinIO/S3 Backups

**S3 Versioning:**
```bash
# Enable versioning on buckets
aws s3api put-bucket-versioning \
  --bucket raw-data-items \
  --versioning-configuration Status=Enabled

# Lifecycle policy: Transition old versions to Glacier
{
  "Rules": [{
    "Id": "archive-old-versions",
    "Status": "Enabled",
    "NoncurrentVersionTransitions": [{
      "NoncurrentDays": 30,
      "StorageClass": "GLACIER"
    }]
  }]
}
```

**Cross-Region Replication:**
```bash
# Replicate to secondary region
aws s3api put-bucket-replication \
  --bucket raw-data-items \
  --replication-configuration file://replication-config.json
```

### Recovery Procedures

#### Scenario 1: Single Node Failure

**Detection:** Health check fails, HAProxy removes from pool

**Recovery:**
1. **Automatic:** PM2 restarts crashed processes
2. **If node unresponsive:** HAProxy routes to healthy nodes
3. **Manual intervention:** SSH to node, check logs, restart services
4. **If hardware failure:** Provision new node, deploy code, rejoin cluster

**RTO:** < 5 minutes (automatic)
**RPO:** 0 (no data loss)

#### Scenario 2: Database Failure

**Detection:** Patroni detects primary failure via etcd

**Recovery:**
1. **Automatic:** Patroni promotes standby to primary (~10 seconds)
2. **Applications reconnect:** Connection pool detects new primary
3. **Monitor replication lag:** Ensure new standby catches up
4. **Investigate root cause:** Check logs, disk space, corruption

**RTO:** < 1 minute (automatic)
**RPO:** < 5 seconds (streaming replication lag)

#### Scenario 3: Complete Data Center Outage

**Detection:** Route 53 health checks fail, DNS failover triggered

**Recovery (Geographic HA deployment):**
1. **Automatic:** Route 53 fails over to secondary region (< 60 sec)
2. **Promote read replica:** Aurora Global Database promotes secondary
3. **Workers start processing:** Queue jobs resume in secondary region
4. **Monitor:** Check for replication lag, stuck jobs

**RTO:** < 5 minutes
**RPO:** < 1 minute (replication lag)

#### Scenario 4: Data Corruption / Human Error

**Detection:** Incorrect data discovered (e.g., wrong payment amount)

**Recovery:**
1. **Identify corruption time:** Query audit logs
2. **Restore from PITR:**
   ```bash
   # Restore payment_service to 1 hour ago
   pg_restore --dbname=payment_service_recovered \
     /backup/pg_20251028_1100.tar.gz

   # Apply WAL up to corruption point
   recovery_target_time = '2025-10-28 11:45:00'
   ```
3. **Verify data integrity:** Check balances, payment states
4. **Compare with production:** Identify missing transactions
5. **Replay missing transactions:** From audit logs
6. **Cutover:** Rename databases, restart services

**RTO:** 1-4 hours (manual process)
**RPO:** Up to backup interval (1 hour with hourly backups)

### Testing Disaster Recovery

**Quarterly DR Drills:**

1. **Week 1:** Simulate single node failure
   - Stop services on Node 1
   - Verify automatic failover
   - Measure RTO

2. **Week 2:** Simulate database failover
   - Stop primary PostgreSQL (patroni cluster)
   - Verify standby promotion
   - Check application recovery

3. **Week 3:** Restore from backup
   - Create test environment
   - Restore PostgreSQL from yesterday's backup
   - Verify data integrity

4. **Week 4:** Full region failover (if multi-region)
   - Fail over to secondary region
   - Verify all services operational
   - Fail back to primary region

---

## Implementation Roadmap

### Phase 1: Basic HA (Months 1-2)

**Week 1-2: Planning & Preparation**
- [ ] Define SLA requirements (RTO, RPO, availability)
- [ ] Inventory current infrastructure
- [ ] Design network topology
- [ ] Procure hardware/cloud resources
- [ ] Set up monitoring infrastructure

**Week 3-4: Database HA**
- [ ] Deploy PostgreSQL Patroni cluster (3 nodes)
- [ ] Configure streaming replication
- [ ] Set up etcd cluster for coordination
- [ ] Test automatic failover
- [ ] Configure backup scripts (hourly to S3)

**Week 5-6: Redis HA**
- [ ] Deploy Redis Sentinel (3 nodes)
- [ ] Configure cache instance (6379)
- [ ] Configure queue instance (6381)
- [ ] Update application connection strings
- [ ] Test failover scenarios

**Week 7-8: Application HA**
- [ ] Deploy HAProxy load balancer (2 nodes)
- [ ] Configure floating IP (keepalived)
- [ ] Deploy application to 3 nodes
- [ ] Configure health checks
- [ ] Test rolling updates

**Week 9: Storage HA**
- [ ] Deploy MinIO distributed (4 nodes) OR migrate to S3
- [ ] Migrate existing data
- [ ] Test erasure coding / replication
- [ ] Benchmark performance

**Week 10: Testing & Validation**
- [ ] Load testing (JMeter, k6)
- [ ] Chaos engineering (Chaos Monkey)
- [ ] Failover testing (all components)
- [ ] Performance benchmarks
- [ ] Documentation

### Phase 2: Standard HA (Months 3-4)

**Week 1-2: Cloud Migration (if applicable)**
- [ ] Provision AWS/GCP accounts
- [ ] Set up VPC, subnets, security groups
- [ ] Migrate to RDS Multi-AZ
- [ ] Migrate to ElastiCache Multi-AZ
- [ ] Configure S3 buckets

**Week 3-4: Auto-Scaling**
- [ ] Create Docker images for all services
- [ ] Configure Auto Scaling Groups
- [ ] Set up scaling policies (CPU, queue depth)
- [ ] Test scale-out scenarios
- [ ] Test scale-in scenarios

**Week 5-6: Monitoring & Alerting**
- [ ] Deploy Prometheus + Grafana
- [ ] Configure CloudWatch (if AWS)
- [ ] Set up alerting (PagerDuty, Slack)
- [ ] Create runbooks for common incidents
- [ ] Train team on incident response

**Week 7-8: CI/CD & Blue-Green Deployments**
- [ ] Set up GitHub Actions / GitLab CI
- [ ] Automated testing pipeline
- [ ] Blue-green deployment strategy
- [ ] Rollback procedures
- [ ] Automated smoke tests

### Phase 3: Geographic HA (Months 5-6)

**Week 1-2: Secondary Region Setup**
- [ ] Provision infrastructure in Region 2
- [ ] Configure Aurora Global Database
- [ ] Set up S3 Cross-Region Replication
- [ ] Deploy applications to Region 2

**Week 3-4: DNS & Routing**
- [ ] Configure Route 53 health checks
- [ ] Set up GeoDNS policies
- [ ] Test failover to Region 2
- [ ] Measure failover RTO

**Week 5-6: Final Testing & Go-Live**
- [ ] Full DR drill (failover to Region 2)
- [ ] Performance testing (multi-region)
- [ ] Security audit
- [ ] Documentation updates
- [ ] Team training

---

## Cost Analysis

### Single Node (Baseline)

| Component | Monthly Cost |
|-----------|--------------|
| 1x VPS (8 CPU, 16GB RAM, 500GB SSD) | $80 |
| 1TB Bandwidth | $20 |
| Backups | $10 |
| Monitoring (self-hosted) | $0 |
| **Total** | **$110/month** |

### Level 1: Basic HA (3 Nines)

| Component | Monthly Cost | Notes |
|-----------|--------------|-------|
| 3x Application Nodes | $240 | t3.large |
| 2x PostgreSQL (Patroni) | $160 | t3.large |
| 3x etcd (coordination) | $90 | t3.small |
| 3x Redis Sentinel | $120 | t3.medium |
| 4x MinIO Nodes | $320 | t3.large (4 drives each) |
| 2x HAProxy | $60 | t3.small |
| Bandwidth | $50 | |
| Backups (S3) | $30 | |
| **Total** | **$1,070/month** |

**Multiplier:** 9.7x baseline

### Level 2: Standard HA (3.5 Nines) - AWS

| Component | Monthly Cost | Notes |
|-----------|--------------|-------|
| 9x EC2 (Auto Scaling) | $720 | 6x t3.large API + 3x t3.xlarge workers |
| RDS Multi-AZ | $430 | db.r6g.large |
| ElastiCache Multi-AZ (2) | $280 | r6g.large cache + queues |
| S3 Storage (1TB) | $23 | Standard storage |
| ALB | $23 | |
| Data Transfer | $100 | |
| CloudWatch | $50 | Logs + metrics |
| Backups | $30 | |
| **Total** | **$1,656/month** |

**Multiplier:** 15x baseline

### Level 3: Geographic HA (4 Nines) - AWS Multi-Region

| Component | Monthly Cost | Notes |
|-----------|--------------|-------|
| Region 1 (us-east-1) | $1,800 | Full Level 2 stack |
| Region 2 (eu-west-1) | $1,800 | Full Level 2 stack |
| Aurora Global Database | $600 | Cross-region replication |
| S3 CRR | $100 | Cross-region replication |
| Route 53 Health Checks | $10 | |
| CloudFront CDN | $50 | |
| **Total** | **$4,360/month** |

**Multiplier:** 39.6x baseline

### Hidden Costs

**Operational Overhead:**
- DevOps engineer salary: $120k-180k/year ($10k-15k/month)
- On-call rotation (3 engineers): ~$5k/month stipends
- Training and certifications: $2k/month amortized
- Incident response time: 10-20 hours/month @ $150/hour = $1.5k-3k

**Total Operational Costs:** ~$18k-25k/month for a properly staffed team

### ROI Calculation

**Downtime Costs:**
- Average revenue per hour: $1,000 (example)
- Single Node: 8.76 hours/year down = $8,760 lost
- Basic HA: 4.38 hours/year down = $4,380 lost
- Standard HA: 0.44 hours/year down = $440 lost

**Break-Even Analysis:**
If downtime costs > $1,000/hour:
- Basic HA pays for itself if prevents 1 outage/year
- Standard HA pays for itself if prevents 2 outages/year

---

## Monitoring and Alerting

### Key Metrics to Monitor

#### Application Metrics
```
# Payment Service
- x402_payment_success_rate (> 99%)
- x402_payment_latency_p95 (< 3 seconds)
- balance_query_latency_p95 (< 100ms)
- stripe_webhook_processing_time (< 5 seconds)
- api_error_rate (< 1%)

# Upload Service
- upload_success_rate (> 99%)
- upload_latency_p95 (< 10 seconds for 1MB)
- multipart_upload_completion_rate (> 95%)
- bundle_posting_success_rate (> 99%)
- data_item_permanence_rate (> 99.9%)
```

#### Infrastructure Metrics
```
# PostgreSQL
- replication_lag (< 5 seconds)
- connection_pool_utilization (< 80%)
- slow_query_count (< 10/minute)
- disk_usage (< 80%)
- cache_hit_ratio (> 95%)

# Redis
- memory_usage (< 80%)
- connected_clients (< 1000)
- keyspace_hits_ratio (> 90%)
- replication_lag (< 1 second)

# MinIO / S3
- upload_throughput (MB/s)
- download_throughput (MB/s)
- error_rate (< 0.1%)
- disk_usage (< 80%)

# Workers
- queue_depth (monitor per queue)
- job_completion_rate
- job_failure_rate (< 1%)
- worker_cpu_usage (< 80%)
```

### Alert Definitions

**Critical (Page immediately):**
```yaml
- alert: DatabaseDown
  expr: pg_up == 0
  for: 1m
  severity: critical

- alert: RedisDown
  expr: redis_up == 0
  for: 1m
  severity: critical

- alert: PaymentAPIDown
  expr: up{job="payment-service"} == 0
  for: 2m
  severity: critical

- alert: HighErrorRate
  expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.05
  for: 5m
  severity: critical

- alert: ReplicationLagHigh
  expr: pg_replication_lag_seconds > 30
  for: 5m
  severity: critical
```

**Warning (Notify, no page):**
```yaml
- alert: HighCPUUsage
  expr: cpu_usage_percent > 80
  for: 10m
  severity: warning

- alert: HighMemoryUsage
  expr: memory_usage_percent > 85
  for: 10m
  severity: warning

- alert: SlowQueries
  expr: rate(pg_slow_queries_total[5m]) > 10
  for: 5m
  severity: warning

- alert: QueueDepthGrowing
  expr: rate(queue_depth[5m]) > 100
  for: 10m
  severity: warning
```

### Monitoring Stack

**Option A: Prometheus + Grafana (Self-Hosted)**
```yaml
# docker-compose-monitoring.yml
version: '3.8'
services:
  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus-data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.retention.time=30d'

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=<strong-password>
    volumes:
      - grafana-data:/var/lib/grafana
      - ./grafana/dashboards:/etc/grafana/provisioning/dashboards

  alertmanager:
    image: prom/alertmanager:latest
    ports:
      - "9093:9093"
    volumes:
      - ./alertmanager.yml:/etc/alertmanager/alertmanager.yml

  node-exporter:
    image: prom/node-exporter:latest
    ports:
      - "9100:9100"
```

**Option B: Managed (AWS CloudWatch, Datadog, New Relic)**
- Lower operational overhead
- Higher cost
- Easier alerting integrations

---

## Runbooks

### Runbook: Database Failover

**Scenario:** Primary PostgreSQL node fails

**Detection:**
- Patroni REST API returns 503 for primary endpoint
- Application logs show connection errors
- Alert: `DatabaseDown` firing

**Automatic Recovery (Patroni):**
1. Patroni detects primary failure (5-10 seconds)
2. Promotes standby to primary automatically
3. Updates etcd with new primary endpoint
4. Applications reconnect to new primary

**Manual Verification:**
```bash
# Check cluster status
patronictl -c /etc/patroni.yml list

# Verify replication
psql -h <new-primary> -U postgres -c "SELECT * FROM pg_stat_replication;"

# Check application connectivity
curl http://payment-service:4001/health
```

**If Automatic Failover Fails:**
```bash
# Manual failover
patronictl -c /etc/patroni.yml failover --force

# Promote specific node
patronictl -c /etc/patroni.yml switchover --leader <current-leader> --candidate <new-leader>
```

**Post-Incident:**
1. Investigate root cause (disk full, OOM, network)
2. Restore original primary as standby
3. Update incident log
4. Post-mortem if applicable

---

### Runbook: Redis Queue Failover

**Scenario:** Redis Queues instance (6381) fails

**Detection:**
- BullMQ workers log connection errors
- Alert: `RedisDown` firing
- Bull Board UI shows disconnected

**Automatic Recovery (Sentinel):**
1. Sentinel detects failure (5 seconds)
2. Promotes replica to master
3. Workers reconnect automatically

**Manual Verification:**
```bash
# Check Sentinel status
redis-cli -p 26379 SENTINEL masters

# Verify new master
redis-cli -h <new-master> -p 6381 INFO replication

# Check queue health
redis-cli -h <new-master> -p 6381 LLEN bull:plan-bundle:waiting
```

**If Jobs Are Stuck:**
```bash
# List stuck jobs
redis-cli -h <master> -p 6381 KEYS "bull:*:active"

# Move stuck jobs back to waiting
redis-cli -h <master> -p 6381 LRANGE bull:plan-bundle:active 0 -1
# (Manually inspect and re-enqueue if needed)
```

---

### Runbook: Worker Node Failure

**Scenario:** Worker node becomes unresponsive

**Detection:**
- Node health check fails
- Workers not processing jobs (queue depth increasing)
- Alert: `QueueDepthGrowing` firing

**Recovery:**
```bash
# Check node status
ssh worker-node-1
systemctl status pm2-<user>

# If PM2 crashed, restart
pm2 resurrect
pm2 logs --err --lines 100

# If node is completely dead
# 1. Remove from load balancer (if applicable)
# 2. Provision new node
# 3. Deploy workers
# 4. Verify queue processing resumes
```

**Verify Job Processing:**
```bash
# Check BullMQ queue depths
redis-cli -p 6381 LLEN bull:plan-bundle:waiting
redis-cli -p 6381 LLEN bull:prepare-bundle:active

# Check worker logs
pm2 logs upload-workers --lines 50
```

---

### Runbook: Complete Outage (DR Scenario)

**Scenario:** Entire data center / region fails

**Detection:**
- All health checks failing
- Route 53 / DNS failover triggered (if multi-region)
- Multiple alerts firing

**Recovery Steps:**

**If Multi-Region (Level 3 HA):**
1. **Automatic:** Route 53 fails over to secondary region (60 seconds)
2. **Verify** secondary region is serving traffic
3. **Promote** Aurora read replica to primary (if not automatic)
4. **Monitor** queue processing in secondary region
5. **Communicate** to users via status page

**If Single Region (Level 1-2 HA):**
1. **Assess** damage (complete DC outage? Network partition?)
2. **Restore from backups**:
   ```bash
   # PostgreSQL
   pg_restore --dbname=payment_service <backup-file>

   # Redis (if not persistent)
   redis-cli --rdb /backup/dump.rdb

   # MinIO (restore from S3 backup)
   mc mirror s3-backup/raw-data-items minio/raw-data-items
   ```
3. **Start services** in this order:
   - PostgreSQL
   - Redis (cache + queues)
   - MinIO / S3
   - Payment Service
   - Upload Service
   - Workers
4. **Verify data integrity**:
   ```bash
   # Check payment balances
   psql -h localhost -U postgres payment_service -c "SELECT COUNT(*) FROM user;"

   # Check upload counts
   psql -h localhost -U postgres upload_service -c "SELECT COUNT(*) FROM new_data_item;"
   ```
5. **Resume operations**

**Post-Incident:**
- Full RCA (Root Cause Analysis)
- Update DR procedures
- Test restoration more frequently

---

## Conclusion

This High Availability and Disaster Recovery guide provides **three progressive levels** of HA deployment for the AR.IO Bundler:

1. **Level 1 (Basic HA)**: 99.9% availability, 10x cost, suitable for most production workloads
2. **Level 2 (Standard HA)**: 99.95% availability, 15x cost, suitable for business-critical workloads
3. **Level 3 (Geographic HA)**: 99.99% availability, 40x cost, suitable for mission-critical global workloads

**Recommended Approach:**
- Start with **Level 1** to gain operational experience
- Graduate to **Level 2** as revenue/criticality increases
- Implement **Level 3** only if downtime costs justify 40x infrastructure spend

**Key Success Factors:**
1. ✅ Define clear SLA requirements (RTO, RPO, availability)
2. ✅ Test failover scenarios regularly (quarterly DR drills)
3. ✅ Monitor everything (application + infrastructure metrics)
4. ✅ Document runbooks for common incidents
5. ✅ Train team on incident response procedures
6. ✅ Start simple, iterate to complexity

**Next Steps:**
1. Review this document with stakeholders
2. Define target SLA (which level of HA?)
3. Begin Phase 1 implementation (Basic HA)
4. Schedule quarterly DR drills
5. Measure and improve RTO/RPO over time

---

**Document Maintainers:** DevOps Team
**Review Frequency:** Quarterly
**Last Reviewed:** 2025-10-28
