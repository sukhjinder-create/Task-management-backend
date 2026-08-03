import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import pool from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Phase 1 is additive and safe against a running deployment. Phase 2 drops the
// old columns and must wait until the new backend is live everywhere.
const CONTRACT = process.argv.includes("--contract");
const file = CONTRACT
  ? "migrations/20260804_multi_currency_billing_contract.sql"
  : "migrations/20260803b_multi_currency_billing.sql";

try {
  if (CONTRACT) {
    const { rows: drift } = await pool.query(
      `SELECT slug
         FROM billing_plans
        WHERE price_monthly_paise IS DISTINCT FROM price_monthly_minor
           OR price_yearly_paise  IS DISTINCT FROM price_yearly_minor`
    );
    if (drift.length) {
      console.error(
        "Refusing to contract: these plans have diverged between the old and new " +
        "price columns, so dropping the old ones would lose the value the " +
        "pre-deploy backend was serving:\n  " +
        drift.map((row) => row.slug).join(", ")
      );
      process.exit(1);
    }
    console.log("Old and new price columns agree on every plan.");
  }

  console.log(`Running ${CONTRACT ? "contract (phase 2)" : "expand (phase 1)"} migration...`);
  const sql = readFileSync(join(__dirname, file), "utf8");
  await pool.query(sql);
  console.log(`Applied ${file}`);

  const { rows } = await pool.query(
    `SELECT slug, base_currency, price_monthly_minor, price_yearly_minor,
            legacy_price_monthly_paise
       FROM billing_plans
      ORDER BY display_order`
  );

  console.log("\nPlans (values copied, never reinterpreted):");
  for (const row of rows) {
    console.log(
      `  - ${row.slug}: ${(row.base_currency || "usd").toUpperCase()} ` +
      `monthly_minor=${row.price_monthly_minor} yearly_minor=${row.price_yearly_minor} ` +
      `(snapshot=${row.legacy_price_monthly_paise})`
    );
  }

  if (!CONTRACT) {
    console.log(
      "\nOld *_paise columns are still live and trigger-synced, so the currently\n" +
      "deployed backend keeps working. Next:\n" +
      "  1. deploy the new backend\n" +
      "  2. node scripts/reprice-plans-usd.js          (dry run, then --apply)\n" +
      "  3. node run-multi-currency-billing-migration.js --contract"
    );
  }
} catch (err) {
  console.error("Multi-currency billing migration failed:", err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
