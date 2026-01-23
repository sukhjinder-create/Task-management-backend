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
});

// 🔐 PRODUCTION SAFETY: Prevent hard crashes
pool.on("error", (err) => {
  console.error("🔥 PostgreSQL Pool Error (connection lost):", err);
  // DO NOT exit process — pool will recover
});


export default pool;
