import test from "node:test";
import assert from "node:assert/strict";
import { toPublicBillingPlan } from "../routes/publicBilling.routes.js";

test("public billing projection exposes landing fields without provider secrets", () => {
  const projected = toPublicBillingPlan({
    id: "plan-1",
    name: "Pro",
    slug: "pro",
    price_monthly_paise: 99900,
    price_yearly_paise: 999000,
    razorpay_currency: "inr",
    razorpay_plan_monthly_id: "plan_private",
    stripe_price_monthly_id: "price_private",
    features: ["team_chat"],
    trial_days: 7,
    is_active: true,
    is_popular: true,
  });

  assert.equal(projected.price_monthly, 999);
  assert.equal(projected.price_yearly, 9990);
  assert.equal(projected.currency, "INR");
  assert.deepEqual(projected.features, ["team_chat"]);
  assert.equal(projected.is_popular, true);
  assert.equal("razorpay_plan_monthly_id" in projected, false);
  assert.equal("stripe_price_monthly_id" in projected, false);
  assert.equal("is_active" in projected, false);
});
