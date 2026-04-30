import pg from "pg";
import { readFileSync } from "fs";

const pool = new pg.Pool({
  connectionString: "postgresql://postgres.jygpfnpdphbnmysnyyww:3kmXdeMIviYZFWyQ@aws-0-ap-south-1.pooler.supabase.com:5432/postgres",
  ssl: { rejectUnauthorized: false },
});

const sql = readFileSync("./migrations/20260430_enable_rls_all_tables.sql", "utf8");
try {
  await pool.query(sql);
  console.log("✅ RLS enabled on all tables successfully.");
} catch (err) {
  console.error("❌ Migration failed:", err.message);
}
await pool.end();
