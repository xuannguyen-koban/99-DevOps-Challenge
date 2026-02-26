const express = require("express");
const { Pool } = require("pg");
const Redis = require("ioredis");

const app = express();

// --- PostgreSQL connection pool -----------------------------------------
// Read all connection parameters from environment variables so nothing is
// hard-coded and the service can be reused across environments.
const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || "5432", 10),
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  database: process.env.DB_NAME || "postgres",
  // Keep the pool small relative to postgres max_connections (100).
  // With a single API replica this leaves room for admin/migration connections.
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error", err);
});

// --- Redis client ----------------------------------------------------------
const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
  // Retry strategy: attempt reconnection with capped backoff instead of
  // hammering the server or giving up immediately.
  retryStrategy(times) {
    const delay = Math.min(times * 100, 3000);
    return delay;
  },
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
});

redis.on("error", (err) => {
  console.error("Redis client error", err);
});

// --- Routes ----------------------------------------------------------------

app.get("/api/users", async (req, res) => {
  try {
    const db = await pool.connect();
    let result;
    try {
      result = await db.query("SELECT NOW()");
    } finally {
      // Always release the client back to the pool, even on query error.
      db.release();
    }

    await redis.set("last_call", Date.now());
    res.json({ ok: true, time: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/status", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    await redis.ping();
    res.json({ status: "ok" });
  } catch (err) {
    res.status(503).json({ status: "unhealthy", error: err.message });
  }
});

// --- Server startup & graceful shutdown ------------------------------------

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
