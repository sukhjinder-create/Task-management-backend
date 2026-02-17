// db.js
import pkg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pkg;

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,

  // ✅ CONNECTION REUSE SETTINGS
  max: 10,                    // max open connections
  idleTimeoutMillis: 30000,   // close idle clients after 30s
  connectionTimeoutMillis: 5000, // fail fast if DB slow
  keepAlive: true             // reuse TCP connection
});

// 🔐 PRODUCTION SAFETY: Prevent hard crashes
pool.on("error", (err) => {
  console.error("🔥 PostgreSQL Pool Error (connection lost):", err);
  // DO NOT exit process — pool will recover
});


export default pool;
