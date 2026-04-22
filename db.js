// db.js
import pkg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool, types } = pkg;

// Prevent node-postgres from converting DATE columns to JS Date objects.
// Without this, "2026-03-26" becomes "2026-03-25T18:30:00.000Z" in IST (UTC+5:30),
// breaking date display and business-day calculations.
types.setTypeParser(1082, val => val); // 1082 = PostgreSQL DATE oid

const pool = new Pool({
  ...(process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
    : {
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        port: process.env.DB_PORT,
      }),

  // Production-grade pool — sized for high concurrency via a connection pooler
  // (Supabase PgBouncer sits in front, so the DB sees far fewer actual connections)
  max: 20,                             // max connections this process holds open
  min: 2,                              // keep 2 warm so first requests are instant
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
