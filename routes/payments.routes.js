// routes/payments.routes.js
// =============================================================================
// Workspace billing endpoints (Stripe — hosted checkout, subscriptions, portal)
// =============================================================================
import express from "express";
import pool from "../db.js";
import { listPlans } from "../repositories/billingPlans.repository.js";
import {
  getPublicBillingConfig,
  getWorkspaceBillingSummary,
  createCheckoutSession,
  createBillingPortalSession,
  cancelSubscription,
  listPendingUsers,
  calculateActivationCost,
  createActivationCheckoutSession,
  syncStripeSubscriptionSeatQuantity,
  processRazorpayWebhook,
  processStripeWebhook,
  verifyRazorpayWorkspaceSubscriptionPayment,
} from "../services/payments.service.js";

const router = express.Router();

// Raw-body webhook router (must be registered BEFORE express.json() in index.js)
const webhookRouter = express.Router();
webhookRouter.post(
  "/",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const sig    = req.headers["stripe-signature"];
      const result = await processStripeWebhook(req.body, sig);
      return res.json(result);
    } catch (err) {
      console.error("[payments] webhook error:", err.message);
      return res.status(err.statusCode || 400).json({ error: err.message });
    }
  }
);

const razorpayWebhookRouter = express.Router();
razorpayWebhookRouter.post(
  "/",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const sig = req.headers["x-razorpay-signature"];
      const eventId = req.headers["x-razorpay-event-id"];
      const result = await processRazorpayWebhook(req.body, sig, eventId);
      return res.json(result);
    } catch (err) {
      console.error("[payments] Razorpay webhook error:", err.message);
      return res.status(err.statusCode || 400).json({ error: err.message });
    }
  }
);

// ── Guard: billing admin only ─────────────────────────────────────────────────
function requireBillingAdmin(req, res, next) {
  if (!["admin", "owner"].includes(req.user?.role)) {
    return res.status(403).json({ error: "Admin access required for billing" });
  }
  next();
}

// ── Public: plan catalog ──────────────────────────────────────────────────────

/**
 * GET /payments/plans
 * Active plans from DB — no auth required within workspace context.
 */
router.get("/plans", async (_req, res) => {
  try {
    const plans = await listPlans({ includeInactive: false });
    const formatted = plans.map((p) => ({
      ...p,
      price_monthly: (p.price_monthly_paise || 0) / 100,
      price_yearly:  (p.price_yearly_paise  || 0) / 100,
      stripe_ready:  !!(p.stripe_price_monthly_id || p.stripe_price_yearly_id),
      razorpay_ready: !!(p.razorpay_plan_monthly_id || p.razorpay_plan_yearly_id),
    }));
    return res.json(formatted);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /payments/config
 * Stripe publishable key + feature flags.
 */
router.get("/config", (_req, res) => {
  return res.json(getPublicBillingConfig());
});

/**
 * GET /payments/summary
 * Current workspace billing state.
 */
router.get("/summary", async (req, res) => {
  try {
    const summary = await getWorkspaceBillingSummary(req.workspaceId);
    return res.json(summary);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── Subscription checkout ─────────────────────────────────────────────────────

/**
 * POST /payments/subscribe
 * Creates a Stripe Checkout Session for the workspace.
 * Returns { url } — frontend redirects the user to Stripe's hosted page.
 *
 * Body: { planId, interval: "monthly"|"yearly", successUrl?, cancelUrl? }
 */
router.post("/subscribe", requireBillingAdmin, async (req, res) => {
  try {
    const { planId, interval = "monthly", successUrl, cancelUrl } = req.body;
    if (!planId) return res.status(400).json({ error: "planId is required" });

    const workspace = { id: req.workspaceId, name: req.workspace?.name || "" };
    const user      = { id: req.user?.id,   email: req.user?.email || "" };

    const result = await createCheckoutSession({
      workspace, user, planId, interval, successUrl, cancelUrl,
    });

    return res.status(201).json(result);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message, details: err.details });
  }
});

router.post("/verify", requireBillingAdmin, async (req, res) => {
  try {
    const {
      razorpay_payment_id: paymentId,
      razorpay_subscription_id: subscriptionId,
      razorpay_signature: signature,
    } = req.body || {};

    const result = await verifyRazorpayWorkspaceSubscriptionPayment({
      workspaceId: req.workspaceId,
      userId: req.user?.id || null,
      subscriptionId,
      paymentId,
      signature,
    });

    return res.json(result);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message, details: err.details });
  }
});

/**
 * POST /payments/portal
 * Opens a Stripe Billing Portal session so the customer can manage or cancel.
 * Returns { url } — frontend redirects the user.
 *
 * Body: { returnUrl? }
 */
router.post("/portal", requireBillingAdmin, async (req, res) => {
  try {
    const { returnUrl } = req.body;
    const result = await createBillingPortalSession({
      workspaceId: req.workspaceId,
      returnUrl,
    });
    return res.json(result);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * POST /payments/cancel
 * Cancel at end of current billing period (access continues until period end).
 * Cancellation is also available via the billing portal.
 */
router.post("/cancel", requireBillingAdmin, async (req, res) => {
  try {
    const result = await cancelSubscription(req.workspaceId);
    return res.json(result);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── Per-user billing ──────────────────────────────────────────────────────────

/**
 * POST /payments/sync-seats
 * Repairs recurring Stripe seat quantity to match billable workspace users.
 */
router.post("/sync-seats", requireBillingAdmin, async (req, res) => {
  try {
    const result = await syncStripeSubscriptionSeatQuantity(req.workspaceId, {
      prorationBehavior: "none",
    });
    return res.json(result);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message, details: err.details });
  }
});

/**
 * GET /payments/pending-users
 * Lists workspace users with billing_status = 'pending'.
 */
router.get("/pending-users", requireBillingAdmin, async (req, res) => {
  try {
    const users = await listPendingUsers(req.workspaceId);

    const { rows: wsRows } = await pool.query(
      `SELECT billing_cycle_anchor, per_user_price_paise FROM workspaces WHERE id = $1`,
      [req.workspaceId]
    );
    const ws = wsRows[0] || {};

    return res.json({
      users,
      perUserPricePaise:  ws.per_user_price_paise || null,
      billingCycleAnchor: ws.billing_cycle_anchor || null,
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * POST /payments/activation-cost
 * Preview pro-rated cost for selected user IDs before payment.
 * Body: { userIds: string[] }
 */
router.post("/activation-cost", requireBillingAdmin, async (req, res) => {
  try {
    const { userIds } = req.body;
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: "userIds array is required" });
    }
    const cost = await calculateActivationCost(req.workspaceId, userIds);
    return res.json(cost);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * POST /payments/create-activation-order
 * Creates a Stripe Checkout Session (one-time payment) to activate pending users.
 * Returns { url } — frontend redirects the user to Stripe's hosted page.
 * On checkout.session.completed webhook, users are automatically activated.
 *
 * Body: { userIds: string[], successUrl?, cancelUrl? }
 */
router.post("/create-activation-order", requireBillingAdmin, async (req, res) => {
  try {
    const { userIds, successUrl, cancelUrl } = req.body;
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: "userIds array is required" });
    }

    const workspace = { id: req.workspaceId, name: req.workspace?.name || "" };
    const user      = { id: req.user?.id,   email: req.user?.email || "" };

    const result = await createActivationCheckoutSession({
      workspace, user, userIds, successUrl, cancelUrl,
    });

    return res.status(201).json(result);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message, details: err.details });
  }
});

export { razorpayWebhookRouter, webhookRouter };
export default router;
