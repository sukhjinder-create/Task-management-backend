// routes/payments.routes.js
// =============================================================================
// Workspace billing endpoints (Razorpay — UPI AutoPay, Cards, NACH)
// =============================================================================
import express from "express";
import { listPlans } from "../repositories/billingPlans.repository.js";
import {
  getPublicConfig,
  createSubscription,
  verifyPaymentSignature,
  confirmSubscription,
  cancelSubscription,
  getBillingSummary,
  verifyWebhookSignature,
  handleWebhookEvent,
} from "../services/razorpay.service.js";

const router = express.Router();

// Raw-body webhook router (must be registered BEFORE express.json() in index.js)
const webhookRouter = express.Router();
webhookRouter.post(
  "/",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const sig   = req.headers["x-razorpay-signature"];
      const event = verifyWebhookSignature(req.body, sig);
      await handleWebhookEvent(event);
      return res.json({ received: true });
    } catch (err) {
      console.error("[payments] webhook error:", err.message);
      return res.status(err.statusCode || 400).json({ error: err.message });
    }
  }
);

// ── Guard: billing admin only (admin role) ────────────────────────────────────
function requireBillingAdmin(req, res, next) {
  if (!["admin", "owner"].includes(req.user?.role)) {
    return res.status(403).json({ error: "Admin access required for billing" });
  }
  next();
}

// ── Public: plan catalog (workspace users see this to pick a plan) ────────────
/**
 * GET /payments/plans
 * Returns active plans from DB (no auth required within workspace context)
 */
router.get("/plans", async (_req, res) => {
  try {
    const plans = await listPlans({ includeInactive: false });
    // Convert paise → rupees for frontend convenience
    const formatted = plans.map(p => ({
      ...p,
      price_monthly: p.price_monthly_paise / 100,
      price_yearly:  p.price_yearly_paise  / 100,
    }));
    return res.json(formatted);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /payments/config
 * Razorpay public key + feature flags
 */
router.get("/config", (_req, res) => {
  return res.json(getPublicConfig());
});

/**
 * GET /payments/summary
 * Current workspace billing state
 */
router.get("/summary", async (req, res) => {
  try {
    const summary = await getBillingSummary(req.workspaceId);
    // Convert paise → rupees
    if (summary.subscription) {
      summary.subscription.price_monthly = (summary.subscription.price_monthly_paise || 0) / 100;
      summary.subscription.price_yearly  = (summary.subscription.price_yearly_paise  || 0) / 100;
    }
    return res.json(summary);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * POST /payments/subscribe
 * Create a Razorpay subscription for the workspace.
 * Returns subscriptionId + keyId → frontend opens Razorpay Checkout.
 *
 * Body: { planId, interval: "monthly"|"yearly" }
 */
router.post("/subscribe", requireBillingAdmin, async (req, res) => {
  try {
    const { planId, interval = "monthly" } = req.body;
    if (!planId) return res.status(400).json({ error: "planId is required" });

    const result = await createSubscription({
      workspaceId:   req.workspaceId,
      workspaceName: req.workspace?.name || "",
      planId,
      interval,
      userEmail: req.user?.email || "",
      userName:  req.user?.username || "",
    });

    return res.status(201).json(result);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message, details: err.details });
  }
});

/**
 * POST /payments/verify
 * Called by frontend after Razorpay Checkout success handler fires.
 * Verifies HMAC signature and marks subscription as confirmed.
 *
 * Body: { razorpay_payment_id, razorpay_subscription_id, razorpay_signature, planSlug }
 */
router.post("/verify", requireBillingAdmin, async (req, res) => {
  try {
    const {
      razorpay_payment_id:      paymentId,
      razorpay_subscription_id: subscriptionId,
      razorpay_signature:       signature,
      planSlug,
    } = req.body;

    if (!paymentId || !subscriptionId || !signature) {
      return res.status(400).json({ error: "payment_id, subscription_id, and signature are required" });
    }

    verifyPaymentSignature({ paymentId, subscriptionId, signature });

    await confirmSubscription({
      workspaceId:    req.workspaceId,
      paymentId,
      subscriptionId,
      planSlug: planSlug || "pro",
    });

    return res.json({ success: true, message: "Subscription activated" });
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message });
  }
});

/**
 * POST /payments/cancel
 * Cancel at end of current billing period.
 */
router.post("/cancel", requireBillingAdmin, async (req, res) => {
  try {
    const result = await cancelSubscription(req.workspaceId);
    return res.json(result);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

export { webhookRouter };
export default router;
