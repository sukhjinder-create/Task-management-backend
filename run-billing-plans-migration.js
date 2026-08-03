// run-billing-plans-migration.js
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import pool from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

console.log("Running billing_plans migration...");
try {
  const files = [
    "migrations/20260325_billing_plans.sql",
    "migrations/20260505_billing_plans_stripe.sql",
    "migrations/20260527_stripe_only_billing_cleanup.sql",
  ];

  for (const file of files) {
    const sql = readFileSync(join(__dirname, file), "utf8");
    await pool.query(sql);
    console.log(`Applied ${file}`);
  }

  console.log("Billing plans migration complete.");
  const { rows } = await pool.query(
    "SELECT name, slug, base_currency, price_monthly_minor FROM billing_plans ORDER BY display_order"
  );
  console.log("Plans seeded:");
  rows.forEach((row) => {
    console.log(`  - ${row.name} (${row.slug}) ${(row.base_currency || "usd").toUpperCase()} ${row.price_monthly_minor / 100}/mo`);
  });
} catch (err) {
  console.error("Migration failed:", err.message);
  process.exit(1);
} finally {
  await pool.end();
}
