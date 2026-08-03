import test from "node:test";
import assert from "node:assert/strict";
import { toPublicBillingPlan } from "../routes/publicBilling.routes.js";

test("public billing projection exposes landing fields without provider secrets", () => {
  const projected = toPublicBillingPlan({
    id: "plan-1",
    name: "Pro",
    slug: "pro",
    base_currency: "usd",
    price_monthly_minor: 2000,
    price_yearly_minor: 20000,
    razorpay_plan_monthly_id: "plan_private",
    stripe_price_monthly_id: "price_private",
    features: ["team_chat"],
    trial_days: 7,
    is_active: true,
    is_popular: true,
  });

  assert.equal(projected.price_monthly, 20);
  assert.equal(projected.price_yearly, 200);
  assert.equal(projected.price_monthly_minor, 2000);
  assert.equal(projected.currency, "USD");
  assert.deepEqual(projected.features, ["team_chat"]);
  assert.equal(projected.is_popular, true);
  assert.equal("razorpay_plan_monthly_id" in projected, false);
  assert.equal("stripe_price_monthly_id" in projected, false);
  assert.equal("is_active" in projected, false);
});

test("public billing projection renders a resolved local price and keeps the USD list price", () => {
  const plan = {
    id: "plan-1",
    name: "Pro",
    slug: "pro",
    base_currency: "usd",
    price_monthly_minor: 2000,
    price_yearly_minor: 20000,
    features: [],
    trial_days: 7,
  };

  const projected = toPublicBillingPlan(plan, {
    currency: "inr",
    price_monthly_minor: 179900,
    price_yearly_minor: 1799900,
    source: "fx",
  });

  assert.equal(projected.currency, "INR");
  assert.equal(projected.price_monthly, 1799);
  assert.equal(projected.price_monthly_minor, 179900);
  assert.equal(projected.price_source, "fx");

  // The USD list price stays visible for comparison.
  assert.equal(projected.base_currency, "USD");
  assert.equal(projected.base_price_monthly, 20);
});

test("zero-decimal currencies are not divided by 100", () => {
  const projected = toPublicBillingPlan(
    { id: "p", name: "Pro", slug: "pro", base_currency: "usd", price_monthly_minor: 2000, features: [] },
    { currency: "jpy", price_monthly_minor: 3000, price_yearly_minor: 30000, source: "fx" }
  );

  assert.equal(projected.currency, "JPY");
  assert.equal(projected.currency_decimals, 0);
  assert.equal(projected.price_monthly, 3000); // ¥3,000 — not ¥30
});
