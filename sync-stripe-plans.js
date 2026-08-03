import "dotenv/config";
import pool from "./db.js";
import { listPlans } from "./repositories/billingPlans.repository.js";
import { syncPlanToStripe } from "./services/payments.service.js";

function parseCurrencies() {
  const arg = process.argv.find((value) => value.startsWith("--currencies="));
  if (!arg) return [null]; // null = each plan's own base currency
  return arg
    .slice("--currencies=".length)
    .split(",")
    .map((code) => code.trim().toLowerCase())
    .filter(Boolean);
}

async function main() {
  const plans = await listPlans({ includeInactive: false });
  const paidPlans = plans.filter((plan) => {
    return Number(plan.price_monthly_minor || 0) > 0 || Number(plan.price_yearly_minor || 0) > 0;
  });

  if (!paidPlans.length) {
    console.log("No paid billing plans found to sync.");
    return;
  }

  const currencies = parseCurrencies();

  for (const plan of paidPlans) {
    for (const currency of currencies) {
      const synced = await syncPlanToStripe(plan.id, {
        currency: currency || plan.base_currency,
        createMissing: true,
        replaceExisting: process.argv.includes("--replace-existing"),
      });

      const sync = synced.stripe_sync || {};
      console.log(
        `${plan.slug} [${(sync.currency || currency || plan.base_currency || "usd").toUpperCase()}]: ` +
        `monthly=${sync.monthlyAmount ?? "-"} yearly=${sync.yearlyAmount ?? "-"} ` +
        `created=${JSON.stringify(sync.created || {})}`
      );
    }
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
