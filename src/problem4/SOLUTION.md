# Problem 4: Docker Compose Troubleshooting — Solution Report

## Problems Found

### Critical

**1. Port mismatch between Nginx and API (nginx/conf.d/default.conf:9)**

Nginx proxied `/api/` requests to `http://api:3001`, but the Express app listens on port `3000`. Every API request returned 502 Bad Gateway — the entire API was unreachable through the reverse proxy.

**2. No health checks on any service (docker-compose.yml)**

None of the four services defined a `healthcheck`. Docker could not distinguish a running container from a ready one, so restart policies and dependency ordering had no meaningful signal.

**3. `depends_on` did not wait for service readiness (docker-compose.yml)**

The API declared `depends_on: [postgres, redis]` using the default `service_started` condition, which only waits for the container process to be created — not for PostgreSQL or Redis to accept connections. The API started immediately, got ECONNREFUSED, and entered an error state.

### High

**4. Database connection leak on query error (api/src/index.js:19-21)**

`pool.connect()` returned a client, but `db.release()` was only called on the success path. If `db.query()` threw, the connection was permanently leaked. With a pool size of 10, just 10 failed queries deadlocked the application.

**5. No graceful shutdown (api/src/index.js)**

No `SIGTERM`/`SIGINT` handlers. Docker stopping the container dropped in-flight requests, left the PostgreSQL pool undrained, and abandoned the Redis connection. Repeated restarts compounded the connection leak.

**6. `max_connections = 20` in PostgreSQL (postgres/init.sql)**

The init script lowered the default 100 to 20. Combined with the connection leak, pool exhaustion was guaranteed. `ALTER SYSTEM` also requires a restart to take effect — so the setting only activated on the *next* container start, making the system degrade over time.

**7. No restart policies (docker-compose.yml)**

No `restart` policy on any service. Crashed containers stayed down until manual intervention.

### Medium

**8. No error event handler on Redis client (api/src/index.js)**

Unhandled `error` events on the `ioredis` client crashed the Node.js process.

**9. No error event handler on PostgreSQL pool (api/src/index.js)**

Same issue — `pg.Pool` emits `error` events for idle client errors. Without a listener, process crash.

**10. Hardcoded database credentials (api/src/index.js:9-11)**

Credentials (`postgres`/`postgres`) were hardcoded strings committed to source control.

**11. Shallow health check endpoint (api/src/index.js:31-33)**

`/status` always returned `{"status": "ok"}` even when DB and Redis were completely down.

**12. No persistent volume for PostgreSQL data (docker-compose.yml)**

No named volume for `/var/lib/postgresql/data`. All data lost on `docker compose down`.

### Low

**13. Missing proxy headers and timeouts (nginx/conf.d/default.conf)**

No `Host`, `X-Real-IP`, `X-Forwarded-For` headers forwarded. No `proxy_connect_timeout` or `proxy_read_timeout`.

**14. Dockerfile runs as root with no lockfile (api/Dockerfile)**

Container ran Node.js as `root`. No `package-lock.json` for deterministic builds.

**15. No container resource limits (docker-compose.yml)**

A memory leak in any service could OOM-kill the host and take down other containers.

**16. Redis had no memory limit or eviction policy (docker-compose.yml)**

Unbounded memory growth until the OOM-killer struck.

---

## How I Diagnosed Them

1. **Ran `docker compose up --build`** and observed the API was unreachable at `http://localhost:8080/api/users` — 502 errors from nginx.

2. **Checked nginx logs** — `connect() failed (111: Connection refused)` on port 3001. Then read `nginx/conf.d/default.conf` and `api/src/index.js` side by side — confirmed `proxy_pass` targeted port 3001 while Express listened on 3000.

3. **Inspected `docker-compose.yml`** — no `healthcheck` on any service, `depends_on` used bare service names (default `service_started`), no `restart` policies. This explained "sometimes inaccessible" — startup races between API and Postgres/Redis.

4. **Traced the `/api/users` handler in `api/src/index.js`** — `pool.connect()` on line 19, `db.release()` on line 21, but no `try/finally`. Any query error permanently leaked a connection from the pool.

5. **Read `postgres/init.sql`** — `ALTER SYSTEM SET max_connections = 20` combined with the pool leak was a guaranteed deadlock after a few errors.

6. **Reviewed Redis and Pool instantiation** — no `.on("error")` handlers (crashes on connection errors), no explicit pool sizing, no connection timeouts (requests hang forever when pool exhausted).

7. **Checked the Dockerfile** — no `USER` directive (runs as root), no lockfile (`npm install` is non-deterministic).

---

## Fixes Applied

### Fix 1 — Corrected nginx proxy port and added headers/timeouts

**File:** `nginx/conf.d/default.conf`

```diff
  location /api/ {
-     proxy_pass http://api:3001;
+     proxy_pass http://api:3000;
+     proxy_http_version 1.1;
+     proxy_set_header Host $host;
+     proxy_set_header X-Real-IP $remote_addr;
+     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
+     proxy_set_header X-Forwarded-Proto $scheme;
+     proxy_connect_timeout 5s;
+     proxy_read_timeout 30s;
  }
```

Also added a `/status` proxy block for the health check endpoint.

---

### Fix 2 — Added health checks, depends_on conditions, restart policies, resource limits, and volumes

**File:** `docker-compose.yml`

```yaml
services:
  nginx:
    image: nginx:1.25
    ports:
      - "8080:80"
    volumes:
      - ./nginx/conf.d:/etc/nginx/conf.d
    depends_on:
      api:
        condition: service_healthy       # waits for API health check
    restart: unless-stopped

  api:
    build: ./api
    environment:
      - DB_HOST=postgres
      - DB_PORT=5432
      - DB_USER=postgres
      - DB_PASSWORD=postgres
      - DB_NAME=postgres
      - REDIS_HOST=redis
      - REDIS_PORT=6379
    depends_on:
      postgres:
        condition: service_healthy       # waits for pg_isready
      redis:
        condition: service_healthy       # waits for redis-cli ping
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:3000/status',(r)=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s
    restart: unless-stopped
    deploy:
      resources:
        limits:
          cpus: "0.50"
          memory: 256M

  postgres:
    image: postgres:15
    command: ["postgres", "-c", "max_connections=100"]
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_USER: postgres
      POSTGRES_DB: postgres
    volumes:
      - ./postgres/init.sql:/docker-entrypoint-initdb.d/init.sql   # mounts init script
      - postgres_data:/var/lib/postgresql/data                      # persistent storage
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d postgres"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s
    restart: unless-stopped
    deploy:
      resources:
        limits:
          cpus: "0.50"
          memory: 256M

  redis:
    image: redis:7
    command: redis-server --maxmemory 128mb --maxmemory-policy allkeys-lru
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 5s
    restart: unless-stopped
    deploy:
      resources:
        limits:
          cpus: "0.25"
          memory: 192M

volumes:
  postgres_data:
```

---

### Fix 3 — Rewrote api/src/index.js — connection leak, error handlers, env vars, real health check, graceful shutdown

**File:** `api/src/index.js`

```js
const express = require("express");
const { Pool } = require("pg");
const Redis = require("ioredis");

const app = express();

// PostgreSQL — all config from env vars, explicit pool limits
const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || "5432", 10),
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  database: process.env.DB_NAME || "postgres",
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error", err);
});

// Redis — capped retry backoff, per-request retry limit
const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
  retryStrategy(times) {
    return Math.min(times * 100, 3000);
  },
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
});

redis.on("error", (err) => {
  console.error("Redis client error", err);
});

// --- Routes ---

app.get("/api/users", async (req, res) => {
  try {
    const db = await pool.connect();
    let result;
    try {
      result = await db.query("SELECT NOW()");
    } finally {
      db.release();  // ALWAYS release, even on query error
    }
    await redis.set("last_call", Date.now());
    res.json({ ok: true, time: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Real health check — verifies DB and Redis connectivity
app.get("/status", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    await redis.ping();
    res.json({ status: "ok" });
  } catch (err) {
    res.status(503).json({ status: "unhealthy", error: err.message });
  }
});

// --- Graceful shutdown (handles both SIGTERM and SIGINT) ---

const PORT = parseInt(process.env.PORT || "3000", 10);
const server = app.listen(PORT, () => console.log(`API running on ${PORT}`));

const shutdown = () => {
  console.log("Shutdown signal received, closing gracefully");
  server.close(async () => {
    await pool.end();
    redis.disconnect();
    process.exit(0);
  });
  // Force exit if graceful shutdown hangs (e.g. keep-alive connections)
  setTimeout(() => {
    console.error("Forced shutdown after 10s timeout");
    process.exit(1);
  }, 10000).unref();
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

Key changes:
- `db.release()` moved into `finally` block — no more connection leaks
- `pool.on("error")` and `redis.on("error")` — prevents unhandled crashes
- `/status` now checks both DB and Redis — returns 503 if unhealthy
- Both `SIGTERM` and `SIGINT` handled — works with `docker compose down` and Ctrl+C
- 10-second forced exit timeout prevents shutdown from hanging indefinitely
- All credentials read from environment variables

---

### Fix 4 — Fixed max_connections configuration

**File:** `postgres/init.sql` and `docker-compose.yml`

The original `ALTER SYSTEM SET max_connections = 20` had two problems:
1. The value was dangerously low (20).
2. `max_connections` requires a full server **restart**, not just `pg_reload_conf()` — so the setting was a no-op until the next container start.

Instead of using `ALTER SYSTEM` in init.sql, `max_connections` is now set via the Postgres command line in docker-compose.yml, which takes effect immediately on first startup:

```diff
  # docker-compose.yml
  postgres:
    image: postgres:15
+   command: ["postgres", "-c", "max_connections=100"]
```

```diff
  # postgres/init.sql
- ALTER SYSTEM SET max_connections = 20;
+ -- max_connections is set via the postgres command line in docker-compose.yml
+ -- Place any additional database initialization below.
```

---

### Fix 5 — Hardened Dockerfile with deterministic builds

**File:** `api/Dockerfile`

```diff
  FROM node:20-alpine
  WORKDIR /app
- COPY package.json ./
- RUN npm install
+ COPY package.json package-lock.json ./
+ RUN npm ci --omit=dev
  COPY src ./src
+ USER node
  CMD ["node", "src/index.js"]
```

Changes:
- `package-lock.json` generated and committed for deterministic dependency resolution.
- `npm ci` replaces `npm install` — uses the lockfile exactly, fails if lockfile is out of sync.
- `--omit=dev` skips dev dependencies in the production image.
- `USER node` runs the process as non-root.

---

### Fix 6 — API health check uses `node` instead of `wget`

**File:** `docker-compose.yml`

The original health check used `wget`, which may not be available in all `node:20-alpine` variants. Replaced with a `node -e` one-liner that is guaranteed to exist:

```diff
  healthcheck:
-   test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:3000/status"]
+   test: ["CMD", "node", "-e", "require('http').get('http://localhost:3000/status',(r)=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"]
```

---

### Fix 7 — Removed empty nginx.conf

**File:** `nginx/nginx.conf` (deleted)

The file existed but was empty and was not mounted in docker-compose.yml. It was misleading — if someone mounted it as the main nginx config, nginx would fail to start. Removed to avoid confusion.

---

## Monitoring and Alerts to Add

| What to Monitor | Tool | Alert Condition |
|-----------------|------|-----------------|
| API 5xx error rate | Prometheus + Grafana | > 1% over 5 minutes |
| API p99 response time | Prometheus + Grafana | > 200ms |
| PostgreSQL active connections | `pg_stat_activity` exporter | > 80% of `max_connections` |
| Pool `waitingCount` | Custom `/metrics` endpoint | > 0 for 30+ seconds |
| Redis memory usage | `redis_info` exporter | > 80% of `maxmemory` |
| Redis evictions | `redis_info` exporter | Any eviction triggers alert |
| Container restarts | Docker events / cAdvisor | Any unexpected restart |
| PostgreSQL slow queries | `log_min_duration_statement = 500ms` | Any slow query logged |
| Disk usage (postgres volume) | Node exporter | > 80% capacity |

**Recommended stack**: Prometheus (metrics collection) + Grafana (dashboards + alerting) + Loki or ELK (log aggregation). For a small platform, CloudWatch with custom metrics is a lighter alternative.

---

## How to Prevent This in Production

1. **CI smoke test** — After `docker compose up --build`, run automated `curl` checks against every endpoint and assert expected status codes. This catches port mismatches, startup races, and config errors before merge.

2. **Compose linting in CI** — Use `docker compose config --quiet` plus a policy tool (conftest/OPA) to enforce that every service defines a `healthcheck`, `restart` policy, and resource limits.

3. **Load testing before release** — Run `k6` or `wrk` against a staging environment for 5 minutes at expected RPS. Connection leaks and pool exhaustion surface under sustained load.

4. **Structured logging + centralized aggregation** — Replace `console.error` with a structured logger (`pino`). Ship logs to CloudWatch Logs, Loki, or Datadog. Alert on error rate spikes and latency regressions.

5. **Secrets management** — Move credentials from `docker-compose.yml` environment variables to Docker Secrets, HashiCorp Vault, or AWS Secrets Manager. Never commit plaintext passwords to version control.

6. **Pin image digests** — Use `postgres:15@sha256:abc...` instead of mutable tags. Prevents upstream image updates from introducing unexpected behavior.

7. **Container security scanning** — Run Trivy or Snyk in CI to detect CVEs in base images and dependencies before deployment.

8. **Infrastructure as Code review** — Require peer review for all `docker-compose.yml` and Dockerfile changes, same as application code. Config bugs are just as impactful as code bugs.
