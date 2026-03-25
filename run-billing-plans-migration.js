// run-billing-plans-migration.js
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import pool from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, "migrations/20260325_billing_plans.sql"), "utf8");

console.log("Running billing_plans migration...");
try {
  await pool.query(sql);
  console.log("✅ billing_plans migration complete.");
  const { rows } = await pool.query("SELECT name, slug, price_monthly_paise FROM billing_plans ORDER BY display_order");
  console.log("Plans seeded:");
  rows.forEach(r => console.log(`  • ${r.name} (${r.slug}) — ₹${r.price_monthly_paise / 100}/mo`));
} catch (err) {
  console.error("❌ Migration failed:", err.message);
  process.exit(1);
} finally {
  await pool.end();
}
