# Problem 2: Highly Available Trading System Architecture

## Constraints

- **Throughput**: 500 requests per second
- **Response Time**: p99 < 100ms
- **Priorities**: Cost efficiency, security, high availability

## Core Features Selected

| Feature                    | Description                                                       |
|----------------------------|-------------------------------------------------------------------|
| Order Matching Engine      | Limit/market order book with price-time priority                  |
| Real-Time Market Data      | Live order book depth and trade feed via WebSocket                |
| User Authentication        | JWT-based auth with MFA (TOTP)                                    |
| Wallet Management          | Internal ledger with deposit/withdrawal                           |
| Trading REST + WebSocket API | Order placement, cancellation, account queries                  |
| Rate Limiting & Audit Trail | Per-user throttling, immutable compliance logs                   |

---

## Architecture Diagram

```
                    ┌────────────────────────────────────────────────────┐
                    │                  EDGE LAYER                        │
                    │                                                    │
    Users/Apps ────►│  Route 53 (DNS failover)  ──►  CloudFront (TLS)  │
                    │                                      │            │
                    └──────────────────────────────────────┼────────────┘
                                                           │
                    ┌──────────────────────────────────────▼────────────┐
                    │            AWS WAF (OWASP rules, rate limiting)   │
                    └──────────────────────────────────────┬────────────┘
                                                           │
         ┌─────────────────────────────────────────────────▼──────────────────┐
         │              PUBLIC SUBNET — Load Balancer                          │
         │                                                                     │
         │     Application Load Balancer (ALB)                                │
         │     - /api/*  → ECS Trading API                                    │
         │     - /ws/*   → ECS WebSocket Service                              │
         │     - /auth/* → ECS Auth Service                                   │
         └──────────────────────────┬──────────────────────────────────────────┘
                                    │
         ┌──────────────────────────▼──────────────────────────────────────────┐
         │           PRIVATE SUBNET — Application Tier (ECS Fargate)           │
         │                                                                      │
         │   ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐    │
         │   │ Auth Service │  │ Trading API  │  │ WebSocket Gateway     │    │
         │   │ (JWT + TOTP) │  │ (REST)       │  │ (market data push)    │    │
         │   └──────┬───────┘  └──────┬───────┘  └───────────┬───────────┘    │
         │          │                 │                       │                │
         │   ┌──────▼─────────────────▼───────────────────────▼──────────┐    │
         │   │         Order Matching Engine (Node.js/Go)                │    │
         │   │         In-memory order book per trading pair             │    │
         │   │         Event-sourced via SQS for recovery               │    │
         │   └──────────────────────────┬────────────────────────────────┘    │
         │                              │                                     │
         │   ┌──────────────┐  ┌────────▼────────┐  ┌────────────────────┐   │
         │   │ Wallet       │  │ Settlement      │  │ Notification       │   │
         │   │ Service      │  │ Service         │  │ Service (SES/SNS)  │   │
         │   └──────────────┘  └─────────────────┘  └────────────────────┘   │
         └────────────────────────────┬───────────────────────────────────────┘
                                      │
         ┌────────────────────────────▼───────────────────────────────────────┐
         │                    DATA TIER (PRIVATE SUBNET)                      │
         │                                                                    │
         │  ┌─────────────────────┐  ┌─────────────────────────────────┐     │
         │  │ RDS PostgreSQL      │  │ ElastiCache Redis               │     │
         │  │ Multi-AZ            │  │ (session, order book cache,     │     │
         │  │ (orders, trades,    │  │  rate limit counters)           │     │
         │  │  accounts, ledger)  │  └─────────────────────────────────┘     │
         │  └─────────────────────┘                                          │
         │                                                                    │
         │  ┌─────────────────────┐  ┌─────────────────────────────────┐     │
         │  │ Amazon SQS          │  │ S3                              │     │
         │  │ (order events,      │  │ (audit logs, trade archives,   │     │
         │  │  settlement queue)  │  │  compliance records)           │     │
         │  └─────────────────────┘  └─────────────────────────────────┘     │
         └────────────────────────────────────────────────────────────────────┘
                                      │
         ┌────────────────────────────▼───────────────────────────────────────┐
         │                  SECURITY & OBSERVABILITY                          │
         │                                                                    │
         │  AWS KMS (encryption)  │  Secrets Manager  │  GuardDuty           │
         │  CloudTrail (audit)    │  CloudWatch (metrics, alarms, logs)      │
         │  AWS Config            │  X-Ray (tracing)                         │
         └────────────────────────────────────────────────────────────────────┘
```

---

## Why Each Service — and Alternatives Considered

### 0. implement aws landing zone and organization 
**Why**: More Security and AWS Best Practice

### 1. DNS — Amazon Route 53

**Role**: DNS with health-check-based failover.

**Why**: Native ALB/CloudFront integration, sub-minute failover via health checks. At 500 RPS, no need for GeoDNS or latency routing — single-region is sufficient.

**Alternative**: Cloudflare DNS — excellent free tier, but adds external dependency that complicates IAM audit trails.

---

### 2. CDN & TLS — Amazon CloudFront

**Role**: TLS termination at edge, cache static assets (trading UI), and absorb DDoS at the edge layer.

**Why**: At 500 RPS, CloudFront offloads ~80% of static asset requests from the ALB. Free TLS certificates via ACM. Shield Standard (free) provides baseline DDoS protection.

**Alternative**: Direct ALB exposure — saves CloudFront cost (~$10-20/month at this scale) but loses edge caching and DDoS absorption. Not worth the tradeoff.

---

### 3. WAF — AWS WAF

**Role**: OWASP Top 10 protection (SQLi, XSS), per-IP rate limiting, bot filtering.

**Why**: Managed rule groups are updated by AWS without deployment changes. Custom rules handle trading-specific abuse (order stuffing, credential stuffing). At 500 RPS, AWS WAF cost is ~$10-15/month.

**Alternative**: Shield Advanced ($3,000/month) — massively over-budget for 500 RPS. Standard Shield (free) + WAF is the right tier.

**Not using**: nginx-based WAF (ModSecurity) — operational overhead of rule management not justified.

---

### 4. Compute — ECS Fargate

**Role**: Run all microservices as serverless containers. No EC2 instances to patch, size, or manage.

**Why this is the cost-optimal choice at 500 RPS**:
- 500 RPS across 6 services ≈ ~83 RPS/service average.
- Each service runs comfortably on 2 Fargate tasks (0.5 vCPU, 1 GB RAM each) across 2 AZs.
- Total compute: ~6 vCPU, ~12 GB RAM = **~$150-200/month** with Fargate Spot for non-critical services.
- Zero operational overhead: no AMI patching, no instance right-sizing, no ASG tuning.

**Alternative considered**:
- **EKS**: Kubernetes overhead (control plane $73/month + node costs) is not justified at this scale. ECS Fargate is simpler and cheaper for < 20 services.
- **EC2 instances**: Cheaper per-unit compute, but AMI management, patching, and capacity planning add ops burden with no budget for a dedicated SRE team.
- **Lambda**: Viable for some endpoints but cold starts violate the p99 < 100ms requirement for trading operations.

---

### 5. Database — RDS PostgreSQL Multi-AZ

**Role**: Source of truth for orders, trades, user accounts, and the balance ledger. ACID transactions are non-negotiable for financial data.

**Why RDS PostgreSQL over Aurora**:
- At 500 RPS, a single `db.r6g.large` (Graviton, 2 vCPU, 16 GB) handles the load comfortably.
- RDS Multi-AZ provides automatic failover (< 60 seconds) with synchronous replication.
- **Cost: ~$200/month** vs. Aurora minimum of ~$400/month. Aurora's auto-scaling storage and 15 read replicas are unnecessary at this scale.

**Schema design**:
- `orders` table: partitioned monthly by `created_at` for efficient range queries and cleanup.
- Balance ledger: append-only event log pattern — every debit/credit is an immutable row. Current balances derived via materialized view, preventing negative balances without a compensating record.
- Connection pooling: PgBouncer sidecar in each Fargate task (transaction-mode) keeps connection count low.

**Alternative considered**:
- **Aurora PostgreSQL**: Better at 5,000+ RPS with read replicas. Over-provisioned and more expensive at 500 RPS.
- **DynamoDB**: Excellent for key-value patterns, but the trading ledger requires multi-table transactions and complex joins that DynamoDB handles poorly.

---

### 6. Cache — ElastiCache Redis (Single Node + Replica)

**Role**: Session tokens, order book cache (top 20 levels), rate limit counters, ticker data.

**Why**: Redis provides the data structures needed — sorted sets for order book sides, INCR+EXPIREAT for rate limiting, simple GET/SET for sessions. Sub-millisecond latency for cached reads keeps p99 well under 100ms.

**Configuration**: `cache.r6g.medium` (1 primary + 1 replica in different AZ). **Cost: ~$90/month**.

**Alternative considered**:
- **DynamoDB DAX**: Adds caching to DynamoDB but we're using PostgreSQL as primary store.
- **Memcached**: Lacks sorted sets and pub/sub needed for order book and rate limiting.
- **Application-level caching**: No shared state across Fargate tasks; Redis provides this.

---

### 7. Message Queue — Amazon SQS

**Role**: Asynchronous event processing — order events to settlement, trade notifications, audit log writing.

**Why SQS over Kafka (MSK)**:
- At 500 RPS, MSK's minimum 3-broker cluster (~$500-700/month) is massively over-provisioned.
- SQS handles the message volume for **< $5/month** (first 1M requests/month free).
- SQS FIFO queues provide exactly-once processing and message ordering per group ID — sufficient for settlement ordering per trading pair.
- Zero operational overhead: no brokers, no partitions, no consumer group management.

**Alternative considered**:
- **MSK (Kafka)**: Superior for event sourcing and replay at scale (10,000+ RPS). At 500 RPS, the operational and cost overhead is 100x the SQS cost with no practical benefit.
- **SNS + SQS fan-out**: Used for multi-consumer patterns (one trade event → settlement + notification + audit). SNS publishes once, SQS queues per consumer.

---

### 8. Object Storage — Amazon S3

**Role**: Audit logs, trade archives (exported from RDS monthly), compliance records.

**Lifecycle policy**:
```
Day 0-30:    S3 Standard           (recent audit access)
Day 31-365:  S3 Standard-IA        (infrequent compliance queries)
Day 366+:    S3 Glacier Instant    (regulatory retention, 7 years)
```

**S3 Object Lock (Compliance mode)**: Audit logs are immutable once written — cannot be deleted by any principal including root. Satisfies financial audit requirements.

**Cost: ~$5-15/month** at this data volume.

---

## Networking and Security Design

### VPC Layout

```
VPC CIDR: 10.0.0.0/16 (single region: ap-southeast-1)

  Public Subnets (ALB, NAT Gateway):
    10.0.0.0/24 — AZ-a
    10.0.1.0/24 — AZ-b

  Private Subnets — Application (Fargate tasks):
    10.0.10.0/24 — AZ-a
    10.0.11.0/24 — AZ-b

  Private Subnets — Data (RDS, ElastiCache):
    10.0.20.0/24 — AZ-a
    10.0.21.0/24 — AZ-b

  Routing:
    Public subnets  → Internet Gateway
    Private subnets → NAT Gateway (single NAT in AZ-a, acceptable at this scale)
    VPC Endpoints for S3, ECR, CloudWatch Logs, Secrets Manager, KMS
      → eliminates NAT data processing fees for AWS service traffic
```

### Security Controls

**Encryption at rest**: All RDS, ElastiCache, S3, and SQS encrypted with AWS KMS Customer Managed Keys (CMK). Automatic annual key rotation enabled.

**Encryption in transit**: TLS 1.3 everywhere — CloudFront → ALB, ALB → Fargate, Fargate → RDS/Redis. Internal service-to-service calls use TLS via ALB internal listener.

**Secrets Management**: All database credentials, API keys, and third-party tokens stored in AWS Secrets Manager with automatic rotation via Lambda. Zero secrets in environment variables, container images, or code.

**IAM — least privilege**:
- Each ECS task has a dedicated IAM Task Role scoped to only the AWS resources it needs.
- Trading API: read/write RDS, read/write Redis, publish to SQS.
- Auth Service: read/write RDS, read/write Redis, read Secrets Manager.
- Settlement Service: read/write RDS, consume SQS, publish to SNS.
- No task has broad `*` permissions.

**Network segmentation**:
- Security groups enforce strict ingress rules: ALB → Fargate tasks (app ports only), Fargate → RDS (5432), Fargate → Redis (6379).
- Data subnet has no internet route — RDS and Redis are unreachable from the internet.
- VPC Flow Logs enabled to S3 for forensic analysis.

**Authentication security**:
- Passwords hashed with bcrypt (cost factor 12).
- JWT access tokens: 15-minute TTL, RS256 signed.
- Refresh tokens: 7-day TTL, stored as HttpOnly Secure SameSite cookies.
- TOTP MFA enforced for withdrawals and API key creation.
- Session blocklist in Redis: on logout or suspicious activity, token hash is blocklisted for remaining TTL.
- Per-user rate limiting at WAF layer (100 requests/minute per IP, 10 login attempts/minute).

**Compliance monitoring**:
- AWS CloudTrail: all API calls logged to S3 with Object Lock.
- AWS Config: continuous evaluation against CIS Benchmark rules.
- GuardDuty: threat detection for anomalous API calls, compromised credentials.
- CloudWatch alarms on failed authentication spikes.

---

## Observability

### Metrics — CloudWatch

Custom metrics emitted from each service:

| Metric                            | Alert Threshold        |
|-----------------------------------|------------------------|
| `order_placement_latency_p99_ms`  | Page at > 80ms         |
| `orders_per_second`               | Alert at > 400 (80%)   |
| `rds_cpu_utilization`             | Alert at > 70%         |
| `redis_memory_utilization`        | Alert at > 70%         |
| `sqs_queue_depth_settlement`      | Alert at > 500 msgs    |
| `failed_login_attempts_per_min`   | Alert at > 100         |
| `5xx_error_rate`                  | Alert at > 1%          |

### Logs — CloudWatch Logs

All services emit structured JSON logs. Log groups per service with 30-day retention. Metric filters extract error rates and latency percentiles directly from logs.

### Traces — AWS X-Ray

End-to-end request tracing: ALB → Auth → Trading API → OME → SQS → Settlement. P99 latency breakdown per segment surfaces bottlenecks before they breach the 100ms SLO.

**SLO targets**:

| Service             | Availability | P99 Latency |
|---------------------|-------------|-------------|
| Order placement API | 99.95%       | < 100ms     |
| Order matching      | 99.95%       | < 10ms      |
| Market data WS      | 99.9%        | < 50ms      |
| Authentication      | 99.95%       | < 150ms     |

---

## High Availability

### Multi-AZ Design (2 AZs)

At 500 RPS, 2 AZs provide sufficient redundancy without the cost of a third:

- **ECS Fargate**: 2 tasks per service, one in each AZ. ALB health checks drain unhealthy tasks in < 30 seconds.
- **RDS PostgreSQL Multi-AZ**: Synchronous standby in AZ-b. Automatic failover in < 60 seconds. Zero data loss.
- **ElastiCache Redis**: Primary in AZ-a, replica in AZ-b. Automatic failover in ~60 seconds.
- **SQS**: Inherently multi-AZ, messages replicated across AZs automatically.
- **S3**: Inherently multi-AZ (99.999999999% durability).

### Disaster Recovery

At this scale, a full cross-region DR setup is cost-prohibitive. Instead:

- **RDS automated backups**: Continuous, point-in-time recovery to any second within 35-day retention window. Cross-region backup copy enabled (daily).
- **S3 Cross-Region Replication**: Audit logs and trade archives replicated to us-east-1 for compliance.
- **Infrastructure as Code (Terraform)**: Full stack reproducible in a new region within 1 hour if needed.

**RPO**: < 5 minutes (RDS point-in-time recovery). **RTO**: < 1 hour (Terraform redeploy + RDS restore).

---

## Estimated Monthly Cost

| Component                                | Monthly Cost      |
|------------------------------------------|-------------------|
| ECS Fargate (6 services, 2 tasks each)   | $150 - $200       |
| RDS PostgreSQL Multi-AZ (db.r6g.large)   | $200 - $250       |
| ElastiCache Redis (cache.r6g.medium, 1+1)| $80 - $100        |
| ALB                                      | $20 - $30         |
| CloudFront + WAF                         | $20 - $40         |
| Route 53                                 | $5 - $10          |
| SQS + SNS                               | $5 - $10          |
| S3 (storage + requests)                  | $5 - $15          |
| Secrets Manager                          | $5 - $10          |
| CloudWatch + X-Ray                       | $30 - $50         |
| NAT Gateway (1 AZ)                       | $35 - $50         |
| KMS                                      | $5 - $10          |
| **Total**                                | **$560 - $775**   |

With Fargate Spot for non-critical services (notification, audit writer) and Compute Savings Plan (1-year), total can drop to **~$450-600/month**.

---

## Scaling Plan

### Current: 500 RPS (Phase 1)

The architecture described above. Single region, 2 AZs, ECS Fargate, RDS single writer, Redis single shard. Total cost: ~$500-750/month.

### Phase 2: 2,000 - 5,000 RPS

**Triggered by**: RDS CPU > 70% sustained, p99 > 80ms, or SQS queue depth growing.

- Add RDS read replica (dedicate reads for portfolio/history queries).
- Scale Fargate tasks from 2 → 4 per service.
- Upgrade Redis to Cluster Mode (2 shards) for more memory and throughput.
- Add second NAT Gateway (one per AZ) for resilience.
- Consider migrating from SQS to MSK Kafka if event replay/sourcing becomes a requirement.
- Estimated cost: $1,500 - $2,500/month.

### Phase 3: 5,000 - 50,000 RPS

- Migrate to **EKS** (Kubernetes overhead now justified by service count and scaling complexity).
- **Aurora PostgreSQL** replaces RDS (auto-scaling storage, up to 15 read replicas).
- **MSK Kafka** replaces SQS (event sourcing, multi-consumer fan-out, replay capability).
- Add 3rd AZ for full multi-AZ resilience.
- Add cross-region DR with Aurora Global Database.
- Dedicated OME in Go/Rust on EC2 (CPU-pinned, Graviton) for matching latency.
- Estimated cost: $5,000 - $15,000/month.

### Phase 4: 50,000+ RPS

- Multi-region active-active deployment.
- OME sharding by trading pair on bare-metal instances.
- CockroachDB or Vitess for horizontally-scalable writes.
- Dedicated Kafka Streams/Flink for real-time aggregation.
- Estimated cost: $20,000+/month.

---

## Summary

| Requirement       | How It Is Met                                                                                   |
|-------------------|-------------------------------------------------------------------------------------------------|
| 500 RPS           | ECS Fargate (2 tasks/service) + ALB path routing, horizontally scalable                         |
| p99 < 100ms       | Redis cache for hot reads, PgBouncer connection pooling, X-Ray tracing for bottleneck detection |
| High Availability | Multi-AZ (2 AZ) for all components, RDS Multi-AZ failover, Redis replica, ALB health checks    |
| Cost Efficiency   | Fargate (no EC2 overhead), RDS over Aurora, SQS over Kafka, single NAT, ~$500-750/month total  |
| Security          | KMS encryption at rest, TLS 1.3 in transit, Secrets Manager rotation, WAF, least-privilege IAM, VPC segmentation, GuardDuty, CloudTrail with Object Lock, TOTP MFA, JWT blocklist |
