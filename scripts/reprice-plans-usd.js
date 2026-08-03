#!/usr/bin/env node
// scripts/reprice-plans-usd.js
// =============================================================================
// Sets the USD list price for each plan. Dry-run by default — nothing is written
// without --apply.
//
// The multi-currency migration renamed price_monthly_paise → price_monthly_minor
// without touching the numbers, because only you know whether the old values
// were rupees or already dollars. This script is where that decision is made,
// explicitly and reviewably.
//
// Usage:
//   node scripts/reprice-plans-usd.js
//       Show current values and what each mode would produce.
//
//   node scripts/reprice-plans-usd.js --from-inr --rate=88 --apply
//       Treat the stored values as INR paise and convert to USD cents at 88/USD,
//       rounding to a .99 retail price point.
//
//   node scripts/reprice-plans-usd.js --set pro=20,enterprise=60 --apply
//       Set explicit USD monthly prices per plan slug. Yearly is derived from
//       the plan's yearly_discount_pct unless --yearly is given too.
//
//   node scripts/reprice-plans-usd.js --set pro=20 --yearly pro=200 --apply
//
//   node scripts/reprice-plans-usd.js --keep --apply
//       Leave numbers as-is and just stamp base_currency=usd.
//
//   node scripts/reprice-plans-usd.js --rollback --apply
//       Restore the pre-migration values from legacy_price_*_paise.
// =============================================================================

import "dotenv/config";
import pool from "../db.js";
import { formatMoney, roundToRetailPrice, toMinorUnits } from "../services/currency.service.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const MODE = args.includes("--rollback")
  ? "rollback"
  : args.includes("--from-inr")
    ? "from-inr"
    : args.some((a) => a === "--set")
      ? "set"
      : args.includes("--keep")
        ? "keep"
        : "report";

function flagValue(name) {
  const inline = args.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function parsePairs(raw) {
  const out = {};
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const [slug, value] = pair.split("=");
    const amount = Number(value);
    if (slug && Number.isFinite(amount)) out[slug.trim().toLowerCase()] = amount;
  }
  return out;
}

const INR_RATE = Number(flagValue("--rate")) || 88;
const MONTHLY_OVERRIDES = parsePairs(flagValue("--set"));
const YEARLY_OVERRIDES = parsePairs(flagValue("--yearly"));

function proposeFromInr(plan) {
  // Stored value is paise → rupees → dollars, then snapped to a retail price.
  const monthlyUsdMinor = Math.round((Number(plan.price_monthly_minor) || 0) / INR_RATE);
  const yearlyUsdMinor = Math.round((Number(plan.price_yearly_minor) || 0) / INR_RATE);
  return {
    monthly: monthlyUsdMinor > 0 ? roundToRetailPrice(monthlyUsdMinor, "usd", { charm: true }) : 0,
    yearly: yearlyUsdMinor > 0 ? roundToRetailPrice(yearlyUsdMinor, "usd", { charm: true }) : 0,
  };
}

function proposeFromSet(plan) {
  const monthlyUsd = MONTHLY_OVERRIDES[plan.slug];
  if (monthlyUsd === undefined) return null;

  const monthly = toMinorUnits(monthlyUsd, "usd");
  const explicitYearly = YEARLY_OVERRIDES[plan.slug];
  if (explicitYearly !== undefined) {
    return { monthly, yearly: toMinorUnits(explicitYearly, "usd") };
  }

  const discount = Number(plan.yearly_discount_pct) || 0;
  const yearly = Math.round(monthly * 12 * (1 - discount / 100));
  return { monthly, yearly: yearly > 0 ? roundToRetailPrice(yearly, "usd", { charm: true }) : 0 };
}

function proposeRollback(plan) {
  return {
    monthly: Number(plan.legacy_price_monthly_paise) || 0,
    yearly: Number(plan.legacy_price_yearly_paise) || 0,
  };
}

async function main() {
  const { rows: plans } = await pool.query(
    `SELECT id, slug, name, base_currency, price_monthly_minor, price_yearly_minor,
            legacy_price_monthly_paise, legacy_price_yearly_paise, yearly_discount_pct
       FROM billing_plans
      ORDER BY display_order, created_at`
  );

  if (!plans.length) {
    console.log("No billing plans found.");
    return;
  }

  console.log(`Mode: ${MODE}${APPLY ? " (APPLYING)" : " (dry run — pass --apply to write)"}`);
  if (MODE === "from-inr") console.log(`USD→INR rate: ${INR_RATE}\n`);
  else console.log("");

  const changes = [];

  for (const plan of plans) {
    const currentMonthly = Number(plan.price_monthly_minor) || 0;
    const currentYearly = Number(plan.price_yearly_minor) || 0;

    let proposed = null;
    if (MODE === "from-inr") proposed = proposeFromInr(plan);
    else if (MODE === "set") proposed = proposeFromSet(plan);
    else if (MODE === "rollback") proposed = proposeRollback(plan);
    else if (MODE === "keep") proposed = { monthly: currentMonthly, yearly: currentYearly };

    console.log(`${plan.name} (${plan.slug})`);
    console.log(
      `  stored : monthly_minor=${currentMonthly} yearly_minor=${currentYearly}` +
      `   [as USD: ${formatMoney(currentMonthly, "usd")}/mo` +
      `  |  as INR: ${formatMoney(currentMonthly, "inr")}/mo]`
    );

    if (MODE === "report" || !proposed) {
      if (MODE === "set") console.log("  proposed: (no --set entry for this slug — unchanged)");
      console.log("");
      continue;
    }

    console.log(
      `  proposed: ${formatMoney(proposed.monthly, "usd")}/mo, ` +
      `${formatMoney(proposed.yearly, "usd")}/yr  ` +
      `(minor: ${proposed.monthly} / ${proposed.yearly})`
    );
    console.log("");

    if (proposed.monthly !== currentMonthly || proposed.yearly !== currentYearly || plan.base_currency !== "usd") {
      changes.push({ plan, proposed });
    }
  }

  if (MODE === "report") {
    console.log(
      "Nothing proposed. Re-run with one of:\n" +
      "  --from-inr --rate=88   treat stored values as INR paise and convert\n" +
      "  --set pro=20,...       set explicit USD monthly prices per slug\n" +
      "  --keep                 keep the numbers, just stamp base_currency=usd\n" +
      "  --rollback             restore pre-migration values"
    );
    return;
  }

  if (!changes.length) {
    console.log("No changes needed.");
    return;
  }

  if (!APPLY) {
    console.log(`${changes.length} plan(s) would change. Re-run with --apply to write.`);
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const { plan, proposed } of changes) {
      await client.query(
        `UPDATE billing_plans
            SET price_monthly_minor = $2,
                price_yearly_minor  = $3,
                base_currency       = 'usd',
                repriced_at         = now(),
                updated_at          = now()
          WHERE id = $1`,
        [plan.id, proposed.monthly, proposed.yearly]
      );

      // Provider objects and FX-derived local prices were built from the old
      // amount, so they must not be reused at the new one.
      await client.query(
        `UPDATE billing_plan_provider_prices
            SET is_active = false, updated_at = now()
          WHERE plan_id = $1 AND is_active = true`,
        [plan.id]
      );
      await client.query(
        `DELETE FROM billing_plan_prices WHERE plan_id = $1 AND source = 'fx'`,
        [plan.id]
      );
      await client.query(
        `UPDATE billing_plans
            SET stripe_price_monthly_id = NULL,
                stripe_price_yearly_id  = NULL,
                razorpay_plan_monthly_id = NULL,
                razorpay_plan_yearly_id  = NULL
          WHERE id = $1`,
        [plan.id]
      );
    }
    await client.query("COMMIT");
    console.log(`Repriced ${changes.length} plan(s).`);
    console.log(
      "Provider prices were retired — existing subscriptions keep billing at their " +
      "original amount, and the next checkout creates fresh Stripe/Razorpay objects."
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

try {
  await main();
} catch (err) {
  console.error("Repricing failed:", err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
