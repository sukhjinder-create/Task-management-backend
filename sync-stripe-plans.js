import "dotenv/config";
import pool from "./db.js";
import { listPlans } from "./repositories/billingPlans.repository.js";
import { syncPlanToStripe } from "./services/payments.service.js";

async function main() {
  const plans = await listPlans({ includeInactive: false });
  const paidPlans = plans.filter((plan) => {
    return Number(plan.price_monthly_paise || 0) > 0 || Number(plan.price_yearly_paise || 0) > 0;
  });

  if (!paidPlans.length) {
    console.log("No paid billing plans found to sync.");
    return;
  }

  for (const plan of paidPlans) {
    const synced = await syncPlanToStripe(plan.id, {
      createMissing: true,
      replaceExisting: process.argv.includes("--replace-existing"),
    });

    console.log(
      `${synced.slug}: product=${synced.stripe_product_id || "none"} ` +
      `monthly=${synced.stripe_price_monthly_id || "none"} ` +
      `yearly=${synced.stripe_price_yearly_id || "none"} ` +
      `currency=${synced.stripe_currency || "usd"}`
    );
  }
}

try {
  await main();
} catch (err) {
  console.error("Stripe plan sync failed:", err.message);
  if (err.details) console.error(JSON.stringify(err.details));
  process.exitCode = 1;
} finally {
  await pool.end();
}
