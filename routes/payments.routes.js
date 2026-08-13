// routes/payments.routes.js
// =============================================================================
// Workspace billing endpoints (Stripe — hosted checkout, subscriptions, portal)
// =============================================================================
import express from "express";
import pool from "../db.js";
import db from "../db.js";
import { listPlans } from "../repositories/billingPlans.repository.js";
import {
  formatMoney,
  getBaseCurrency,
  getCurrencyMeta,
  listCurrencies,
  resolveRequestCurrency,
  toMajorUnits,
} from "../services/currency.service.js";
import { resolveCatalogPrices } from "../services/billingPricing.service.js";
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

// ── Authenticated app plan catalog ───────────────────────────────────────────

/**
 * GET /payments/plans
 * Active plans from DB for the signed-in workspace billing UI.
 */
router.get("/plans", async (req, res) => {
  try {
    // A workspace that already has a billing currency keeps seeing that one, so
    // upgrade pricing matches what it is actually charged.
    const { rows } = await db.query(
      `SELECT billing_currency FROM workspaces WHERE id = $1 LIMIT 1`,
      [req.workspaceId]
    );
    const { currency } = resolveRequestCurrency(req, { preferred: rows[0]?.billing_currency });

    const plans = await listPlans({ includeInactive: false });
    const prices = await resolveCatalogPrices(plans, currency);

    const formatted = plans.map((p) => {
      const price = prices.get(p.id);
      const meta = getCurrencyMeta(price?.currency || currency);
      return {
        ...p,
        currency: meta.display,
        currency_symbol: meta.symbol,
        price_monthly: toMajorUnits(price?.price_monthly_minor ?? p.price_monthly_minor, meta.code),
        price_yearly:  toMajorUnits(price?.price_yearly_minor  ?? p.price_yearly_minor,  meta.code),
        price_monthly_minor: price?.price_monthly_minor ?? p.price_monthly_minor,
        price_yearly_minor:  price?.price_yearly_minor  ?? p.price_yearly_minor,
        price_monthly_display: formatMoney(price?.price_monthly_minor ?? p.price_monthly_minor, meta.code),
        price_yearly_display:  formatMoney(price?.price_yearly_minor  ?? p.price_yearly_minor,  meta.code),
        stripe_ready:  !!(p.stripe_price_monthly_id || p.stripe_price_yearly_id),
        razorpay_ready: !!(p.razorpay_plan_monthly_id || p.razorpay_plan_yearly_id),
      };
    });
    return res.json(formatted);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /payments/currencies
 * Currency options for the in-app billing screen.
 */
router.get("/currencies", (req, res) => {
  const { currency, source, country } = resolveRequestCurrency(req);
  return res.json({
    base: getBaseCurrency().toUpperCase(),
    detected: currency.toUpperCase(),
    detected_source: source,
    country: country || null,
    currencies: listCurrencies().map((meta) => ({
      code: meta.display,
      name: meta.name,
      symbol: meta.symbol,
      decimals: meta.decimals,
    })),
  });
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
    const { planId, interval = "monthly", currency, successUrl, cancelUrl } = req.body;
    if (!planId) return res.status(400).json({ error: "planId is required" });

    const { rows } = await db.query(
      `SELECT name, billing_currency, trial_ends_at FROM workspaces WHERE id = $1 LIMIT 1`,
      [req.workspaceId]
    );
    const workspace = {
      id: req.workspaceId,
      name: req.workspace?.name || rows[0]?.name || "",
      billing_currency: rows[0]?.billing_currency || null,
      trial_ends_at: req.workspace?.trial_ends_at || rows[0]?.trial_ends_at || null,
    };
    const user      = { id: req.user?.id,   email: req.user?.email || "" };

    // Explicit body currency wins; otherwise fall back to what this visitor
    // would have been shown on the pricing screen.
    const requested =
      currency || resolveRequestCurrency(req, { preferred: workspace.billing_currency }).currency;

    const result = await createCheckoutSession({
      workspace, user, planId, interval, currency: requested, successUrl, cancelUrl,
    });

    return res.status(201).json(result);
  } catch (err) {
    return res.status(err.statusCode || 500).json({
      error: err.message,
      code: err.code,
      availableAt: err.availableAt,
      details: err.details,
    });
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
      `SELECT billing_cycle_anchor, per_user_price_minor, billing_currency
         FROM workspaces WHERE id = $1`,
      [req.workspaceId]
    );
    const ws = wsRows[0] || {};
    const currency = ws.billing_currency || getBaseCurrency();

    return res.json({
      users,
      perUserPriceMinor:   ws.per_user_price_minor || null,
      perUserPriceDisplay: ws.per_user_price_minor
        ? formatMoney(ws.per_user_price_minor, currency)
        : null,
      currency: currency.toUpperCase(),
      currencySymbol: getCurrencyMeta(currency)?.symbol || null,
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
