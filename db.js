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
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,

  // ✅ CONNECTION REUSE SETTINGS
  max: 10,                             // max open connections
  idleTimeoutMillis: 60000,            // close idle clients after 60s
  connectionTimeoutMillis: 10000,      // wait up to 10s for a free connection
  keepAlive: true,                     // reuse TCP connection
  keepAliveInitialDelayMillis: 10000,  // send first keepalive after 10s of idle
});

// 🔐 PRODUCTION SAFETY: Prevent hard crashes
pool.on("error", (err) => {
  console.error("🔥 PostgreSQL Pool Error (connection lost):", err);
  // DO NOT exit process — pool will recover
});


export default pool;
