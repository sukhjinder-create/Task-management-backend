// db.js
import {
  assertApplicationDatabaseSafety,
  assertDatabaseScriptSafetyIfNeeded,
} from "./utils/databaseSafety.js";
import pkg from "pg";
import dotenv from "dotenv";

assertDatabaseScriptSafetyIfNeeded();
dotenv.config();
assertApplicationDatabaseSafety();

const { Pool, types } = pkg;
const DATABASE_URL = process.env.DATABASE_URL?.trim();
const DB_SSL_VALUE = String(process.env.DB_SSL || "").trim().toLowerCase();
const DB_SSL_IS_EXPLICIT = DB_SSL_VALUE !== "";

function databaseUrlIsLocal(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ["localhost", "127.0.0.1", "::1"].includes(host) || host.endsWith(".local");
  } catch {
    return false;
  }
}

const DB_SSL_ENABLED = DB_SSL_IS_EXPLICIT
  ? ["true", "1", "require"].includes(DB_SSL_VALUE)
  : Boolean(DATABASE_URL && !databaseUrlIsLocal(DATABASE_URL));
const sslOptions = DB_SSL_ENABLED ? { ssl: { rejectUnauthorized: false } } : {};

// Prevent node-postgres from converting DATE columns to JS Date objects.
// Without this, "2026-03-26" becomes "2026-03-25T18:30:00.000Z" in IST (UTC+5:30),
// breaking date display and business-day calculations.
types.setTypeParser(1082, val => val); // 1082 = PostgreSQL DATE oid

const pool = new Pool({
  ...(DATABASE_URL
    ? { connectionString: DATABASE_URL, ...sslOptions }
    : {
        host: process.env.DB_HOST?.trim(),
        user: process.env.DB_USER?.trim(),
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME?.trim(),
        port: process.env.DB_PORT?.trim(),
        ...sslOptions,
      }),

  // Production-grade pool — sized for high concurrency via a connection pooler
  // (Supabase's transaction-mode pooler sits in front, so the DB sees far fewer
  // actual connections). This process runs as a single self-hosted instance
  // rather than many small Cloud Run instances sharing an aggregate connection
  // budget, so its own pool is the entire app's DB concurrency ceiling — sized
  // up accordingly (verified comfortable up to 150 concurrent DB-touching
  // requests against the transaction-mode pooler in load testing).
  max: 60,                             // max connections this process holds open
  min: 5,                              // keep 5 warm so first requests are instant
  idleTimeoutMillis: 30000,            // release idle connections after 30s
  connectionTimeoutMillis: 8000,       // fail fast if pool is exhausted (don't queue forever)
  allowExitOnIdle: false,              // keep pool alive for long-running servers
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

// 🔐 PRODUCTION SAFETY: Prevent hard crashes on idle pool clients
pool.on("error", (err) => {
  console.error("🔥 PostgreSQL Pool Error (connection lost):", err);
  // DO NOT exit process — pool will recover
});

// Attach error handler to ALL clients at creation time (idle + checked-out).
// pool.on("error") only covers idle clients; a checked-out client whose TCP
// connection drops will emit "error" with no listener → Node throws → crash.
pool.on("connect", (client) => {
  client.on("error", (err) => {
    console.error("🔥 pg Client error:", err.message);
    // Pool will discard and replace this connection on the next request
  });
});

// Detect errors caused by a stale/dropped TCP connection so we can retry.
function isStaleConnectionError(err) {
  const msg = err?.message || "";
  return (
    msg.includes("Connection terminated") ||
    msg.includes("connection is not open") ||
    msg.includes("Client was closed") ||
    msg.includes("read ECONNRESET") ||
    err?.code === "57P01" // PostgreSQL admin shutdown
  );
}

// Patch pool.query with a single transparent retry on stale-connection errors.
// NAT/firewall devices silently kill idle TCP connections; when pg-pool hands
// out one of these dead connections the first query fails. One retry always
// gets a fresh connection, so callers never need to handle this themselves.
const _query = pool.query.bind(pool);
pool.query = async (...args) => {
  try {
    return await _query(...args);
  } catch (err) {
    if (isStaleConnectionError(err)) {
      console.warn("🔄 pg: stale connection detected, retrying query...");
      return await _query(...args);
    }
    throw err;
  }
};

export default pool;
