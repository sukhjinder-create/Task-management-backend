// services/razorpay.service.js
// =============================================================================
// Razorpay integration — Subscriptions, UPI AutoPay, Card mandates, NACH
// =============================================================================
// Required env vars:
//   RAZORPAY_KEY_ID       — from Razorpay Dashboard > API Keys
//   RAZORPAY_KEY_SECRET   — from Razorpay Dashboard > API Keys
//   RAZORPAY_WEBHOOK_SECRET — from Razorpay Dashboard > Webhooks
//
// Mandate / Autopay flow:
//   1. Superadmin creates plan in Razorpay (POST /v1/plans) via syncPlanToRazorpay()
//   2. Workspace admin subscribes → createSubscription() returns subscription_id
//   3. Frontend opens Razorpay Checkout with subscription_id
//   4. User registers mandate (UPI/Card/NACH) — ₹1 auth charge (returned in 3-5 days)
//   5. Trial runs for `trial_days`; first real debit happens after trial ends
//   6. Webhooks: subscription.activated → workspace goes live
//                payment.captured       → record payment
//                subscription.charged   → update period
//                subscription.cancelled → downgrade to Starter
//                payment.failed         → increment failure counter, enter grace
// =============================================================================

import crypto from "crypto";
import axios from "axios";
import pool from "../db.js";
import {
  listPlans,
  getPlanById,
  saveRazorpayPlanIds,
  upsertWorkspaceSubscription,
  getWorkspaceSubscription,
  markAuthRefunded,
  recordPayment,
} from "../repositories/billingPlans.repository.js";

const RAZORPAY_API = "https://api.razorpay.com/v1";
const PLAN_MEMBER_LIMITS = { starter: 10, pro: 50, enterprise: 200 };

// ── Internal helpers ──────────────────────────────────────────────────────────

function getCredentials() {
  const keyId     = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    const err = new Error("Razorpay credentials not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.");
    err.statusCode = 503;
    throw err;
  }
  return { keyId, keySecret };
}

function getWebhookSecret() {
  const s = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!s) {
    const err = new Error("RAZORPAY_WEBHOOK_SECRET not configured.");
    err.statusCode = 503;
    throw err;
  }
  return s;
}

async function rzpRequest(method, path, data) {
  const { keyId, keySecret } = getCredentials();
  const resp = await axios({
    method,
    url: `${RAZORPAY_API}${path}`,
    auth: { username: keyId, password: keySecret },
    data,
    headers: { "Content-Type": "application/json" },
    validateStatus: () => true,
  });

  if (resp.status >= 400) {
    const msg = resp.data?.error?.description || resp.data?.error?.code || `Razorpay ${resp.status}`;
    const err = new Error(msg);
    err.statusCode = resp.status;
    err.details = resp.data;
    throw err;
  }
  return resp.data;
}

function nowPlusDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return Math.floor(d.getTime() / 1000); // Unix timestamp
}

// ── Public config (safe to send to frontend) ──────────────────────────────────

export function getPublicConfig() {
  const { keyId } = (() => {
    try { return getCredentials(); }
    catch { return { keyId: null }; }
  })();
  return {
    provider: "razorpay",
    keyId,
    enabled: !!keyId,
    currency: "INR",
    authAmountRupees: 1,    // ₹1 verification charge (returned)
    authAmountNote: "₹1 is charged to verify your payment method and will be returned within 3–5 business days.",
  };
}

// ── Step 1: Superadmin syncs plan to Razorpay ─────────────────────────────────
// Creates a Razorpay Plan for monthly + yearly billing intervals.
// Must be called once per plan before any workspace can subscribe.

export async function syncPlanToRazorpay(planId) {
  const plan = await getPlanById(planId);
  if (!plan) throw Object.assign(new Error("Plan not found"), { statusCode: 404 });
  if (!plan.is_active) throw Object.assign(new Error("Cannot sync inactive plan"), { statusCode: 400 });

  const ids = { monthly: plan.razorpay_monthly_plan_id, yearly: plan.razorpay_yearly_plan_id };

  // Monthly plan
  if (plan.price_monthly_paise > 0 && !ids.monthly) {
    const rPlan = await rzpRequest("POST", "/plans", {
      period: "monthly",
      interval: 1,
      item: {
        name:     `${plan.name} — Monthly`,
        amount:   plan.price_monthly_paise,
        currency: "INR",
        description: plan.tagline || plan.name,
      },
      notes: { proxima_plan_id: plan.id, proxima_plan_slug: plan.slug, interval: "monthly" },
    });
    ids.monthly = rPlan.id;
  }

  // Yearly plan
  if (plan.price_yearly_paise > 0 && !ids.yearly) {
    const rPlan = await rzpRequest("POST", "/plans", {
      period: "yearly",
      interval: 1,
      item: {
        name:     `${plan.name} — Yearly`,
        amount:   plan.price_yearly_paise,
        currency: "INR",
        description: plan.tagline || plan.name,
      },
      notes: { proxima_plan_id: plan.id, proxima_plan_slug: plan.slug, interval: "yearly" },
    });
    ids.yearly = rPlan.id;
  }

  return saveRazorpayPlanIds(plan.id, ids);
}

// ── Step 2: Create a subscription (called when workspace admin checks out) ────
// Returns { subscriptionId, keyId } — frontend opens Razorpay Checkout with this.

export async function createSubscription({
  workspaceId,
  workspaceName,
  planId,
  interval = "monthly",   // "monthly" | "yearly"
  userEmail,
  userName,
}) {
  const plan = await getPlanById(planId);
  if (!plan) throw Object.assign(new Error("Plan not found"), { statusCode: 404 });
  if (!plan.is_active) throw Object.assign(new Error("Plan is no longer available"), { statusCode: 400 });

  // Free plan — no Razorpay subscription needed
  const amount = interval === "yearly" ? plan.price_yearly_paise : plan.price_monthly_paise;
  if (amount === 0) throw Object.assign(new Error("Free plan does not require a subscription"), { statusCode: 400 });

  const razorpayPlanId = interval === "yearly"
    ? plan.razorpay_yearly_plan_id
    : plan.razorpay_monthly_plan_id;

  if (!razorpayPlanId) {
    throw Object.assign(
      new Error("This plan has not been synced to Razorpay yet. Contact your platform administrator."),
      { statusCode: 503 }
    );
  }

  // Start billing after trial (or immediately if trial_days = 0)
  const startAt = plan.trial_days > 0 ? nowPlusDays(plan.trial_days) : undefined;
  const trialEndsAt = plan.trial_days > 0 ? new Date(startAt * 1000).toISOString() : null;

  const subscription = await rzpRequest("POST", "/subscriptions", {
    plan_id:         razorpayPlanId,
    total_count:     120,          // 10 years — cancel anytime via webhook
    quantity:        1,
    start_at:        startAt,      // first billing after trial
    customer_notify: 1,            // Razorpay sends payment reminders
    notes: {
      workspace_id:   workspaceId,
      workspace_name: workspaceName,
      billing_plan:   plan.slug,
      interval,
      trial_days:     String(plan.trial_days),
    },
  });

  // Persist subscription record immediately (status = "created")
  await upsertWorkspaceSubscription({
    workspaceId,
    billingPlanId:         plan.id,
    razorpaySubscriptionId: subscription.id,
    razorpayCustomerId:    subscription.customer_id || null,
    mandateId:             null,
    status:                subscription.status || "created",
    billingInterval:       interval,
    trialEndsAt,
    nextBillingAt:         trialEndsAt,
    currentPeriodStart:    null,
    currentPeriodEnd:      null,
  });

  const { keyId } = getCredentials();
  return {
    subscriptionId: subscription.id,
    keyId,
    planName:   plan.name,
    planSlug:   plan.slug,
    interval,
    trialDays:  plan.trial_days,
    amountPaise: amount,
    prefill: { name: userName || "", email: userEmail || "" },
  };
}

// ── Step 3: Verify payment after Razorpay Checkout callback ──────────────────
// Razorpay sends: razorpay_payment_id, razorpay_subscription_id, razorpay_signature
// We verify signature then update state.

export function verifyPaymentSignature({ paymentId, subscriptionId, signature }) {
  const { keySecret } = getCredentials();
  const expected = crypto
    .createHmac("sha256", keySecret)
    .update(`${paymentId}|${subscriptionId}`)
    .digest("hex");

  if (expected !== signature) {
    throw Object.assign(new Error("Payment signature verification failed"), { statusCode: 400 });
  }
  return true;
}

export async function confirmSubscription({ workspaceId, paymentId, subscriptionId, planSlug }) {
  // Update workspace billing columns so superadmin sees new plan immediately
  const memberLimit = PLAN_MEMBER_LIMITS[planSlug] ?? 10;

  // Fetch per-user price from the plan
  const planRes = await pool.query(
    `SELECT price_monthly_paise FROM billing_plans WHERE slug = $1 AND is_active = true LIMIT 1`,
    [planSlug]
  );
  const perUserPricePaise = planRes.rows[0]?.price_monthly_paise || null;

  await pool.query(
    `UPDATE workspaces
     SET billing_plan              = $2,
         plan                      = $2,
         billing_status            = 'active',
         billing_provider          = 'razorpay',
         billing_subscription_id   = $3,
         billing_updated_at        = now(),
         member_limit              = $4,
         max_members               = $4,
         billing_cycle_anchor      = COALESCE(billing_cycle_anchor, now()),
         per_user_price_paise      = COALESCE(per_user_price_paise, $5),
         trial_started_at          = COALESCE(trial_started_at, now())
     WHERE id = $1`,
    [workspaceId, planSlug, subscriptionId, memberLimit, perUserPricePaise]
  );

  await pool.query(
    `UPDATE workspace_subscriptions
     SET status          = 'authenticated',
         last_payment_id = $2,
         last_payment_at = now(),
         updated_at      = now()
     WHERE workspace_id = $1 AND provider = 'razorpay'`,
    [workspaceId, paymentId]
  );

  // Convert all trial users to active for this billing cycle (one month from now)
  // and keep pending users as-is — admin must pay for them separately
  await pool.query(
    `UPDATE workspace_users
     SET billing_status = 'active',
         activated_at   = now(),
         cycle_start    = now(),
         cycle_end      = now() + INTERVAL '1 month'
     WHERE workspace_id = $1 AND billing_status = 'trial'`,
    [workspaceId]
  );

  console.log(`[billing] subscription confirmed workspace=${workspaceId} plan=${planSlug} per_user=${perUserPricePaise}`);
}

// ── Step 4: Handle Razorpay webhooks ─────────────────────────────────────────
// Configure in Razorpay Dashboard > Webhooks with your RAZORPAY_WEBHOOK_SECRET.
// Events to subscribe: subscription.activated, subscription.charged,
//   subscription.cancelled, payment.captured, payment.failed,
//   subscription.completed

export function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret   = getWebhookSecret();
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody.toString("utf8"))
    .digest("hex");

  if (expected !== signatureHeader) {
    throw Object.assign(new Error("Webhook signature mismatch"), { statusCode: 400 });
  }
  return JSON.parse(rawBody.toString("utf8"));
}

async function getWorkspaceBySubscriptionId(subscriptionId) {
  const res = await pool.query(
    `SELECT workspace_id FROM workspace_subscriptions WHERE subscription_id = $1 LIMIT 1`,
    [subscriptionId]
  );
  return res.rows[0]?.workspace_id || null;
}

async function setWorkspaceActive(workspaceId, planSlug) {
  const memberLimit = PLAN_MEMBER_LIMITS[planSlug] ?? 10;
  await pool.query(
    `UPDATE workspaces
     SET billing_status = 'active', billing_plan = $2, plan = $2,
         member_limit = $3, max_members = $3, billing_updated_at = now()
     WHERE id = $1`,
    [workspaceId, planSlug, memberLimit]
  );
}

async function setWorkspaceSuspended(workspaceId) {
  await pool.query(
    `UPDATE workspaces
     SET billing_status = 'suspended', billing_updated_at = now()
     WHERE id = $1`,
    [workspaceId]
  );
}

async function setWorkspaceDowngraded(workspaceId) {
  await pool.query(
    `UPDATE workspaces
     SET billing_status = 'active',
         billing_plan = 'starter', plan = 'starter',
         member_limit = 10, max_members = 10,
         billing_updated_at = now()
     WHERE id = $1`,
    [workspaceId]
  );
}

export async function handleWebhookEvent(event) {
  const { event: eventType, payload } = event;

  switch (eventType) {

    case "subscription.activated": {
      // Mandate successfully registered — trial begins
      const sub = payload.subscription?.entity;
      if (!sub) break;
      const wid   = sub.notes?.workspace_id || await getWorkspaceBySubscriptionId(sub.id);
      const slug  = sub.notes?.billing_plan || "pro";
      if (!wid) break;

      await pool.query(
        `UPDATE workspace_subscriptions
         SET status = 'active', mandate_id = $2, updated_at = now()
         WHERE workspace_id = $1 AND provider = 'razorpay'`,
        [wid, sub.payment_method?.id || null]
      );
      await setWorkspaceActive(wid, slug);
      console.log(`[billing] subscription.activated workspace=${wid} plan=${slug}`);
      break;
    }

    case "payment.captured": {
      // ₹1 auth captured OR recurring charge captured
      const payment = payload.payment?.entity;
      if (!payment) break;
      const subId = payment.subscription_id;
      if (!subId) break;
      const wid = await getWorkspaceBySubscriptionId(subId);
      if (!wid) break;

      await recordPayment(wid, { paymentId: payment.id });

      // If this is the ₹1 auth payment, mark it
      if (payment.amount === 100) {
        console.log(`[billing] ₹1 auth captured workspace=${wid} payment=${payment.id} — refund initiated by Razorpay`);
      }
      break;
    }

    case "subscription.charged": {
      // Recurring billing cycle charged successfully
      const sub = payload.subscription?.entity;
      if (!sub) break;
      const wid  = sub.notes?.workspace_id || await getWorkspaceBySubscriptionId(sub.id);
      const slug = sub.notes?.billing_plan || "pro";
      if (!wid) break;

      const periodStart = sub.current_start ? new Date(sub.current_start * 1000).toISOString() : null;
      const periodEnd   = sub.current_end   ? new Date(sub.current_end   * 1000).toISOString() : null;
      const nextBilling = sub.charge_at     ? new Date(sub.charge_at     * 1000).toISOString() : null;

      await pool.query(
        `UPDATE workspace_subscriptions
         SET status = 'active',
             current_period_start = $2,
             current_period_end   = $3,
             next_billing_at      = $4,
             payment_failure_count = 0,
             grace_period_ends_at  = null,
             updated_at = now()
         WHERE workspace_id = $1 AND provider = 'razorpay'`,
        [wid, periodStart, periodEnd, nextBilling]
      );

      await pool.query(
        `UPDATE workspaces
         SET billing_status = 'active',
             billing_current_period_end = $2,
             billing_updated_at = now()
         WHERE id = $1`,
        [wid, periodEnd]
      );

      await setWorkspaceActive(wid, slug);

      // Renew cycle dates for all active users in this workspace
      if (periodStart && periodEnd) {
        await pool.query(
          `UPDATE workspace_users
           SET cycle_start = $2, cycle_end = $3
           WHERE workspace_id = $1 AND billing_status = 'active'`,
          [wid, periodStart, periodEnd]
        );
      }

      console.log(`[billing] subscription.charged workspace=${wid} period=${periodStart}→${periodEnd}`);
      break;
    }

    case "payment.failed": {
      // A charge attempt failed — increment counter, enter grace period
      const payment = payload.payment?.entity;
      if (!payment?.subscription_id) break;
      const wid = await getWorkspaceBySubscriptionId(payment.subscription_id);
      if (!wid) break;

      const { rows } = await pool.query(
        `UPDATE workspace_subscriptions
         SET payment_failure_count = payment_failure_count + 1,
             updated_at = now()
         WHERE workspace_id = $1 AND provider = 'razorpay'
         RETURNING payment_failure_count, grace_period_days`,
        [wid]
      );

      const sub = rows[0];
      if (sub) {
        // Razorpay retries automatically for 15 days; we suspend after grace
        console.warn(`[billing] payment.failed workspace=${wid} failures=${sub.payment_failure_count}`);
      }
      break;
    }

    case "subscription.cancelled": {
      const sub = payload.subscription?.entity;
      if (!sub) break;
      const wid = sub.notes?.workspace_id || await getWorkspaceBySubscriptionId(sub.id);
      if (!wid) break;

      await pool.query(
        `UPDATE workspace_subscriptions
         SET status = 'canceled', cancel_at_period_end = false, updated_at = now()
         WHERE workspace_id = $1 AND provider = 'razorpay'`,
        [wid]
      );

      await setWorkspaceDowngraded(wid);
      console.log(`[billing] subscription.cancelled workspace=${wid} — downgraded to Starter`);
      break;
    }

    case "subscription.completed": {
      const sub = payload.subscription?.entity;
      if (!sub) break;
      const wid = sub.notes?.workspace_id || await getWorkspaceBySubscriptionId(sub.id);
      if (!wid) break;

      await pool.query(
        `UPDATE workspace_subscriptions
         SET status = 'completed', updated_at = now()
         WHERE workspace_id = $1 AND provider = 'razorpay'`,
        [wid]
      );
      await setWorkspaceDowngraded(wid);
      break;
    }

    default:
      // Non-critical event — ignore
      break;
  }
}

// ── Cancel subscription ───────────────────────────────────────────────────────

export async function cancelSubscription(workspaceId) {
  const sub = await getWorkspaceSubscription(workspaceId);
  if (!sub) throw Object.assign(new Error("No active subscription"), { statusCode: 404 });

  // Cancel at period end (not immediately)
  await rzpRequest("POST", `/subscriptions/${sub.subscription_id}/cancel`, {
    cancel_at_period_end: 1,
  });

  await pool.query(
    `UPDATE workspace_subscriptions
     SET cancel_at_period_end = true, updated_at = now()
     WHERE workspace_id = $1 AND provider = 'razorpay'`,
    [workspaceId]
  );

  return { cancelled: true, effectiveDate: sub.current_period_end };
}

// ── Per-user billing: list pending users ─────────────────────────────────────

export async function listPendingUsers(workspaceId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.email, u.role, u.avatar_url, u.created_at,
            wu.billing_status, wu.activated_at, wu.cycle_start, wu.cycle_end
     FROM users u
     JOIN workspace_users wu ON wu.user_id = u.id AND wu.workspace_id = $1
     WHERE u.workspace_id = $1
       AND wu.billing_status = 'pending'
       AND (u.is_system IS NULL OR u.is_system = false)
       AND u.role != 'system'
     ORDER BY u.created_at DESC`,
    [workspaceId]
  );
  return rows;
}

// ── Per-user billing: calculate pro-rated activation cost ─────────────────────
// Pro-rating: charge only for remaining days in current billing cycle.
// If no billing_cycle_anchor (admin hasn't subscribed yet), charge full month.

export async function calculateActivationCost(workspaceId, userIds) {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    throw Object.assign(new Error("Select at least one user to activate"), { statusCode: 400 });
  }

  const wsRes = await pool.query(
    `SELECT billing_cycle_anchor, per_user_price_paise FROM workspaces WHERE id = $1 LIMIT 1`,
    [workspaceId]
  );
  const ws = wsRes.rows[0];
  if (!ws) throw Object.assign(new Error("Workspace not found"), { statusCode: 404 });

  const pricePerUser = ws.per_user_price_paise;
  if (!pricePerUser || pricePerUser <= 0) {
    throw Object.assign(
      new Error("No per-user price configured. Please subscribe to a plan first."),
      { statusCode: 400 }
    );
  }

  const now = new Date();
  let cycleStart = now;
  let cycleEnd;
  let proRatedDays;
  let daysInCycle;

  if (ws.billing_cycle_anchor) {
    // Find the next cycle end from anchor
    const anchor = new Date(ws.billing_cycle_anchor);
    // Advance anchor to the next upcoming cycle boundary
    cycleEnd = new Date(anchor);
    while (cycleEnd <= now) {
      cycleEnd.setMonth(cycleEnd.getMonth() + 1);
    }
    // cycleStart is this cycle's start
    cycleStart = new Date(cycleEnd);
    cycleStart.setMonth(cycleStart.getMonth() - 1);

    const msInCycle = cycleEnd - cycleStart;
    const msRemaining = cycleEnd - now;
    daysInCycle = Math.round(msInCycle / 86400000);
    proRatedDays = Math.ceil(msRemaining / 86400000);
  } else {
    // No billing cycle yet — charge full month
    cycleEnd = new Date(now);
    cycleEnd.setMonth(cycleEnd.getMonth() + 1);
    daysInCycle = 30;
    proRatedDays = 30;
  }

  const pricePerUserProRated = Math.ceil((proRatedDays / daysInCycle) * pricePerUser);
  const totalPaise = pricePerUserProRated * userIds.length;

  return {
    userCount: userIds.length,
    pricePerUserMonthlyPaise: pricePerUser,
    pricePerUserProRatedPaise: pricePerUserProRated,
    proRatedDays,
    daysInCycle,
    totalPaise,
    cycleStart: cycleStart.toISOString(),
    cycleEnd: cycleEnd.toISOString(),
  };
}

// ── Per-user billing: create Razorpay Order for activation ────────────────────

export async function createActivationOrder(workspaceId, userIds, createdBy) {
  const cost = await calculateActivationCost(workspaceId, userIds);

  // Validate that all userIds are pending in this workspace
  const { rows: pendingUsers } = await pool.query(
    `SELECT wu.user_id FROM workspace_users wu
     WHERE wu.workspace_id = $1 AND wu.user_id = ANY($2) AND wu.billing_status = 'pending'`,
    [workspaceId, userIds]
  );

  if (pendingUsers.length !== userIds.length) {
    throw Object.assign(
      new Error("Some selected users are not pending or don't belong to this workspace"),
      { statusCode: 400 }
    );
  }

  const { keyId, keySecret } = getCredentials();

  const order = await rzpRequest("POST", "/orders", {
    amount:   cost.totalPaise,
    currency: "INR",
    receipt:  `activation_${workspaceId.slice(0, 8)}_${Date.now()}`,
    notes: {
      workspace_id: workspaceId,
      user_ids:     userIds.join(","),
      type:         "user_activation",
    },
  });

  // Log the pending payment
  await pool.query(
    `INSERT INTO user_activation_payments
       (workspace_id, user_ids, amount_paise, razorpay_order_id, status,
        pro_rated_days, cycle_start, cycle_end, created_by)
     VALUES ($1, $2, $3, $4, 'created', $5, $6, $7, $8)`,
    [
      workspaceId,
      userIds,
      cost.totalPaise,
      order.id,
      cost.proRatedDays,
      cost.cycleStart,
      cost.cycleEnd,
      createdBy || null,
    ]
  );

  return {
    orderId:    order.id,
    keyId,
    amountPaise: cost.totalPaise,
    currency:   "INR",
    cost,
  };
}

// ── Per-user billing: verify activation payment and activate users ────────────

export async function verifyAndActivateUsers(workspaceId, { orderId, paymentId, signature, userIds }) {
  // Verify HMAC signature: hash(orderId|paymentId)
  const { keySecret } = getCredentials();
  const expected = crypto
    .createHmac("sha256", keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

  if (expected !== signature) {
    throw Object.assign(new Error("Payment signature verification failed"), { statusCode: 400 });
  }

  // Look up the payment record
  const { rows: paymentRows } = await pool.query(
    `SELECT * FROM user_activation_payments
     WHERE workspace_id = $1 AND razorpay_order_id = $2 AND status = 'created'
     LIMIT 1`,
    [workspaceId, orderId]
  );
  if (!paymentRows[0]) {
    throw Object.assign(new Error("Activation payment record not found"), { statusCode: 404 });
  }
  const payment = paymentRows[0];
  const activatingUserIds = Array.isArray(userIds) && userIds.length > 0
    ? userIds
    : payment.user_ids;

  const cycleEnd = payment.cycle_end || new Date(Date.now() + 30 * 86400000).toISOString();
  const cycleStart = payment.cycle_start || new Date().toISOString();

  // Activate the users
  await pool.query(
    `UPDATE workspace_users
     SET billing_status = 'active',
         activated_at   = NOW(),
         cycle_start    = $3,
         cycle_end      = $4
     WHERE workspace_id = $1 AND user_id = ANY($2)`,
    [workspaceId, activatingUserIds, cycleStart, cycleEnd]
  );

  // Mark payment as paid
  await pool.query(
    `UPDATE user_activation_payments
     SET status = 'paid', razorpay_payment_id = $2, razorpay_signature = $3, updated_at = NOW()
     WHERE workspace_id = $1 AND razorpay_order_id = $4`,
    [workspaceId, paymentId, signature, orderId]
  );

  console.log(`[billing] ${activatingUserIds.length} user(s) activated workspace=${workspaceId}`);
  return { activated: activatingUserIds.length, cycleEnd };
}

// ── Billing summary ───────────────────────────────────────────────────────────

export async function getBillingSummary(workspaceId) {
  const [wsRes, subRes, memberCountRes] = await Promise.all([
    pool.query(
      `SELECT id, name, plan, billing_plan, billing_status, billing_provider,
              billing_subscription_id, billing_current_period_end, billing_updated_at,
              member_limit, max_members
       FROM workspaces WHERE id = $1 LIMIT 1`,
      [workspaceId]
    ),
    getWorkspaceSubscription(workspaceId),
    pool.query(
      `SELECT COUNT(*) AS count FROM workspace_users
       WHERE workspace_id = $1 AND billing_status != 'pending'`,
      [workspaceId]
    ),
  ]);

  return {
    config:            getPublicConfig(),
    workspace:         wsRes.rows[0] || null,
    subscription:      subRes,
    activeMemberCount: parseInt(memberCountRes.rows[0]?.count || 0),
  };
}
