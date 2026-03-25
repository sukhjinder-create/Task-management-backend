import fs from "fs";
import pool from "./db.js";

async function runMigration() {
  try {
    console.log("Running payments migration...");

    const sql = fs.readFileSync(
      "./migrations/20260325_workspace_payments.sql",
      "utf8"
    );

    await pool.query(sql);

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
