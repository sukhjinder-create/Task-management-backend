import express from "express";
import { listPlans } from "../repositories/billingPlans.repository.js";

const router = express.Router();

export function toPublicBillingPlan(plan) {
  return {
    id: plan.id,
    name: plan.name,
    slug: plan.slug,
    tagline: plan.tagline || null,
    description: plan.description || null,
    price_monthly: (Number(plan.price_monthly_paise) || 0) / 100,
    price_yearly: (Number(plan.price_yearly_paise) || 0) / 100,
    yearly_discount_pct: Number(plan.yearly_discount_pct) || 0,
    currency: String(plan.razorpay_currency || plan.stripe_currency || "inr").toUpperCase(),
    member_limit: plan.member_limit == null ? null : Number(plan.member_limit),
    max_projects: plan.max_projects == null ? null : Number(plan.max_projects),
    max_integrations: plan.max_integrations == null ? null : Number(plan.max_integrations),
    storage_limit_gb: plan.storage_limit_gb == null ? null : Number(plan.storage_limit_gb),
    features: Array.isArray(plan.features) ? plan.features : [],
    support_level: plan.support_level || null,
    trial_days: Number(plan.trial_days) || 0,
    is_popular: !!plan.is_popular,
    is_custom: !!plan.is_custom,
    display_order: Number(plan.display_order) || 0,
  };
}

/** Public, sanitized plan catalog shared by the landing page and signup UI. */
router.get("/plans", async (_req, res) => {
  try {
    const plans = await listPlans({ includeInactive: false });
    res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
    return res.json(plans.map(toPublicBillingPlan));
  } catch (err) {
    console.error("[public-billing] failed to load plans:", err.message);
    return res.status(500).json({ error: "Plans are temporarily unavailable" });
  }
});

export default router;
