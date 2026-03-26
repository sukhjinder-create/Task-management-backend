// routes/superadminPlans.routes.js
import express from "express";
import requireSuperadmin from "../middleware/requireSuperadmin.js";
import {
  listPlans,
  getPlanById,
  createPlan,
  updatePlan,
  hardDeletePlan,
} from "../repositories/billingPlans.repository.js";
import { syncPlanToRazorpay } from "../services/razorpay.service.js";

const router = express.Router();
router.use(requireSuperadmin);

/**
 * GET /superadmin/plans
 * List all plans (including inactive for superadmin)
 */
router.get("/", async (_req, res) => {
  try {
    const plans = await listPlans({ includeInactive: true });
    return res.json(plans);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /superadmin/plans/:id
 */
router.get("/:id", async (req, res) => {
  try {
    const plan = await getPlanById(req.params.id);
    if (!plan) return res.status(404).json({ error: "Plan not found" });
    return res.json(plan);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /superadmin/plans
 * Create a new plan
 */
router.post("/", async (req, res) => {
  try {
    const {
      name, slug, tagline, description,
      price_monthly, price_yearly, yearly_discount_pct,
      member_limit, max_projects, max_integrations, storage_limit_gb,
      features, support_level, trial_days, grace_period_days,
      is_popular, is_custom, display_order,
    } = req.body;

    if (!name || !slug) {
      return res.status(400).json({ error: "name and slug are required" });
    }

    // Accept price in rupees from UI; store as paise
    const plan = await createPlan({
      name:                 String(name).trim(),
      slug:                 String(slug).toLowerCase().trim(),
      tagline:              tagline || null,
      description:          description || null,
      price_monthly_paise:  Math.round((Number(price_monthly) || 0) * 100),
      price_yearly_paise:   Math.round((Number(price_yearly)  || 0) * 100),
      yearly_discount_pct:  Number(yearly_discount_pct) || 0,
      member_limit:         member_limit ? Number(member_limit) : null,
      max_projects:         max_projects ? Number(max_projects) : null,
      max_integrations:     max_integrations ? Number(max_integrations) : null,
      storage_limit_gb:     storage_limit_gb ? Number(storage_limit_gb) : null,
      features:             Array.isArray(features) ? features : [],
      support_level:        support_level || "community",
      trial_days:           Number(trial_days) ?? 7,
      grace_period_days:    Number(grace_period_days) ?? 3,
      is_popular:           Boolean(is_popular),
      is_custom:            Boolean(is_custom),
      display_order:        Number(display_order) || 0,
    });

    return res.status(201).json(plan);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

/**
 * PUT /superadmin/plans/:id
 * Update a plan (name, price, features, limits, etc.)
 */
router.put("/:id", async (req, res) => {
  try {
    const body = req.body;
    const data = {};

    if (body.name            !== undefined) data.name              = String(body.name).trim();
    if (body.tagline         !== undefined) data.tagline           = body.tagline;
    if (body.description     !== undefined) data.description       = body.description;
    if (body.price_monthly   !== undefined) data.price_monthly_paise = Math.round(Number(body.price_monthly) * 100);
    if (body.price_yearly    !== undefined) data.price_yearly_paise  = Math.round(Number(body.price_yearly)  * 100);
    if (body.yearly_discount_pct !== undefined) data.yearly_discount_pct = Number(body.yearly_discount_pct);
    if (body.member_limit    !== undefined) data.member_limit      = body.member_limit ? Number(body.member_limit) : null;
    if (body.max_projects    !== undefined) data.max_projects       = body.max_projects ? Number(body.max_projects) : null;
    if (body.max_integrations !== undefined) data.max_integrations  = body.max_integrations ? Number(body.max_integrations) : null;
    if (body.storage_limit_gb !== undefined) data.storage_limit_gb  = body.storage_limit_gb ? Number(body.storage_limit_gb) : null;
    if (body.features        !== undefined) data.features          = body.features;
    if (body.support_level   !== undefined) data.support_level     = body.support_level;
    if (body.trial_days      !== undefined) data.trial_days        = Number(body.trial_days);
    if (body.grace_period_days !== undefined) data.grace_period_days = Number(body.grace_period_days);
    if (body.is_active       !== undefined) data.is_active         = Boolean(body.is_active);
    if (body.is_popular      !== undefined) data.is_popular        = Boolean(body.is_popular);
    if (body.display_order   !== undefined) data.display_order     = Number(body.display_order);

    const updated = await updatePlan(req.params.id, data);
    return res.json(updated);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /superadmin/plans/:id
 * Hard-delete if no workspaces are on this plan; error if in use.
 */
router.delete("/:id", async (req, res) => {
  try {
    await hardDeletePlan(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message });
  }
});

/**
 * POST /superadmin/plans/:id/sync-razorpay
 * Push this plan to Razorpay and save the Razorpay plan IDs.
 * Must be done once before workspaces can subscribe to this plan.
 */
router.post("/:id/sync-razorpay", async (req, res) => {
  try {
    const updated = await syncPlanToRazorpay(req.params.id);
    return res.json({
      success: true,
      razorpay_monthly_plan_id: updated.razorpay_monthly_plan_id,
      razorpay_yearly_plan_id:  updated.razorpay_yearly_plan_id,
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message, details: err.details });
  }
});

export default router;
