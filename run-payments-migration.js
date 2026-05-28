import fs from "fs";
import pool from "./db.js";

async function runMigration() {
  try {
    console.log("Running payments migration...");

    const files = [
      "./migrations/20260325_workspace_payments.sql",
      "./migrations/20260325_billing_plans.sql",
      "./migrations/20260326_user_billing_status.sql",
      "./migrations/20260505_billing_plans_stripe.sql",
      "./migrations/20260527_stripe_only_billing_cleanup.sql",
      "./migrations/20260528_stripe_subscription_seats.sql",
    ];

    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      const sql = fs.readFileSync(file, "utf8");
      await pool.query(sql);
      console.log(`Applied ${file}`);
    }

    const { rows: subscriptionCols } = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'workspace_subscriptions'
      ORDER BY ordinal_position
    `);

    const { rows: checkoutCols } = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'payment_checkout_sessions'
      ORDER BY ordinal_position
    `);

    console.log("Payments migration complete.");
    console.log(`workspace_subscriptions columns: ${subscriptionCols.length}`);
    console.log(`payment_checkout_sessions columns: ${checkoutCols.length}`);
  } catch (error) {
    console.error("Payments migration failed:", error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runMigration();
