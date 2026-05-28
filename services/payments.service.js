// services/payments.service.js
// =============================================================================
// Stripe integration — Hosted Checkout, Subscriptions, Billing Portal
// Supports international payments (USD, INR, and any Stripe-supported currency)
// =============================================================================
// Required env vars:
//   STRIPE_SECRET_KEY       — from Stripe Dashboard > API Keys
//   STRIPE_PUBLISHABLE_KEY  — from Stripe Dashboard > API Keys
//   STRIPE_WEBHOOK_SECRET   — from Stripe Dashboard > Webhooks
// Optional:
//   BILLING_SUCCESS_URL     — redirect after successful checkout
//   BILLING_CANCEL_URL      — redirect after cancelled checkout
//   BILLING_PORTAL_RETURN_URL — return URL from billing portal
//
// Flow:
//   1. Superadmin creates plan in Stripe Dashboard, gets Price IDs
//   2. Superadmin links Price IDs to DB plan via POST /superadmin/plans/:id/sync-stripe
//   3. Workspace admin subscribes → createCheckoutSession() returns hosted checkout URL
//   4. User completes payment on Stripe-hosted page, redirected back
//   5. Stripe sends webhook → processStripeWebhook() updates subscription state
// =============================================================================

import crypto from "crypto";
import axios from "axios";
import qs from "qs";
import db from "../db.js";
import {
  getPlanById,
  getPlanBySlug,
  getPlanByStripePriceId,
  saveStripePriceIds,
} from "../repositories/billingPlans.repository.js";

const STRIPE_API_BASE = "https://api.stripe.com";
const DEFAULT_FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

// ── Internal helpers ──────────────────────────────────────────────────────────

function getStripeSecretKey() {
  return process.env.STRIPE_SECRET_KEY || null;
}

function getStripeWebhookSecret() {
  return process.env.STRIPE_WEBHOOK_SECRET || null;
}

function ensureStripeConfigured() {
  if (!getStripeSecretKey()) {
    const err = new Error("Stripe is not configured. Set STRIPE_SECRET_KEY.");
    err.statusCode = 503;
    throw err;
  }
}

function resolveSuccessUrl(overrideUrl) {
  return (
    overrideUrl ||
    process.env.BILLING_SUCCESS_URL ||
    `${DEFAULT_FRONTEND_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`
  );
}

function resolveCancelUrl(overrideUrl) {
  return (
    overrideUrl ||
    process.env.BILLING_CANCEL_URL ||
    `${DEFAULT_FRONTEND_URL}/billing/cancelled`
  );
}

function resolvePortalReturnUrl(overrideUrl) {
  return (
    overrideUrl ||
    process.env.BILLING_PORTAL_RETURN_URL ||
    `${DEFAULT_FRONTEND_URL}/settings/billing`
  );
}

async function stripeRequest(method, path, { data, headers } = {}) {
  ensureStripeConfigured();

  const response = await axios({
    method,
    url: `${STRIPE_API_BASE}${path}`,
    headers: {
      Authorization: `Bearer ${getStripeSecretKey()}`,
      ...headers,
    },
    data,
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    const message =
      response.data?.error?.message ||
      `Stripe request failed with status ${response.status}`;
    const err = new Error(message);
    err.statusCode = response.status;
    err.details = response.data;
    throw err;
  }

  return response.data;
}

function stripeTimestampToIso(value) {
  if (!value) return null;
  return new Date(value * 1000).toISOString();
}

// ── Customer management ───────────────────────────────────────────────────────

async function upsertPaymentCustomer({ workspaceId, customerId, email, currency, metadata = {} }) {
  await db.query(
    `INSERT INTO payment_customers (workspace_id, provider, customer_id, email, currency, metadata, created_at, updated_at)
     VALUES ($1, 'stripe', $2, $3, $4, $5, now(), now())
     ON CONFLICT (workspace_id, provider)
     DO UPDATE SET
       customer_id = EXCLUDED.customer_id,
       email       = COALESCE(EXCLUDED.email, payment_customers.email),
       currency    = COALESCE(EXCLUDED.currency, payment_customers.currency),
       metadata    = payment_customers.metadata || EXCLUDED.metadata,
       updated_at  = now()`,
    [workspaceId, customerId, email || null, currency || null, metadata]
  );

  await db.query(
    `UPDATE workspaces
     SET billing_provider    = 'stripe',
         billing_customer_id = $2,
         billing_updated_at  = now()
     WHERE id = $1`,
    [workspaceId, customerId]
  );
}

export async function getOrCreateStripeCustomer({ workspace, user }) {
  const existingRes = await db.query(
    `SELECT customer_id, email
     FROM payment_customers
     WHERE workspace_id = $1 AND provider = 'stripe'
     LIMIT 1`,
    [workspace.id]
  );

  if (existingRes.rows[0]?.customer_id) {
    return {
      customerId: existingRes.rows[0].customer_id,
      email: existingRes.rows[0].email || user?.email || null,
    };
  }

  const payload = qs.stringify(
    {
      email: user?.email || undefined,
      name:  workspace.name,
      "metadata[workspace_id]":   workspace.id,
      "metadata[workspace_name]": workspace.name,
      "metadata[user_id]":        user?.id,
    },
    { encode: true }
  );

  const customer = await stripeRequest("post", "/v1/customers", {
    data: payload,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  await upsertPaymentCustomer({
    workspaceId: workspace.id,
    customerId:  customer.id,
    email:       customer.email || user?.email || null,
    currency:    customer.currency || null,
    metadata:    customer.metadata || {},
  });

  return {
    customerId: customer.id,
    email:      customer.email || user?.email || null,
  };
}

// ── Workspace billing state sync ──────────────────────────────────────────────

async function resolveBillingPlanForSubscription(subscription, price) {
  const metadataPlanId = subscription.metadata?.billing_plan_id || null;
  const metadataPlanById = metadataPlanId ? await getPlanById(metadataPlanId) : null;
  if (metadataPlanById) return metadataPlanById;

  const metadataSlug = subscription.metadata?.billing_plan || null;
  const metadataPlan = metadataSlug ? await getPlanBySlug(metadataSlug) : null;
  if (metadataPlan) return metadataPlan;

  return getPlanByStripePriceId(price?.id || null);
}

function isSubscriptionEntitled(status) {
  return ["active", "trialing"].includes(status);
}

function getPrimarySubscriptionItem(subscription) {
  const items = subscription?.items?.data || [];
  return items.find((item) => item?.price?.recurring) || items[0] || null;
}

function normalizeSeatQuantity(quantity) {
  const parsed = Number.parseInt(quantity, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

async function countBillableWorkspaceUsers(workspaceId) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM workspace_users wu
     JOIN users u ON u.id = wu.user_id
     WHERE wu.workspace_id = $1
       AND wu.billing_status != 'pending'
       AND (u.is_system IS NULL OR u.is_system = false)
       AND u.role != 'system'`,
    [workspaceId]
  );
  return normalizeSeatQuantity(rows[0]?.count || 1);
}

async function getStoredStripeSubscription(workspaceId) {
  const { rows } = await db.query(
    `SELECT subscription_id, subscription_item_id, seat_quantity, status
     FROM workspace_subscriptions
     WHERE workspace_id = $1 AND provider = 'stripe'
     LIMIT 1`,
    [workspaceId]
  );
  return rows[0] || null;
}

async function getStripeSubscriptionWithItems(subscriptionId) {
  return stripeRequest(
    "get",
    `/v1/subscriptions/${subscriptionId}?expand[]=items.data.price`
  );
}

export async function syncStripeSubscriptionSeatQuantity(
  workspaceId,
  {
    subscription = null,
    subscriptionId = null,
    targetQuantity = null,
    prorationBehavior = "none",
  } = {}
) {
  ensureStripeConfigured();

  const storedSubscription = await getStoredStripeSubscription(workspaceId);
  const resolvedSubscriptionId =
    subscriptionId ||
    subscription?.id ||
    storedSubscription?.subscription_id ||
    null;

  if (!resolvedSubscriptionId) {
    const err = new Error("No active Stripe subscription found for recurring seat sync");
    err.statusCode = 404;
    throw err;
  }

  const stripeSubscription =
    subscription && subscription.id === resolvedSubscriptionId
      ? subscription
      : await getStripeSubscriptionWithItems(resolvedSubscriptionId);

  if (!isSubscriptionEntitled(stripeSubscription.status)) {
    return {
      workspaceId,
      subscriptionId: resolvedSubscriptionId,
      skipped: true,
      reason: `Subscription is ${stripeSubscription.status}`,
    };
  }

  const item = getPrimarySubscriptionItem(stripeSubscription);
  const subscriptionItemId = item?.id || storedSubscription?.subscription_item_id || null;
  if (!subscriptionItemId) {
    const err = new Error("Stripe subscription item not found for recurring seat sync");
    err.statusCode = 409;
    throw err;
  }

  const currentQuantity = normalizeSeatQuantity(item?.quantity || storedSubscription?.seat_quantity);
  const seatQuantity = normalizeSeatQuantity(
    targetQuantity == null ? await countBillableWorkspaceUsers(workspaceId) : targetQuantity
  );

  let synced = false;
  if (currentQuantity !== seatQuantity) {
    const payload = qs.stringify(
      {
        quantity: seatQuantity,
        proration_behavior: prorationBehavior,
        "metadata[workspace_id]": workspaceId,
        "metadata[billable_user_count]": seatQuantity,
      },
      { encode: true }
    );

    await stripeRequest("post", `/v1/subscription_items/${subscriptionItemId}`, {
      data: payload,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    synced = true;
  }

  await db.query(
    `UPDATE workspace_subscriptions
     SET subscription_item_id      = COALESCE($2, subscription_item_id),
         seat_quantity            = $3,
         seat_quantity_synced_at  = now(),
         updated_at               = now()
     WHERE workspace_id = $1 AND provider = 'stripe'`,
    [workspaceId, subscriptionItemId, seatQuantity]
  );

  return {
    workspaceId,
    subscriptionId: resolvedSubscriptionId,
    subscriptionItemId,
    previousQuantity: currentQuantity,
    seatQuantity,
    synced,
    prorationBehavior,
  };
}

async function updateWorkspaceBillingState({
  workspaceId,
  plan,
  status,
  customerId,
  subscriptionId,
  currentPeriodStart,
  currentPeriodEnd,
}) {
  const isEntitled = isSubscriptionEntitled(status);
  const planSlug = isEntitled ? plan?.slug || null : null;
  const memberLimit = isEntitled ? plan?.member_limit || null : null;
  const perUserPricePaise = isEntitled ? plan?.price_monthly_paise || null : null;

  await db.query(
    `UPDATE workspaces
     SET billing_plan               = COALESCE($2, billing_plan),
         billing_status             = $3,
         billing_provider           = 'stripe',
         billing_customer_id        = COALESCE($4, billing_customer_id),
         billing_subscription_id    = COALESCE($5, billing_subscription_id),
         billing_current_period_end = COALESCE($6, billing_current_period_end),
         billing_updated_at         = now(),
         plan                       = COALESCE($2, plan),
         member_limit               = COALESCE($7, member_limit),
         max_members                = COALESCE($7, max_members),
         billing_cycle_anchor       = COALESCE($8, billing_cycle_anchor),
         per_user_price_paise       = COALESCE($9, per_user_price_paise),
         trial_started_at           = COALESCE(trial_started_at, now())
     WHERE id = $1`,
    [
      workspaceId,
      planSlug,
      status || null,
      customerId || null,
      subscriptionId || null,
      currentPeriodEnd || null,
      memberLimit,
      currentPeriodStart || null,
      perUserPricePaise,
    ]
  );
}

async function upsertSubscriptionFromStripe(subscription, explicitWorkspaceId = null) {
  const item  = getPrimarySubscriptionItem(subscription);
  const price = item?.price || null;
  const plan = await resolveBillingPlanForSubscription(subscription, price);
  const billingPlan = plan?.slug || subscription.metadata?.billing_plan || null;
  const subscriptionItemId = item?.id || null;
  const seatQuantity = normalizeSeatQuantity(item?.quantity || subscription.metadata?.seat_quantity);

  let workspaceId = explicitWorkspaceId || subscription.metadata?.workspace_id || null;

  if (!workspaceId && subscription.customer) {
    const res = await db.query(
      `SELECT workspace_id FROM payment_customers
       WHERE provider = 'stripe' AND customer_id = $1 LIMIT 1`,
      [String(subscription.customer)]
    );
    workspaceId = res.rows[0]?.workspace_id || null;
  }

  if (!workspaceId) {
    throw new Error(`Unable to resolve workspace for Stripe subscription ${subscription.id}`);
  }

  await db.query(
     `INSERT INTO workspace_subscriptions (
       workspace_id, provider, customer_id, subscription_id, status,
       billing_plan, billing_plan_id, billing_interval,
       price_id, product_id, currency, interval, cancel_at_period_end, trial_ends_at,
       current_period_start, current_period_end, subscription_item_id, seat_quantity,
       metadata, created_at, updated_at
     )
     VALUES ($1,'stripe',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,now(),now())
     ON CONFLICT (workspace_id, provider)
     DO UPDATE SET
       customer_id          = EXCLUDED.customer_id,
       subscription_id      = EXCLUDED.subscription_id,
       status               = EXCLUDED.status,
       billing_plan         = COALESCE(EXCLUDED.billing_plan, workspace_subscriptions.billing_plan),
       billing_plan_id      = COALESCE(EXCLUDED.billing_plan_id, workspace_subscriptions.billing_plan_id),
       billing_interval     = COALESCE(EXCLUDED.billing_interval, workspace_subscriptions.billing_interval),
       price_id             = EXCLUDED.price_id,
       product_id           = EXCLUDED.product_id,
       currency             = EXCLUDED.currency,
       interval             = EXCLUDED.interval,
       cancel_at_period_end = EXCLUDED.cancel_at_period_end,
       trial_ends_at        = EXCLUDED.trial_ends_at,
       current_period_start = EXCLUDED.current_period_start,
       current_period_end   = EXCLUDED.current_period_end,
       subscription_item_id = COALESCE(EXCLUDED.subscription_item_id, workspace_subscriptions.subscription_item_id),
       seat_quantity        = EXCLUDED.seat_quantity,
       metadata             = workspace_subscriptions.metadata || EXCLUDED.metadata,
       updated_at           = now()`,
    [
      workspaceId,
      subscription.customer ? String(subscription.customer) : null,
      subscription.id,
      subscription.status,
      billingPlan,
      plan?.id || null,
      price?.recurring?.interval || null,
      price?.id || null,
      price?.product ? String(price.product) : null,
      price?.currency || null,
      price?.recurring?.interval || null,
      !!subscription.cancel_at_period_end,
      stripeTimestampToIso(subscription.trial_end),
      stripeTimestampToIso(subscription.current_period_start),
      stripeTimestampToIso(subscription.current_period_end),
      subscriptionItemId,
      seatQuantity,
      subscription.metadata || {},
    ]
  );

  await updateWorkspaceBillingState({
    workspaceId,
    plan,
    status:          subscription.status,
    customerId:      subscription.customer ? String(subscription.customer) : null,
    subscriptionId:  subscription.id,
    currentPeriodStart: stripeTimestampToIso(subscription.current_period_start),
    currentPeriodEnd: stripeTimestampToIso(subscription.current_period_end),
  });

  // Activate trial users when subscription becomes active
  if (isSubscriptionEntitled(subscription.status)) {
    await db.query(
      `UPDATE workspace_users
       SET billing_status = 'active',
           activated_at   = now(),
           cycle_start    = $2,
           cycle_end      = $3
       WHERE workspace_id = $1 AND billing_status = 'trial'`,
      [
        workspaceId,
        stripeTimestampToIso(subscription.current_period_start) || new Date().toISOString(),
        stripeTimestampToIso(subscription.current_period_end) || null,
      ]
    );
  }

  return { workspaceId };
}

// ── Public config ─────────────────────────────────────────────────────────────

export function getPublicBillingConfig() {
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || null;
  const secretConfigured = !!getStripeSecretKey();
  const webhookConfigured = !!getStripeWebhookSecret();

  return {
    provider:         "stripe",
    publishableKey,
    checkoutEnabled:  secretConfigured,
    publishableKeySet: !!publishableKey,
    webhookConfigured,
    ready: secretConfigured && !!publishableKey && webhookConfigured,
  };
}

// ── Billing summary ───────────────────────────────────────────────────────────

export async function getWorkspaceBillingSummary(workspaceId) {
  const [workspaceRes, subscriptionRes, memberCountRes] = await Promise.all([
    db.query(
      `SELECT id, name, plan, billing_plan, billing_status, billing_provider,
              billing_customer_id, billing_subscription_id,
              billing_current_period_end, billing_updated_at,
              member_limit, max_members, billing_cycle_anchor, per_user_price_paise
       FROM workspaces WHERE id = $1 LIMIT 1`,
      [workspaceId]
    ),
    db.query(
      `SELECT ws.*, bp.name AS plan_name, bp.slug AS plan_slug,
              bp.price_monthly_paise, bp.price_yearly_paise,
              bp.member_limit AS plan_member_limit, bp.features, bp.support_level,
              bp.stripe_currency
       FROM workspace_subscriptions ws
       LEFT JOIN billing_plans bp
         ON (ws.billing_plan_id = bp.id OR ws.billing_plan = bp.slug)
       WHERE ws.workspace_id = $1 AND ws.provider = 'stripe'
       LIMIT 1`,
      [workspaceId]
    ),
    db.query(
      `SELECT COUNT(*) AS count
       FROM workspace_users wu
       JOIN users u ON u.id = wu.user_id
       WHERE wu.workspace_id = $1
         AND wu.billing_status != 'pending'
         AND (u.is_system IS NULL OR u.is_system = false)
         AND u.role != 'system'`,
      [workspaceId]
    ),
  ]);

  return {
    config:            getPublicBillingConfig(),
    workspace:         workspaceRes.rows[0] || null,
    subscription:      subscriptionRes.rows[0] || null,
    activeMemberCount: parseInt(memberCountRes.rows[0]?.count || 0),
  };
}

// ── Checkout session ──────────────────────────────────────────────────────────
// Creates a Stripe-hosted checkout session.
// Returns { url } — frontend redirects the user to this URL.

export async function createCheckoutSession({
  workspace,
  user,
  planId,          // DB UUID (preferred)
  plan,            // plan slug fallback
  interval = "monthly",
  successUrl,
  cancelUrl,
}) {
  ensureStripeConfigured();

  // Resolve plan and price ID from DB
  let dbPlan = null;
  if (planId) {
    dbPlan = await getPlanById(planId);
  } else if (plan) {
    dbPlan = await getPlanBySlug(plan);
  }

  if (!dbPlan) {
    const err = new Error(`Plan not found: ${planId || plan}`);
    err.statusCode = 404;
    throw err;
  }

  if (!dbPlan.is_active) {
    const err = new Error("This plan is no longer available");
    err.statusCode = 400;
    throw err;
  }

  // Free plan — no Stripe checkout needed
  const monthlyAmount = dbPlan.price_monthly_paise || 0;
  const yearlyAmount  = dbPlan.price_yearly_paise  || 0;
  if (monthlyAmount === 0 && yearlyAmount === 0) {
    const err = new Error("Free plan does not require a payment");
    err.statusCode = 400;
    throw err;
  }

  const priceId = interval === "yearly"
    ? dbPlan.stripe_price_yearly_id
    : dbPlan.stripe_price_monthly_id;

  if (!priceId) {
    const err = new Error(
      `No Stripe price configured for plan "${dbPlan.name}" (${interval}). ` +
      `Please sync this plan to Stripe via the superadmin panel.`
    );
    err.statusCode = 503;
    throw err;
  }

  const customer = await getOrCreateStripeCustomer({ workspace, user });
  const seatQuantity = await countBillableWorkspaceUsers(workspace.id);

  const subscriptionData = {
    "subscription_data[metadata][workspace_id]":  workspace.id,
    "subscription_data[metadata][user_id]":       user?.id || "",
    "subscription_data[metadata][billing_plan]":  dbPlan.slug,
    "subscription_data[metadata][billing_plan_id]": dbPlan.id,
    "subscription_data[metadata][seat_quantity]": seatQuantity,
  };
  if (dbPlan.trial_days > 0) {
    subscriptionData["subscription_data[trial_period_days]"] = dbPlan.trial_days;
  }

  const payload = qs.stringify(
    {
      mode:       "subscription",
      success_url: resolveSuccessUrl(successUrl),
      cancel_url:  resolveCancelUrl(cancelUrl),
      customer:    customer.customerId,
      "line_items[0][price]":    priceId,
      "line_items[0][quantity]": seatQuantity,
      allow_promotion_codes:      true,
      billing_address_collection: "auto",
      client_reference_id:        workspace.id,
      "metadata[workspace_id]":   workspace.id,
      "metadata[user_id]":        user?.id || "",
      "metadata[billing_plan]":   dbPlan.slug,
      "metadata[billing_plan_id]": dbPlan.id,
      "metadata[seat_quantity]":  seatQuantity,
      ...subscriptionData,
    },
    { encode: true }
  );

  const session = await stripeRequest("post", "/v1/checkout/sessions", {
    data:    payload,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  await db.query(
    `INSERT INTO payment_checkout_sessions (
       workspace_id, user_id, provider, checkout_session_id, customer_id,
       subscription_id, price_id, billing_plan, status, session_type,
       seat_quantity, success_url, cancel_url, metadata, created_at, updated_at
     )
     VALUES ($1,$2,'stripe',$3,$4,$5,$6,$7,$8,'subscription',$9,$10,$11,$12,now(),now())
     ON CONFLICT (provider, checkout_session_id)
     DO UPDATE SET
       customer_id     = EXCLUDED.customer_id,
       subscription_id = COALESCE(EXCLUDED.subscription_id, payment_checkout_sessions.subscription_id),
       price_id        = EXCLUDED.price_id,
       billing_plan    = EXCLUDED.billing_plan,
       status          = EXCLUDED.status,
       seat_quantity   = EXCLUDED.seat_quantity,
       success_url     = EXCLUDED.success_url,
       cancel_url      = EXCLUDED.cancel_url,
       metadata        = payment_checkout_sessions.metadata || EXCLUDED.metadata,
       updated_at      = now()`,
    [
      workspace.id,
      user?.id || null,
      session.id,
      customer.customerId,
      session.subscription ? String(session.subscription) : null,
      priceId,
      dbPlan.slug,
      session.status || "open",
      seatQuantity,
      resolveSuccessUrl(successUrl),
      resolveCancelUrl(cancelUrl),
      session,
    ]
  );

  return {
    id:       session.id,
    url:      session.url,
    plan:     dbPlan.slug,
    planName: dbPlan.name,
    interval,
    priceId,
    seatQuantity,
    trialDays: dbPlan.trial_days || 0,
  };
}

// ── Billing portal ────────────────────────────────────────────────────────────
// Returns a Stripe billing portal URL so the customer can manage/cancel.

export async function createBillingPortalSession({ workspaceId, returnUrl }) {
  ensureStripeConfigured();

  const res = await db.query(
    `SELECT customer_id FROM payment_customers
     WHERE workspace_id = $1 AND provider = 'stripe' LIMIT 1`,
    [workspaceId]
  );

  const customerId = res.rows[0]?.customer_id || null;
  if (!customerId) {
    const err = new Error("No Stripe customer found for this workspace yet.");
    err.statusCode = 404;
    throw err;
  }

  const payload = qs.stringify(
    {
      customer:   customerId,
      return_url: resolvePortalReturnUrl(returnUrl),
    },
    { encode: true }
  );

  const session = await stripeRequest("post", "/v1/billing_portal/sessions", {
    data:    payload,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  return { url: session.url };
}

// ── Cancel subscription ───────────────────────────────────────────────────────
// Cancels at period end (not immediately) to preserve access through paid period.

export async function cancelSubscription(workspaceId) {
  ensureStripeConfigured();

  const subRes = await db.query(
    `SELECT subscription_id, current_period_end
     FROM workspace_subscriptions
     WHERE workspace_id = $1 AND provider = 'stripe' LIMIT 1`,
    [workspaceId]
  );

  const subscriptionId = subRes.rows[0]?.subscription_id || null;
  if (!subscriptionId) {
    const err = new Error("No active Stripe subscription found for this workspace");
    err.statusCode = 404;
    throw err;
  }

  const payload = qs.stringify({ cancel_at_period_end: "true" }, { encode: true });
  const subscription = await stripeRequest("post", `/v1/subscriptions/${subscriptionId}`, {
    data:    payload,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  await db.query(
    `UPDATE workspace_subscriptions
     SET cancel_at_period_end = true, updated_at = now()
     WHERE workspace_id = $1 AND provider = 'stripe'`,
    [workspaceId]
  );

  return {
    cancelled:     true,
    effectiveDate: stripeTimestampToIso(subscription.current_period_end),
  };
}

// ── Per-user billing: list pending users ─────────────────────────────────────

export async function listPendingUsers(workspaceId) {
  const { rows } = await db.query(
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

export async function calculateActivationCost(workspaceId, userIds) {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    throw Object.assign(new Error("Select at least one user to activate"), { statusCode: 400 });
  }

  const wsRes = await db.query(
    `SELECT billing_cycle_anchor, per_user_price_paise FROM workspaces WHERE id = $1 LIMIT 1`,
    [workspaceId]
  );
  const ws = wsRes.rows[0];
  if (!ws) throw Object.assign(new Error("Workspace not found"), { statusCode: 404 });

  const subRes = await db.query(
    `SELECT sub.status, sub.current_period_start, sub.current_period_end,
            bp.price_monthly_paise
     FROM workspace_subscriptions sub
     LEFT JOIN billing_plans bp
       ON (sub.billing_plan_id = bp.id OR sub.billing_plan = bp.slug)
     WHERE sub.workspace_id = $1 AND sub.provider = 'stripe'
     LIMIT 1`,
    [workspaceId]
  );
  const sub = subRes.rows[0] || null;
  if (!sub || !isSubscriptionEntitled(sub.status)) {
    throw Object.assign(
      new Error("A live Stripe subscription is required before activating paid users."),
      { statusCode: 400 }
    );
  }

  let pricePerUser = ws.per_user_price_paise || sub.price_monthly_paise || null;
  if (!ws.billing_cycle_anchor && sub.current_period_start) {
    ws.billing_cycle_anchor = sub.current_period_start;
  }

  if (pricePerUser && pricePerUser > 0) {
    await db.query(
      `UPDATE workspaces
       SET per_user_price_paise = COALESCE(per_user_price_paise, $2),
           billing_cycle_anchor = COALESCE(billing_cycle_anchor, $3, now())
       WHERE id = $1`,
      [workspaceId, pricePerUser, ws.billing_cycle_anchor || null]
    );
  }

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
    const anchor = new Date(ws.billing_cycle_anchor);
    cycleEnd = new Date(anchor);
    while (cycleEnd <= now) {
      cycleEnd.setMonth(cycleEnd.getMonth() + 1);
    }
    cycleStart = new Date(cycleEnd);
    cycleStart.setMonth(cycleStart.getMonth() - 1);

    const msInCycle   = cycleEnd - cycleStart;
    const msRemaining = cycleEnd - now;
    daysInCycle  = Math.round(msInCycle / 86400000);
    proRatedDays = Math.ceil(msRemaining / 86400000);
  } else {
    cycleEnd = new Date(now);
    cycleEnd.setMonth(cycleEnd.getMonth() + 1);
    daysInCycle  = 30;
    proRatedDays = 30;
  }

  const pricePerUserProRated = Math.ceil((proRatedDays / daysInCycle) * pricePerUser);
  const totalAmount          = pricePerUserProRated * userIds.length;

  return {
    userCount:                 userIds.length,
    pricePerUserMonthlyPaise:  pricePerUser,
    pricePerUserProRatedPaise: pricePerUserProRated,
    proRatedDays,
    daysInCycle,
    totalAmount,
    cycleStart: cycleStart.toISOString(),
    cycleEnd:   cycleEnd.toISOString(),
  };
}

// ── Per-user billing: Stripe Checkout for activation payment ──────────────────
// Creates a one-time Stripe Checkout session to collect payment for activating users.
// Webhook (checkout.session.completed) activates the users on payment.

export async function createActivationCheckoutSession({
  workspace,
  user,
  userIds,
  successUrl,
  cancelUrl,
}) {
  ensureStripeConfigured();

  if (!Array.isArray(userIds) || userIds.length === 0) {
    throw Object.assign(new Error("Select at least one user to activate"), { statusCode: 400 });
  }

  // Validate that all users are pending in this workspace
  const { rows: pendingRows } = await db.query(
    `SELECT wu.user_id FROM workspace_users wu
     WHERE wu.workspace_id = $1 AND wu.user_id = ANY($2) AND wu.billing_status = 'pending'`,
    [workspace.id, userIds]
  );
  if (pendingRows.length !== userIds.length) {
    throw Object.assign(
      new Error("Some selected users are not pending or don't belong to this workspace"),
      { statusCode: 400 }
    );
  }

  const cost = await calculateActivationCost(workspace.id, userIds);

  // Look up the currency from the workspace subscription
  const subRes = await db.query(
    `SELECT COALESCE(ws.currency, bp.stripe_currency) AS currency
     FROM workspace_subscriptions ws
     LEFT JOIN billing_plans bp
       ON (ws.billing_plan_id = bp.id OR ws.billing_plan = bp.slug)
     WHERE ws.workspace_id = $1 AND ws.provider = 'stripe'
     LIMIT 1`,
    [workspace.id]
  );
  const currency = subRes.rows[0]?.currency || "usd";

  const customer = await getOrCreateStripeCustomer({ workspace, user });
  const seatQuantityBefore = await countBillableWorkspaceUsers(workspace.id);
  const seatQuantityAfter = seatQuantityBefore + userIds.length;

  const description =
    `Pro-rated activation for ${userIds.length} user${userIds.length > 1 ? "s" : ""} ` +
    `(${cost.proRatedDays} of ${cost.daysInCycle} days remaining in billing cycle)`;

  const payload = qs.stringify(
    {
      mode:       "payment",
      success_url: resolveSuccessUrl(successUrl),
      cancel_url:  resolveCancelUrl(cancelUrl),
      customer:    customer.customerId,
      "line_items[0][quantity]": 1,
      "line_items[0][price_data][currency]":                              currency,
      "line_items[0][price_data][unit_amount]":                           cost.totalAmount,
      "line_items[0][price_data][product_data][name]":                    `User Activation (${userIds.length} user${userIds.length > 1 ? "s" : ""})`,
      "line_items[0][price_data][product_data][description]":             description,
      client_reference_id:                workspace.id,
      "metadata[workspace_id]":           workspace.id,
      "metadata[user_id]":                user?.id || "",
      "metadata[session_type]":           "user_activation",
      "metadata[activation_user_ids]":    userIds.join(","),
      "metadata[cycle_start]":            cost.cycleStart,
      "metadata[cycle_end]":              cost.cycleEnd,
      "metadata[seat_quantity_before]":   seatQuantityBefore,
      "metadata[seat_quantity_after]":    seatQuantityAfter,
    },
    { encode: true }
  );

  const session = await stripeRequest("post", "/v1/checkout/sessions", {
    data:    payload,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  await db.query(
    `INSERT INTO payment_checkout_sessions (
       workspace_id, user_id, provider, checkout_session_id, customer_id,
       billing_plan, status, session_type, activation_user_ids,
       seat_quantity, success_url, cancel_url, metadata, created_at, updated_at
     )
     VALUES ($1,$2,'stripe',$3,$4,'activation',$5,'activation',$6,$7,$8,$9,$10,now(),now())
     ON CONFLICT (provider, checkout_session_id) DO NOTHING`,
    [
      workspace.id,
      user?.id || null,
      session.id,
      customer.customerId,
      session.status || "open",
      userIds,
      seatQuantityAfter,
      resolveSuccessUrl(successUrl),
      resolveCancelUrl(cancelUrl),
      session,
    ]
  );

  await db.query(
    `INSERT INTO user_activation_payments (
       workspace_id, user_ids, amount_paise, provider, checkout_session_id,
       status, pro_rated_days, cycle_start, cycle_end, seat_quantity_before,
       seat_quantity_after, created_by, created_at, updated_at
     )
     VALUES ($1,$2,$3,'stripe',$4,'created',$5,$6,$7,$8,$9,$10,now(),now())
     ON CONFLICT DO NOTHING`,
    [
      workspace.id,
      userIds,
      cost.totalAmount,
      session.id,
      cost.proRatedDays,
      cost.cycleStart,
      cost.cycleEnd,
      seatQuantityBefore,
      seatQuantityAfter,
      user?.id || null,
    ]
  );

  return {
    id:          session.id,
    url:         session.url,
    userCount:   userIds.length,
    totalAmount: cost.totalAmount,
    currency,
    seatQuantityBefore,
    seatQuantityAfter,
    cost,
  };
}

function normalizeStripeCurrency(currency) {
  return String(currency || process.env.STRIPE_DEFAULT_CURRENCY || "usd").trim().toLowerCase();
}

async function createStripeProductForPlan(plan) {
  const payload = qs.stringify(
    {
      name: plan.name,
      description: plan.description || plan.tagline || undefined,
      "metadata[billing_plan_id]": plan.id,
      "metadata[billing_plan_slug]": plan.slug,
    },
    { encode: true }
  );

  return stripeRequest("post", "/v1/products", {
    data: payload,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

async function createStripeRecurringPriceForPlan({ plan, productId, interval, amount, currency }) {
  const payload = qs.stringify(
    {
      product: productId,
      unit_amount: amount,
      currency,
      "recurring[interval]": interval === "yearly" ? "year" : "month",
      "metadata[billing_plan_id]": plan.id,
      "metadata[billing_plan_slug]": plan.slug,
      "metadata[billing_interval]": interval,
    },
    { encode: true }
  );

  return stripeRequest("post", "/v1/prices", {
    data: payload,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

// ── Superadmin: sync plan to Stripe ──────────────────────────────────────────
// Creates missing Stripe Product/Price records, or verifies supplied Price IDs.

export async function syncPlanToStripe(
  planId,
  {
    monthlyPriceId,
    yearlyPriceId,
    productId,
    currency,
    createMissing = true,
    replaceExisting = false,
  } = {}
) {
  const plan = await getPlanById(planId);
  if (!plan) throw Object.assign(new Error("Plan not found"), { statusCode: 404 });
  if (!plan.is_active) throw Object.assign(new Error("Cannot sync inactive plan"), { statusCode: 400 });

  // Optionally verify the price IDs exist in Stripe before saving
  ensureStripeConfigured();

  let resolvedProductId = productId || plan.stripe_product_id || null;
  let resolvedCurrency = normalizeStripeCurrency(currency || plan.stripe_currency);
  let resolvedMonthlyPriceId = monthlyPriceId || (!replaceExisting ? plan.stripe_price_monthly_id : null);
  let resolvedYearlyPriceId = yearlyPriceId || (!replaceExisting ? plan.stripe_price_yearly_id : null);
  const created = { product: false, monthlyPrice: false, yearlyPrice: false };

  if (resolvedMonthlyPriceId) {
    const price = await stripeRequest("get", `/v1/prices/${resolvedMonthlyPriceId}`);
    resolvedProductId ||= price.product ? String(price.product) : null;
    resolvedCurrency ||= price.currency || null;
  }
  if (resolvedYearlyPriceId) {
    const price = await stripeRequest("get", `/v1/prices/${resolvedYearlyPriceId}`);
    resolvedProductId ||= price.product ? String(price.product) : null;
    resolvedCurrency ||= price.currency || null;
  }

  const monthlyAmount = Math.round(Number(plan.price_monthly_paise) || 0);
  const yearlyAmount = Math.round(Number(plan.price_yearly_paise) || 0);
  const needsMonthly = monthlyAmount > 0 && (replaceExisting || !resolvedMonthlyPriceId);
  const needsYearly = yearlyAmount > 0 && (replaceExisting || !resolvedYearlyPriceId);

  if (createMissing && (needsMonthly || needsYearly) && !resolvedProductId) {
    const product = await createStripeProductForPlan(plan);
    resolvedProductId = product.id;
    created.product = true;
  }

  if (createMissing && needsMonthly) {
    if (!resolvedProductId) {
      throw Object.assign(new Error("Stripe product is required before creating monthly price"), { statusCode: 400 });
    }
    const price = await createStripeRecurringPriceForPlan({
      plan,
      productId: resolvedProductId,
      interval: "monthly",
      amount: monthlyAmount,
      currency: resolvedCurrency,
    });
    resolvedMonthlyPriceId = price.id;
    resolvedCurrency = price.currency || resolvedCurrency;
    created.monthlyPrice = true;
  }

  if (createMissing && needsYearly) {
    if (!resolvedProductId) {
      throw Object.assign(new Error("Stripe product is required before creating yearly price"), { statusCode: 400 });
    }
    const price = await createStripeRecurringPriceForPlan({
      plan,
      productId: resolvedProductId,
      interval: "yearly",
      amount: yearlyAmount,
      currency: resolvedCurrency,
    });
    resolvedYearlyPriceId = price.id;
    resolvedCurrency = price.currency || resolvedCurrency;
    created.yearlyPrice = true;
  }

  if (!resolvedMonthlyPriceId && !resolvedYearlyPriceId && (monthlyAmount > 0 || yearlyAmount > 0)) {
    throw Object.assign(
      new Error("No Stripe prices available. Provide Price IDs or allow createMissing=true."),
      { statusCode: 400 }
    );
  }

  const saved = await saveStripePriceIds(plan.id, {
    productId: resolvedProductId,
    monthly:   resolvedMonthlyPriceId || null,
    yearly:    resolvedYearlyPriceId  || null,
    currency:  resolvedCurrency,
  });

  return {
    ...saved,
    stripe_sync: {
      created,
      createMissing: !!createMissing,
      replaceExisting: !!replaceExisting,
    },
  };
}

// ── Webhook verification ──────────────────────────────────────────────────────

export function verifyStripeWebhookSignature(rawBody, signatureHeader) {
  const webhookSecret = getStripeWebhookSecret();
  if (!webhookSecret) {
    throw Object.assign(new Error("Stripe webhook secret is not configured."), { statusCode: 503 });
  }
  if (!rawBody || !signatureHeader) {
    throw Object.assign(new Error("Missing Stripe webhook payload or signature."), { statusCode: 400 });
  }

  const parts     = signatureHeader.split(",").map((p) => p.trim());
  const timestamp = parts.find((p) => p.startsWith("t="))?.slice(2);
  const signatures = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));

  if (!timestamp || signatures.length === 0) {
    throw Object.assign(new Error("Invalid Stripe signature header."), { statusCode: 400 });
  }

  const payload  = `${timestamp}.${rawBody.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", webhookSecret).update(payload, "utf8").digest("hex");

  const isValid = signatures.some((sig) => {
    const a = Buffer.from(sig,      "hex");
    const b = Buffer.from(expected, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });

  if (!isValid) {
    throw Object.assign(new Error("Stripe webhook signature verification failed."), { statusCode: 400 });
  }

  return JSON.parse(rawBody.toString("utf8"));
}

// ── Webhook event handlers ────────────────────────────────────────────────────

async function persistWebhookEvent(event) {
  const inserted = await db.query(
    `INSERT INTO payment_webhook_events (
       provider, provider_event_id, event_type, api_version, livemode, payload, created_at
     )
     VALUES ('stripe', $1, $2, $3, $4, $5, now())
     ON CONFLICT (provider, provider_event_id) DO NOTHING
     RETURNING id, processed_at, processing_error`,
    [event.id, event.type, event.api_version || null, !!event.livemode, event]
  );

  if (inserted.rowCount > 0) {
    return { shouldProcess: true, duplicate: false };
  }

  const existing = await db.query(
    `SELECT processed_at, processing_error
     FROM payment_webhook_events
     WHERE provider = 'stripe' AND provider_event_id = $1
     LIMIT 1`,
    [event.id]
  );
  const row = existing.rows[0];
  return {
    shouldProcess: !row?.processed_at || !!row?.processing_error,
    duplicate: true,
  };
}

async function markWebhookEventProcessed(eventId) {
  await db.query(
    `UPDATE payment_webhook_events
     SET processed_at = now(), processing_error = null
     WHERE provider = 'stripe' AND provider_event_id = $1`,
    [eventId]
  );
}

async function markWebhookEventFailed(eventId, processingError) {
  await db.query(
    `UPDATE payment_webhook_events
     SET processed_at = null, processing_error = $2
     WHERE provider = 'stripe' AND provider_event_id = $1`,
    [eventId, processingError]
  );
}

async function updateCheckoutSessionRecord(session, status = null) {
  await db.query(
    `UPDATE payment_checkout_sessions
     SET status          = $2,
         customer_id     = COALESCE($3, customer_id),
         subscription_id = COALESCE($4, subscription_id),
         completed_at    = CASE WHEN $2 IN ('complete', 'paid') THEN now() ELSE completed_at END,
         metadata        = metadata || $5,
         updated_at      = now()
     WHERE provider = 'stripe' AND checkout_session_id = $1`,
    [
      session.id,
      status || session.status || "complete",
      session.customer ? String(session.customer) : null,
      session.subscription ? String(session.subscription) : null,
      session,
    ]
  );
}

async function activateUsersFromCheckoutSession(session) {
  const workspaceId = session.metadata?.workspace_id || session.client_reference_id || null;
  const userIdsStr = session.metadata?.activation_user_ids || "";
  const userIds = userIdsStr ? userIdsStr.split(",").filter(Boolean) : [];
  const cycleStart = session.metadata?.cycle_start || new Date().toISOString();
  const cycleEnd = session.metadata?.cycle_end || new Date(Date.now() + 30 * 86400000).toISOString();

  if (session.payment_status && session.payment_status !== "paid") {
    await updateCheckoutSessionRecord(session, "awaiting_payment");
    return;
  }

  if (userIds.length > 0 && workspaceId) {
    await db.query(
      `UPDATE workspace_users
       SET billing_status = 'active',
           activated_at   = now(),
           cycle_start    = $3,
           cycle_end      = $4
       WHERE workspace_id = $1 AND user_id = ANY($2)`,
      [workspaceId, userIds, cycleStart, cycleEnd]
    );

    const seatSync = await syncStripeSubscriptionSeatQuantity(workspaceId, {
      prorationBehavior: "none",
    });
    if (seatSync.skipped) {
      throw Object.assign(
        new Error(`Recurring seat sync skipped: ${seatSync.reason}`),
        { statusCode: 409 }
      );
    }

    await db.query(
      `UPDATE user_activation_payments
       SET status = 'paid',
           payment_intent_id = COALESCE($2, payment_intent_id),
           seat_quantity_after = COALESCE($3, seat_quantity_after),
           subscription_item_id = COALESCE($4, subscription_item_id),
           subscription_quantity_synced_at = now(),
           updated_at = now()
       WHERE provider = 'stripe' AND checkout_session_id = $1`,
      [
        session.id,
        session.payment_intent ? String(session.payment_intent) : null,
        seatSync.seatQuantity || null,
        seatSync.subscriptionItemId || null,
      ]
    );
    await updateCheckoutSessionRecord(session, "paid");
    console.log(
      `[billing] activation: ${userIds.length} user(s) activated workspace=${workspaceId} ` +
      `seats=${seatSync.previousQuantity}->${seatSync.seatQuantity}`
    );
  }
}

async function handleCheckoutSessionCompleted(event) {
  const session = event.data?.object;
  if (!session?.id) return;

  const workspaceId = session.metadata?.workspace_id || session.client_reference_id || null;
  const sessionType = session.metadata?.session_type || "subscription";

  await updateCheckoutSessionRecord(session);

  if (workspaceId && session.customer) {
    await upsertPaymentCustomer({
      workspaceId,
      customerId: String(session.customer),
      email:      session.customer_details?.email || null,
      currency:   session.currency || null,
      metadata:   session.metadata || {},
    });
  }

  // User-activation one-time payment
  if (sessionType === "user_activation") {
    await activateUsersFromCheckoutSession(session);
    return;
  }

  // Subscription checkout — fetch and upsert the subscription
  if (session.subscription) {
    const subscription = await stripeRequest(
      "get",
      `/v1/subscriptions/${session.subscription}?expand[]=items.data.price`
    );
    await upsertSubscriptionFromStripe(subscription, workspaceId);
  }
}

async function handleCheckoutSessionAsyncPaymentSucceeded(event) {
  const session = event.data?.object;
  if (!session?.id) return;

  await updateCheckoutSessionRecord(session, "paid");
  if ((session.metadata?.session_type || "subscription") === "user_activation") {
    await activateUsersFromCheckoutSession(session);
  }
}

async function handleCheckoutSessionAsyncPaymentFailed(event) {
  const session = event.data?.object;
  if (!session?.id) return;
  await updateCheckoutSessionRecord(session, "payment_failed");
  await db.query(
    `UPDATE user_activation_payments
     SET status = 'failed',
         payment_intent_id = COALESCE($2, payment_intent_id),
         updated_at = now()
     WHERE provider = 'stripe' AND checkout_session_id = $1`,
    [session.id, session.payment_intent ? String(session.payment_intent) : null]
  );
}

async function handleCheckoutSessionExpired(event) {
  const session = event.data?.object;
  if (!session?.id) return;
  await updateCheckoutSessionRecord(session, "expired");
  await db.query(
    `UPDATE user_activation_payments
     SET status = 'expired', updated_at = now()
     WHERE provider = 'stripe' AND checkout_session_id = $1`,
    [session.id]
  );
}

async function handleSubscriptionEvent(event) {
  const subscription = event.data?.object;
  if (!subscription?.id) return;
  await upsertSubscriptionFromStripe(subscription);
}

async function handleInvoiceSubscriptionSync(event) {
  const invoice = event.data?.object;
  const subscriptionId = invoice?.subscription ? String(invoice.subscription) : null;
  if (!subscriptionId) return;

  const subscription = await stripeRequest(
    "get",
    `/v1/subscriptions/${subscriptionId}?expand[]=items.data.price`
  );
  await upsertSubscriptionFromStripe(subscription);
}

async function handleSubscriptionDeleted(event) {
  const subscription = event.data?.object;
  if (!subscription?.id) return;

  const res = await db.query(
    `SELECT workspace_id FROM workspace_subscriptions
     WHERE provider = 'stripe' AND subscription_id = $1 LIMIT 1`,
    [subscription.id]
  );

  const workspaceId =
    subscription.metadata?.workspace_id ||
    res.rows[0]?.workspace_id ||
    null;

  if (!workspaceId) return;

  await db.query(
    `UPDATE workspace_subscriptions
     SET status               = 'canceled',
         cancel_at_period_end = false,
         current_period_end   = COALESCE($2, current_period_end),
         updated_at           = now()
     WHERE workspace_id = $1 AND provider = 'stripe'`,
    [workspaceId, stripeTimestampToIso(subscription.current_period_end)]
  );

  const starterPlan = await getPlanBySlug("starter");
  const starterLimit = starterPlan?.member_limit || 10;

  // Downgrade to the free starter plan
  await db.query(
    `UPDATE workspaces
     SET billing_status = 'active',
         billing_plan   = 'starter',
         plan           = 'starter',
         member_limit   = $2,
         max_members    = $2,
         billing_updated_at = now()
     WHERE id = $1`,
    [workspaceId, starterLimit]
  );

  console.log(`[billing] subscription.deleted workspace=${workspaceId} — downgraded to Starter`);
}

export async function processStripeWebhook(rawBody, signatureHeader) {
  const event = verifyStripeWebhookSignature(rawBody, signatureHeader);
  const persisted = await persistWebhookEvent(event);

  if (!persisted.shouldProcess) {
    return { duplicate: true, eventId: event.id, type: event.type };
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutSessionCompleted(event);
        break;
      case "checkout.session.async_payment_succeeded":
        await handleCheckoutSessionAsyncPaymentSucceeded(event);
        break;
      case "checkout.session.async_payment_failed":
        await handleCheckoutSessionAsyncPaymentFailed(event);
        break;
      case "checkout.session.expired":
        await handleCheckoutSessionExpired(event);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
        await handleSubscriptionEvent(event);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event);
        break;
      case "invoice.payment_succeeded":
      case "invoice.payment_failed":
      case "invoice.paid":
        await handleInvoiceSubscriptionSync(event);
        break;
      default:
        break;
    }

    await markWebhookEventProcessed(event.id);
    return { received: true, eventId: event.id, type: event.type };
  } catch (error) {
    await markWebhookEventFailed(event.id, error.message);
    throw error;
  }
}
