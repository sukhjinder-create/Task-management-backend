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
  getPlanByRazorpayPlanId,
  getPlanBySlug,
  getPlanByStripePriceId,
  saveRazorpayPlanIds,
  saveStripePriceIds,
} from "../repositories/billingPlans.repository.js";
import { getUserByEmail, getUserById } from "../repositories/user.repository.js";
import {
  cleanRequiredString,
  createSelfServeTrialWorkspace,
  generateToken,
  normalizeSignupEmail,
  validateSignupPassword,
} from "./auth.service.js";

const STRIPE_API_BASE = "https://api.stripe.com";
const RAZORPAY_API_BASE = "https://api.razorpay.com/v1";
const DEFAULT_FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const TRIAL_SIGNUP_SESSION_TYPE = "trial_signup";

// ── Internal helpers ──────────────────────────────────────────────────────────

function getStripeSecretKey() {
  return process.env.STRIPE_SECRET_KEY || null;
}

function getStripeWebhookSecret() {
  return process.env.STRIPE_WEBHOOK_SECRET || null;
}

function getRazorpayKeyId() {
  return process.env.RAZORPAY_KEY_ID || null;
}

function getRazorpayKeySecret() {
  return process.env.RAZORPAY_KEY_SECRET || null;
}

function getRazorpayWebhookSecret() {
  return process.env.RAZORPAY_WEBHOOK_SECRET || null;
}

function ensureStripeConfigured() {
  if (!getStripeSecretKey()) {
    const err = new Error("Stripe is not configured. Set STRIPE_SECRET_KEY.");
    err.statusCode = 503;
    throw err;
  }
}

function ensureRazorpayConfigured() {
  if (!getRazorpayKeyId() || !getRazorpayKeySecret()) {
    const err = new Error("Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.");
    err.statusCode = 503;
    throw err;
  }
}

function isRazorpayLiveMode() {
  return String(getRazorpayKeyId() || "").startsWith("rzp_live_");
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

async function razorpayRequest(method, path, { data, headers } = {}) {
  ensureRazorpayConfigured();

  const response = await axios({
    method,
    url: `${RAZORPAY_API_BASE}${path}`,
    auth: {
      username: getRazorpayKeyId(),
      password: getRazorpayKeySecret(),
    },
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    data,
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    const message =
      response.data?.error?.description ||
      response.data?.error?.reason ||
      response.data?.error?.code ||
      `Razorpay request failed with status ${response.status}`;
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

function razorpayTimestampToIso(value) {
  if (!value) return null;
  return new Date(Number(value) * 1000).toISOString();
}

function getBackendPublicUrl() {
  if (process.env.API_PUBLIC_URL) return process.env.API_PUBLIC_URL.replace(/\/+$/, "");
  if (process.env.BACKEND_PUBLIC_URL) return process.env.BACKEND_PUBLIC_URL.replace(/\/+$/, "");
  if (process.env.GOOGLE_CALLBACK_URL) {
    try {
      return new URL(process.env.GOOGLE_CALLBACK_URL).origin;
    } catch {}
  }
  return "http://localhost:3000";
}

function resolveTrialSignupSuccessUrl(overrideUrl) {
  return (
    overrideUrl ||
    process.env.TRIAL_SIGNUP_SUCCESS_URL ||
    `${getBackendPublicUrl()}/auth/signup/workspace/complete/redirect?session_id={CHECKOUT_SESSION_ID}`
  );
}

function resolveTrialSignupCancelUrl(overrideUrl) {
  return (
    overrideUrl ||
    process.env.TRIAL_SIGNUP_CANCEL_URL ||
    `${DEFAULT_FRONTEND_URL}/signup?cancelled=1`
  );
}

function normalizeBillingInterval(interval) {
  return interval === "yearly" ? "yearly" : "monthly";
}

function getTrialSignupCurrency(plan, provider = "stripe") {
  const planCurrency =
    provider === "razorpay"
      ? plan?.razorpay_currency || plan?.stripe_currency
      : plan?.stripe_currency;
  return String(process.env.TRIAL_SIGNUP_CURRENCY || planCurrency || "inr")
    .trim()
    .toLowerCase();
}

function getTrialSignupVerificationAmount(currency, provider = "stripe") {
  const parsed = Number.parseInt(process.env.TRIAL_SIGNUP_VERIFICATION_AMOUNT || "", 10);
  const amount = Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
  if (provider === "razorpay" && currency === "inr") return Math.max(amount, 100);
  if (currency === "inr") return Math.max(amount, 50);
  return amount;
}

function getTrialSignupPlanSlug() {
  return String(process.env.TRIAL_SIGNUP_PLAN_SLUG || "pro").trim().toLowerCase();
}

function getConfiguredPaymentsProvider() {
  const provider = String(
    process.env.PAYMENTS_PROVIDER ||
      process.env.TRIAL_SIGNUP_PAYMENT_PROVIDER ||
      "stripe"
  ).toLowerCase();
  if (provider === "razorpay" && getRazorpayKeyId() && getRazorpayKeySecret()) return "razorpay";
  return "stripe";
}

function assertTrialSignupConsent(consentAccepted) {
  if (consentAccepted !== true) {
    throw Object.assign(
      new Error("You must consent to automatic billing after the trial and the refundable card verification charge."),
      { statusCode: 400 }
    );
  }
}

async function findActivePendingTrialSignup({ email }) {
  const { rows } = await db.query(
    `SELECT id, checkout_session_id, status, owner_email, created_at
     FROM trial_signup_checkout_sessions
     WHERE created_at > now() - interval '24 hours'
       AND status IN ('created', 'open', 'complete', 'authenticated', 'payment_captured')
       AND lower(owner_email) = lower($1)
     ORDER BY created_at DESC
     LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

async function ensurePlanStripePricesForCurrency(plan, currency) {
  const monthlyAmount = Math.round(Number(plan.price_monthly_paise) || 0);
  const yearlyAmount  = Math.round(Number(plan.price_yearly_paise) || 0);
  if (monthlyAmount <= 0 && yearlyAmount <= 0) {
    throw Object.assign(new Error("Trial signup requires a paid Stripe plan."), { statusCode: 400 });
  }

  const currentCurrency = String(plan.stripe_currency || "").toLowerCase();
  const needsCurrencyRefresh = currentCurrency !== currency;
  let productId = plan.stripe_product_id || null;
  let monthlyPriceId = needsCurrencyRefresh ? null : plan.stripe_price_monthly_id || null;
  let yearlyPriceId = needsCurrencyRefresh ? null : plan.stripe_price_yearly_id || null;
  const created = { product: false, monthlyPrice: false, yearlyPrice: false };

  if (!productId) {
    const product = await createStripeProductForPlan(plan);
    productId = product.id;
    created.product = true;
  }

  if (monthlyAmount > 0 && !monthlyPriceId) {
    const price = await createStripeRecurringPriceForPlan({
      plan,
      productId,
      interval: "monthly",
      amount: monthlyAmount,
      currency,
    });
    monthlyPriceId = price.id;
    created.monthlyPrice = true;
  }

  if (yearlyAmount > 0 && !yearlyPriceId) {
    const price = await createStripeRecurringPriceForPlan({
      plan,
      productId,
      interval: "yearly",
      amount: yearlyAmount,
      currency,
    });
    yearlyPriceId = price.id;
    created.yearlyPrice = true;
  }

  if (created.product || created.monthlyPrice || created.yearlyPrice || needsCurrencyRefresh) {
    await saveStripePriceIds(plan.id, {
      productId,
      monthly: monthlyPriceId,
      yearly: yearlyPriceId,
      currency,
    });
  }

  return {
    monthlyPriceId,
    yearlyPriceId,
    created,
  };
}

function getRazorpayPlanPeriod(interval) {
  return normalizeBillingInterval(interval) === "yearly" ? "yearly" : "monthly";
}

async function createRazorpayPlanForBillingPlan({ plan, interval, amount, currency }) {
  const billingInterval = normalizeBillingInterval(interval);
  return razorpayRequest("post", "/plans", {
    data: {
      period: getRazorpayPlanPeriod(billingInterval),
      interval: 1,
      item: {
        name: `${plan.name} (${billingInterval})`,
        amount,
        currency: String(currency).toUpperCase(),
        description: plan.description || plan.tagline || `${plan.name} ${billingInterval} subscription`,
      },
      notes: {
        billing_plan_id: plan.id,
        billing_plan: plan.slug,
        billing_interval: billingInterval,
        source: "asystence",
      },
    },
  });
}

async function ensurePlanRazorpayPlanForCurrency(plan, currency, interval) {
  const billingInterval = normalizeBillingInterval(interval);
  const amount =
    billingInterval === "yearly"
      ? Math.round(Number(plan.price_yearly_paise) || 0)
      : Math.round(Number(plan.price_monthly_paise) || 0);
  if (amount <= 0) {
    throw Object.assign(new Error("Trial signup requires a paid Razorpay plan."), { statusCode: 400 });
  }

  const currentCurrency = String(plan.razorpay_currency || "").toLowerCase();
  const needsCurrencyRefresh = currentCurrency !== currency;
  let monthlyPlanId = needsCurrencyRefresh ? null : plan.razorpay_plan_monthly_id || null;
  let yearlyPlanId = needsCurrencyRefresh ? null : plan.razorpay_plan_yearly_id || null;
  const existingPlanId = billingInterval === "yearly" ? yearlyPlanId : monthlyPlanId;

  if (existingPlanId) {
    return {
      planId: existingPlanId,
      monthlyPlanId,
      yearlyPlanId,
      created: false,
    };
  }

  const razorpayPlan = await createRazorpayPlanForBillingPlan({
    plan,
    interval: billingInterval,
    amount,
    currency,
  });

  if (billingInterval === "yearly") yearlyPlanId = razorpayPlan.id;
  else monthlyPlanId = razorpayPlan.id;

  await saveRazorpayPlanIds(plan.id, {
    monthly: monthlyPlanId,
    yearly: yearlyPlanId,
    currency,
  });

  return {
    planId: razorpayPlan.id,
    monthlyPlanId,
    yearlyPlanId,
    created: true,
  };
}

function getExpandedSubscriptionFromSession(session) {
  return typeof session?.subscription === "object" ? session.subscription : null;
}

function getPaymentIntentIdFromSubscription(subscription) {
  const invoice = subscription?.latest_invoice;
  const paymentIntent = invoice?.payment_intent;
  if (!paymentIntent) return null;
  return typeof paymentIntent === "string" ? paymentIntent : paymentIntent.id || null;
}

// ── Customer management ───────────────────────────────────────────────────────

async function upsertPaymentCustomer({ workspaceId, customerId, email, currency, metadata = {}, provider = "stripe" }) {
  await db.query(
    `INSERT INTO payment_customers (workspace_id, provider, customer_id, email, currency, metadata, created_at, updated_at)
     VALUES ($1, $6, $2, $3, $4, $5, now(), now())
     ON CONFLICT (workspace_id, provider)
     DO UPDATE SET
       customer_id = EXCLUDED.customer_id,
       email       = COALESCE(EXCLUDED.email, payment_customers.email),
       currency    = COALESCE(EXCLUDED.currency, payment_customers.currency),
       metadata    = payment_customers.metadata || EXCLUDED.metadata,
       updated_at  = now()`,
    [workspaceId, customerId, email || null, currency || null, metadata, provider]
  );

  await db.query(
    `UPDATE workspaces
     SET billing_provider    = $3,
         billing_customer_id = $2,
         billing_updated_at  = now()
     WHERE id = $1`,
    [workspaceId, customerId, provider]
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
  return ["active", "trialing", "authenticated"].includes(status);
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
    `/v1/subscriptions/${subscriptionId}` +
      `?expand[]=items.data.price` +
      `&expand[]=latest_invoice.payment_intent`
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
  provider = "stripe",
}) {
  const isEntitled = isSubscriptionEntitled(status);
  const planSlug = isEntitled ? plan?.slug || null : null;
  const memberLimit = isEntitled ? plan?.member_limit || null : null;
  const perUserPricePaise = isEntitled ? plan?.price_monthly_paise || null : null;

  await db.query(
    `UPDATE workspaces
     SET billing_plan               = COALESCE($2, billing_plan),
         billing_status             = $3,
         billing_provider           = $10,
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
      provider,
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
  const provider = getConfiguredPaymentsProvider();
  if (provider === "razorpay") {
    const keyId = getRazorpayKeyId();
    const secretConfigured = !!getRazorpayKeySecret();
    const webhookConfigured = !!getRazorpayWebhookSecret();
    return {
      provider: "razorpay",
      publishableKey: keyId,
      keyId,
      checkoutEnabled: !!keyId && secretConfigured,
      publishableKeySet: !!keyId,
      webhookConfigured,
      ready: !!keyId && secretConfigured && webhookConfigured,
      enabled: !!keyId && secretConfigured,
    };
  }

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
    enabled: secretConfigured && !!publishableKey,
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
              bp.stripe_currency, bp.razorpay_currency
       FROM workspace_subscriptions ws
       LEFT JOIN billing_plans bp
         ON (ws.billing_plan_id = bp.id OR ws.billing_plan = bp.slug)
       WHERE ws.workspace_id = $1
         AND ws.provider IN ('razorpay', 'stripe')
       ORDER BY CASE ws.provider WHEN 'razorpay' THEN 0 ELSE 1 END
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

async function createRazorpayWorkspaceSubscriptionCheckout({
  workspace,
  user,
  dbPlan,
  interval = "monthly",
}) {
  ensureRazorpayConfigured();

  const billingInterval = normalizeBillingInterval(interval);
  const currency = getTrialSignupCurrency(dbPlan, "razorpay");
  const razorpayPlan = await ensurePlanRazorpayPlanForCurrency(dbPlan, currency, billingInterval);
  const seatQuantity = await countBillableWorkspaceUsers(workspace.id);
  const trialDays = Number(dbPlan.trial_days) || 0;
  const verificationAmount = trialDays > 0 ? getTrialSignupVerificationAmount(currency, "razorpay") : 0;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const subscriptionPayload = {
    plan_id: razorpayPlan.planId,
    total_count: getRazorpaySubscriptionTotalCount(billingInterval),
    quantity: seatQuantity,
    customer_notify: false,
    notes: {
      workspace_id: workspace.id,
      workspace_name: workspace.name || "",
      user_id: user?.id || "",
      billing_plan: dbPlan.slug,
      billing_plan_id: dbPlan.id,
      billing_interval: billingInterval,
      seat_quantity: String(seatQuantity),
      source: "asystence_workspace_billing",
    },
  };

  if (trialDays > 0) {
    subscriptionPayload.start_at = nowSeconds + trialDays * 86400;
    subscriptionPayload.expire_by = nowSeconds + 24 * 60 * 60;
    subscriptionPayload.addons = [
      {
        item: {
          name: "Refundable card verification",
          amount: verificationAmount,
          currency: String(currency).toUpperCase(),
          description: "Refunded automatically after billing confirmation.",
        },
      },
    ];
  }

  const subscription = await razorpayRequest("post", "/subscriptions", {
    data: subscriptionPayload,
  });

  await db.query(
    `INSERT INTO payment_checkout_sessions (
       workspace_id, user_id, provider, checkout_session_id, customer_id,
       subscription_id, price_id, billing_plan, status, session_type,
       seat_quantity, success_url, cancel_url, metadata, created_at, updated_at
     )
     VALUES ($1,$2,'razorpay',$3,NULL,$3,$4,$5,$6,'subscription',$7,NULL,NULL,$8,now(),now())
     ON CONFLICT (provider, checkout_session_id)
     DO UPDATE SET
       user_id          = EXCLUDED.user_id,
       subscription_id  = EXCLUDED.subscription_id,
       price_id         = EXCLUDED.price_id,
       billing_plan     = EXCLUDED.billing_plan,
       status           = EXCLUDED.status,
       seat_quantity    = EXCLUDED.seat_quantity,
       metadata         = payment_checkout_sessions.metadata || EXCLUDED.metadata,
       updated_at       = now()`,
    [
      workspace.id,
      user?.id || null,
      subscription.id,
      razorpayPlan.planId,
      dbPlan.slug,
      subscription.status || "created",
      seatQuantity,
      {
        razorpaySubscription: subscription,
        verificationAmount,
        currency,
        trialDays,
        billingInterval,
      },
    ]
  );

  return {
    id: subscription.id,
    provider: "razorpay",
    keyId: getRazorpayKeyId(),
    subscriptionId: subscription.id,
    planSlug: dbPlan.slug,
    plan: dbPlan.slug,
    planName: dbPlan.name,
    interval: billingInterval,
    seatQuantity,
    trialDays,
    verificationAmount,
    currency,
    prefill: {
      name: user?.username || user?.name || "",
      email: user?.email || "",
    },
    livemode: isRazorpayLiveMode(),
  };
}

export async function createCheckoutSession({
  workspace,
  user,
  planId,          // DB UUID (preferred)
  plan,            // plan slug fallback
  interval = "monthly",
  successUrl,
  cancelUrl,
}) {
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

  if (getConfiguredPaymentsProvider() === "razorpay") {
    return createRazorpayWorkspaceSubscriptionCheckout({
      workspace,
      user,
      dbPlan,
      interval,
    });
  }

  ensureStripeConfigured();

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

export async function createTrialSignupCheckoutSession({
  workspaceName,
  name,
  email,
  password,
  ownerPasswordHash,
  authProvider = "email",
  avatarUrl = null,
  planId = null,
  plan = null,
  interval = "monthly",
  successUrl,
  cancelUrl,
  ipHash = null,
  userAgent = null,
  consentAccepted = false,
}) {
  ensureStripeConfigured();
  assertTrialSignupConsent(consentAccepted);

  const normalizedEmail = normalizeSignupEmail(email);
  const cleanedWorkspaceName = cleanRequiredString(workspaceName, "Workspace name", { min: 2, max: 120 });
  const cleanedName = cleanRequiredString(name || normalizedEmail.split("@")[0], "Name", { min: 2, max: 120 });
  const provider = authProvider === "google" ? "google" : "email";
  const passwordHash =
    provider === "email"
      ? await bcryptHashForTrialSignup(password, ownerPasswordHash)
      : null;

  const existingUser = await getUserByEmail(normalizedEmail);
  if (existingUser) {
    throw Object.assign(new Error("An account already exists with this email. Please sign in."), { statusCode: 409 });
  }

  const activePending = await findActivePendingTrialSignup({ email: normalizedEmail });
  if (activePending) {
    throw Object.assign(
      new Error("A trial signup checkout is already pending. Please finish or wait for it to expire."),
      { statusCode: 409, checkoutSessionId: activePending.checkout_session_id }
    );
  }

  let dbPlan = null;
  if (planId) dbPlan = await getPlanById(planId);
  else dbPlan = await getPlanBySlug(plan || getTrialSignupPlanSlug());
  if (!dbPlan || !dbPlan.is_active) {
    throw Object.assign(new Error("Selected trial plan is not available."), { statusCode: 404 });
  }
  if ((Number(dbPlan.trial_days) || 0) <= 0) {
    throw Object.assign(new Error("Selected plan does not include a free trial."), { statusCode: 400 });
  }

  const billingInterval = normalizeBillingInterval(interval);
  const currency = getTrialSignupCurrency(dbPlan);
  const prices = await ensurePlanStripePricesForCurrency(dbPlan, currency);
  const priceId = billingInterval === "yearly" ? prices.yearlyPriceId : prices.monthlyPriceId;
  if (!priceId) {
    throw Object.assign(new Error(`No ${billingInterval} Stripe price is available for trial signup.`), {
      statusCode: 503,
    });
  }

  const verificationAmount = getTrialSignupVerificationAmount(currency);
  const customer = await stripeRequest("post", "/v1/customers", {
    data: qs.stringify(
      {
        email: normalizedEmail,
        name: cleanedName,
        "metadata[purpose]": "trial_signup",
        "metadata[owner_email]": normalizedEmail,
        "metadata[workspace_name]": cleanedWorkspaceName,
        "metadata[auth_provider]": provider,
      },
      { encode: true }
    ),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  const pendingInsert = await db.query(
    `INSERT INTO trial_signup_checkout_sessions (
       provider, customer_id, status, workspace_name, owner_name, owner_email,
       owner_password_hash, auth_provider, avatar_url, billing_plan_id,
       billing_plan, billing_interval, verification_amount, currency,
       consent_ip_hash, consent_user_agent, metadata, created_at, updated_at
     )
     VALUES (
       'stripe', $1, 'created', $2, $3, $4,
       $5, $6, $7, $8,
       $9, $10, $11, $12,
       $13, $14, $15, now(), now()
     )
     RETURNING id`,
    [
      customer.id,
      cleanedWorkspaceName,
      cleanedName,
      normalizedEmail,
      passwordHash,
      provider,
      avatarUrl,
      dbPlan.id,
      dbPlan.slug,
      billingInterval,
      verificationAmount,
      currency,
      ipHash,
      userAgent,
      {
        priceId,
        planName: dbPlan.name,
        trialDays: dbPlan.trial_days,
        stripePriceCreated: prices.created,
      },
    ]
  );

  const pendingId = pendingInsert.rows[0].id;
  const consentMessage =
    `By starting your ${dbPlan.trial_days}-day trial, you authorize automatic ${billingInterval} ` +
    `billing after the trial unless you cancel first. The ${(verificationAmount / 100).toFixed(2)} ` +
    `${currency.toUpperCase()} card verification charge is refunded automatically after confirmation.`;

  const session = await stripeRequest("post", "/v1/checkout/sessions", {
    data: qs.stringify(
      {
        mode: "subscription",
        success_url: resolveTrialSignupSuccessUrl(successUrl),
        cancel_url: resolveTrialSignupCancelUrl(cancelUrl),
        customer: customer.id,
        payment_method_collection: "always",
        "payment_method_types[0]": "card",
        billing_address_collection: "required",
        allow_promotion_codes: true,
        client_reference_id: pendingId,
        "line_items[0][price]": priceId,
        "line_items[0][quantity]": 1,
        "line_items[1][quantity]": 1,
        "line_items[1][price_data][currency]": currency,
        "line_items[1][price_data][unit_amount]": verificationAmount,
        "line_items[1][price_data][product_data][name]": "Refundable card verification",
        "line_items[1][price_data][product_data][description]": "Refunded automatically after trial signup confirmation.",
        "subscription_data[trial_period_days]": dbPlan.trial_days,
        "subscription_data[metadata][pending_signup_id]": pendingId,
        "subscription_data[metadata][billing_plan]": dbPlan.slug,
        "subscription_data[metadata][billing_plan_id]": dbPlan.id,
        "subscription_data[metadata][billing_interval]": billingInterval,
        "subscription_data[trial_settings][end_behavior][missing_payment_method]": "cancel",
        "metadata[session_type]": TRIAL_SIGNUP_SESSION_TYPE,
        "metadata[pending_signup_id]": pendingId,
        "metadata[billing_plan]": dbPlan.slug,
        "metadata[billing_plan_id]": dbPlan.id,
        "metadata[billing_interval]": billingInterval,
        "metadata[verification_amount]": verificationAmount,
        "metadata[verification_currency]": currency,
        "custom_text[submit][message]": consentMessage,
      },
      { encode: true }
    ),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  await db.query(
    `UPDATE trial_signup_checkout_sessions
     SET checkout_session_id = $2,
         subscription_id     = COALESCE($3, subscription_id),
         status              = $4,
         metadata            = metadata || $5,
         updated_at          = now()
     WHERE id = $1`,
    [
      pendingId,
      session.id,
      session.subscription ? String(session.subscription) : null,
      session.status || "open",
      { checkoutSession: session },
    ]
  );

  return {
    id: session.id,
    url: session.url,
    checkoutRequired: true,
    provider: "stripe",
    plan: dbPlan.slug,
    planName: dbPlan.name,
    interval: billingInterval,
    trialDays: dbPlan.trial_days,
    verificationAmount,
    currency,
    livemode: !!session.livemode,
  };
}

async function bcryptHashForTrialSignup(password, existingHash = undefined) {
  if (existingHash !== undefined) return existingHash;
  const bcrypt = await import("bcryptjs");
  return bcrypt.default.hash(validateSignupPassword(password), 10);
}

async function fetchCheckoutSessionForTrialSignup(sessionId) {
  return stripeRequest(
    "get",
    `/v1/checkout/sessions/${sessionId}` +
      `?expand[]=subscription.items.data.price` +
      `&expand[]=subscription.latest_invoice.payment_intent`
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getPendingTrialSignupById(id) {
  const { rows } = await db.query(
    `SELECT *
     FROM trial_signup_checkout_sessions
     WHERE id = $1
     LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

async function buildProvisionedTrialSignupResult(pending) {
  if (!pending?.workspace_id || !pending?.owner_user_id) return null;
  const user = await getUserById(pending.owner_user_id);
  return {
    workspaceId: pending.workspace_id,
    user,
    alreadyProvisioned: true,
    refundId: pending.refund_id || null,
    verificationAmount: pending.verification_amount,
    currency: pending.currency,
  };
}

async function refundTrialSignupVerification({ pending, session, subscription, workspaceId }) {
  if (pending.refund_id) {
    return { refundId: pending.refund_id, paymentIntentId: pending.payment_intent_id || null };
  }

  const paymentIntentId =
    (session.payment_intent ? String(session.payment_intent) : null) ||
    getPaymentIntentIdFromSubscription(subscription);

  if (!paymentIntentId) {
    await db.query(
      `UPDATE trial_signup_checkout_sessions
       SET status = 'provisioned_refund_pending',
           metadata = metadata || $2,
           updated_at = now()
       WHERE id = $1`,
      [pending.id, { refundWarning: "No PaymentIntent found for verification charge yet." }]
    );
    return { refundId: null, paymentIntentId: null };
  }

  const refund = await stripeRequest("post", "/v1/refunds", {
    data: qs.stringify(
      {
        payment_intent: paymentIntentId,
        amount: pending.verification_amount,
        reason: "requested_by_customer",
        "metadata[purpose]": "trial_signup_card_verification_refund",
        "metadata[workspace_id]": workspaceId,
        "metadata[pending_signup_id]": pending.id,
        "metadata[checkout_session_id]": session.id,
      },
      { encode: true }
    ),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  return { refundId: refund.id, paymentIntentId };
}

export async function provisionTrialSignupCheckoutSession(sessionOrId) {
  ensureStripeConfigured();

  const session =
    typeof sessionOrId === "string"
      ? await fetchCheckoutSessionForTrialSignup(sessionOrId)
      : sessionOrId;
  if (!session?.id) {
    throw Object.assign(new Error("Stripe Checkout session not found."), { statusCode: 404 });
  }

  const { rows } = await db.query(
    `SELECT *
     FROM trial_signup_checkout_sessions
     WHERE provider = 'stripe' AND checkout_session_id = $1
     LIMIT 1`,
    [session.id]
  );
  let pending = rows[0] || null;
  if (!pending) {
    throw Object.assign(new Error("Signup checkout session was not found."), { statusCode: 404 });
  }

  const alreadyProvisioned = await buildProvisionedTrialSignupResult(pending);
  if (alreadyProvisioned) return alreadyProvisioned;

  if (session.status !== "complete") {
    throw Object.assign(new Error("Signup checkout is not complete yet."), { statusCode: 409 });
  }
  if (session.payment_status && !["paid", "no_payment_required"].includes(session.payment_status)) {
    throw Object.assign(new Error("Signup checkout payment has not completed yet."), { statusCode: 409 });
  }

  const subscription =
    getExpandedSubscriptionFromSession(session) ||
    (session.subscription
      ? await getStripeSubscriptionWithItems(String(session.subscription))
      : null);

  const claim = await db.query(
    `UPDATE trial_signup_checkout_sessions
     SET status = 'provisioning', updated_at = now()
     WHERE id = $1
       AND workspace_id IS NULL
       AND owner_user_id IS NULL
       AND status <> 'provisioning'
     RETURNING *`,
    [pending.id]
  );

  if (!claim.rows[0]) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await wait(500);
      const latest = await getPendingTrialSignupById(pending.id);
      const provisioned = await buildProvisionedTrialSignupResult(latest);
      if (provisioned) return provisioned;
    }
    throw Object.assign(
      new Error("Signup checkout is still being completed. Please try again in a few seconds."),
      { statusCode: 409 }
    );
  }
  pending = claim.rows[0];

  const result = await createSelfServeTrialWorkspace({
    workspaceName: pending.workspace_name,
    ownerName: pending.owner_name,
    ownerEmail: pending.owner_email,
    ownerPasswordHash: pending.owner_password_hash || null,
    ipHash: pending.consent_ip_hash || null,
    avatarUrl: pending.avatar_url || null,
    skipTrialIpCheck: true,
  });

  if (session.customer) {
    await upsertPaymentCustomer({
      workspaceId: result.workspace.id,
      customerId: String(session.customer),
      email: session.customer_details?.email || pending.owner_email,
      currency: session.currency || pending.currency,
      metadata: {
        pending_signup_id: pending.id,
        checkout_session_id: session.id,
        auth_provider: pending.auth_provider,
      },
    });
  }

  let syncedSubscription = subscription;
  if (subscription?.id) {
    await stripeRequest("post", `/v1/subscriptions/${subscription.id}`, {
      data: qs.stringify(
        {
          "metadata[workspace_id]": result.workspace.id,
          "metadata[user_id]": result.user.id,
          "metadata[pending_signup_id]": pending.id,
          "metadata[billing_plan]": pending.billing_plan,
          "metadata[billing_plan_id]": pending.billing_plan_id,
          "metadata[billing_interval]": pending.billing_interval,
          "metadata[seat_quantity]": 1,
        },
        { encode: true }
      ),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    syncedSubscription = await getStripeSubscriptionWithItems(subscription.id);
    await upsertSubscriptionFromStripe(syncedSubscription, result.workspace.id);
  }

  await db.query(
    `INSERT INTO payment_checkout_sessions (
       workspace_id, user_id, provider, checkout_session_id, customer_id,
       subscription_id, price_id, billing_plan, status, session_type,
       seat_quantity, success_url, cancel_url, metadata, completed_at, created_at, updated_at
     )
     VALUES ($1,$2,'stripe',$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,now(),now(),now())
     ON CONFLICT (provider, checkout_session_id)
     DO UPDATE SET
       workspace_id     = EXCLUDED.workspace_id,
       user_id          = EXCLUDED.user_id,
       customer_id      = EXCLUDED.customer_id,
       subscription_id  = EXCLUDED.subscription_id,
       price_id         = COALESCE(EXCLUDED.price_id, payment_checkout_sessions.price_id),
       billing_plan     = EXCLUDED.billing_plan,
       status           = EXCLUDED.status,
       session_type     = EXCLUDED.session_type,
       completed_at     = COALESCE(payment_checkout_sessions.completed_at, now()),
       metadata         = payment_checkout_sessions.metadata || EXCLUDED.metadata,
       updated_at       = now()`,
    [
      result.workspace.id,
      result.user.id,
      session.id,
      session.customer ? String(session.customer) : null,
      syncedSubscription?.id || (session.subscription ? String(session.subscription) : null),
      getPrimarySubscriptionItem(syncedSubscription)?.price?.id || null,
      pending.billing_plan,
      session.status || "complete",
      TRIAL_SIGNUP_SESSION_TYPE,
      resolveTrialSignupSuccessUrl(),
      resolveTrialSignupCancelUrl(),
      session,
    ]
  );

  let refundResult = {
    refundId: null,
    paymentIntentId:
      (session.payment_intent ? String(session.payment_intent) : null) ||
      getPaymentIntentIdFromSubscription(syncedSubscription),
  };
  let completionStatus = "provisioned_refund_pending";
  let completionMetadata = { provisionedFromCheckout: true };

  await db.query(
    `UPDATE trial_signup_checkout_sessions
     SET status = 'provisioned_refund_pending',
         workspace_id = $2,
         owner_user_id = $3,
         owner_password_hash = NULL,
         subscription_id = COALESCE($4, subscription_id),
         payment_intent_id = COALESCE($5, payment_intent_id),
         metadata = metadata || $6,
         completed_at = COALESCE(completed_at, now()),
         updated_at = now()
     WHERE id = $1`,
    [
      pending.id,
      result.workspace.id,
      result.user.id,
      syncedSubscription?.id || (session.subscription ? String(session.subscription) : null),
      refundResult.paymentIntentId,
      completionMetadata,
    ]
  );

  try {
    refundResult = await refundTrialSignupVerification({
      pending,
      session,
      subscription: syncedSubscription,
      workspaceId: result.workspace.id,
    });
    completionStatus = refundResult.refundId ? "provisioned" : "provisioned_refund_pending";
  } catch (refundErr) {
    completionStatus = "provisioned_refund_failed";
    completionMetadata = {
      ...completionMetadata,
      refundError: refundErr.message,
    };
    console.error("[billing] trial signup verification refund failed:", refundErr.message);
  }

  await db.query(
    `UPDATE trial_signup_checkout_sessions
     SET status = $8,
         workspace_id = $2,
         owner_user_id = $3,
         owner_password_hash = NULL,
         subscription_id = COALESCE($4, subscription_id),
         payment_intent_id = COALESCE($5, payment_intent_id),
         refund_id = COALESCE($6, refund_id),
         metadata = metadata || $7,
         completed_at = COALESCE(completed_at, now()),
         updated_at = now()
     WHERE id = $1`,
    [
      pending.id,
      result.workspace.id,
      result.user.id,
      syncedSubscription?.id || (session.subscription ? String(session.subscription) : null),
      refundResult.paymentIntentId,
      refundResult.refundId,
      completionMetadata,
      completionStatus,
    ]
  );

  return {
    workspaceId: result.workspace.id,
    workspace: result.workspace,
    user: result.user,
    token: result.token,
    refundId: refundResult.refundId,
    verificationAmount: pending.verification_amount,
    currency: pending.currency,
  };
}

export async function completeTrialSignupCheckoutSession(sessionId) {
  const provisioned = await provisionTrialSignupCheckoutSession(sessionId);
  const user = provisioned.user || (await getUserById(provisioned.userId));
  const token = provisioned.token || generateToken(user);
  return {
    token,
    user,
    workspace: provisioned.workspace || { id: provisioned.workspaceId },
    refundId: provisioned.refundId,
    verificationAmount: provisioned.verificationAmount,
    currency: provisioned.currency,
  };
}

function verifyRazorpaySubscriptionCheckoutSignature({ subscriptionId, paymentId, signature }) {
  ensureRazorpayConfigured();
  if (!subscriptionId || !paymentId || !signature) {
    throw Object.assign(new Error("Missing Razorpay payment verification details."), { statusCode: 400 });
  }

  const expected = crypto
    .createHmac("sha256", getRazorpayKeySecret())
    .update(`${paymentId}|${subscriptionId}`)
    .digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(String(signature), "hex");
  if (
    expectedBuffer.length !== actualBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    throw Object.assign(new Error("Razorpay payment signature verification failed."), { statusCode: 400 });
  }
}

function verifyRazorpayOrderCheckoutSignature({ orderId, paymentId, signature }) {
  ensureRazorpayConfigured();
  if (!orderId || !paymentId || !signature) {
    throw Object.assign(new Error("Missing Razorpay payment verification details."), { statusCode: 400 });
  }

  const expected = crypto
    .createHmac("sha256", getRazorpayKeySecret())
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(String(signature), "hex");
  if (
    expectedBuffer.length !== actualBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    throw Object.assign(new Error("Razorpay payment signature verification failed."), { statusCode: 400 });
  }
}

function shouldUseRazorpayOrderFallback(error) {
  return (
    isRazorpayLiveMode() === false &&
    (error?.statusCode === 401 || /unauthorized|not enabled|not activated/i.test(error?.message || ""))
  );
}

function getRazorpaySubscriptionTotalCount(interval) {
  const envKey =
    normalizeBillingInterval(interval) === "yearly"
      ? "RAZORPAY_SUBSCRIPTION_TOTAL_COUNT_YEARLY"
      : "RAZORPAY_SUBSCRIPTION_TOTAL_COUNT_MONTHLY";
  const parsed = Number.parseInt(process.env[envKey] || "", 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return normalizeBillingInterval(interval) === "yearly" ? 10 : 120;
}

async function getPendingRazorpayTrialSignupBySubscription(subscriptionId) {
  const { rows } = await db.query(
    `SELECT *
     FROM trial_signup_checkout_sessions
     WHERE provider = 'razorpay'
       AND subscription_id = $1
     LIMIT 1`,
    [subscriptionId]
  );
  return rows[0] || null;
}

async function getPendingRazorpayTrialSignupByOrder(orderId) {
  const { rows } = await db.query(
    `SELECT *
     FROM trial_signup_checkout_sessions
     WHERE provider = 'razorpay'
       AND provider_order_id = $1
     LIMIT 1`,
    [orderId]
  );
  return rows[0] || null;
}

async function fetchRazorpaySubscription(subscriptionId) {
  return razorpayRequest("get", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

async function fetchRazorpayPayment(paymentId) {
  return razorpayRequest("get", `/payments/${encodeURIComponent(paymentId)}`);
}

function normalizeRazorpayWorkspaceStatus(subscription) {
  if (subscription?.status === "authenticated") return "trialing";
  return subscription?.status || "created";
}

async function upsertSubscriptionFromRazorpay(subscription, explicitWorkspaceId = null, pending = null) {
  const plan =
    pending?.billing_plan_id
      ? await getPlanById(pending.billing_plan_id)
      : await getPlanByRazorpayPlanId(subscription.plan_id);
  const workspaceId =
    explicitWorkspaceId ||
    subscription.notes?.workspace_id ||
    pending?.workspace_id ||
    null;

  if (!workspaceId) {
    throw new Error(`Unable to resolve workspace for Razorpay subscription ${subscription.id}`);
  }

  const billingPlan = plan?.slug || pending?.billing_plan || subscription.notes?.billing_plan || null;
  const billingInterval =
    pending?.billing_interval ||
    subscription.notes?.billing_interval ||
    (plan?.razorpay_plan_yearly_id === subscription.plan_id ? "yearly" : "monthly");
  const customerId = subscription.customer_id || pending?.customer_id || null;
  const currentPeriodEnd =
    razorpayTimestampToIso(subscription.current_end) ||
    razorpayTimestampToIso(subscription.start_at) ||
    null;

  await db.query(
    `INSERT INTO workspace_subscriptions (
       workspace_id, provider, customer_id, subscription_id, status,
       billing_plan, billing_plan_id, billing_interval,
       price_id, product_id, currency, interval, cancel_at_period_end, trial_ends_at,
       current_period_start, current_period_end, subscription_item_id, seat_quantity,
       metadata, created_at, updated_at
     )
     VALUES ($1,'razorpay',$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10,$11,$12,$13,$14,NULL,1,$15,now(),now())
     ON CONFLICT (workspace_id, provider)
     DO UPDATE SET
       customer_id          = COALESCE(EXCLUDED.customer_id, workspace_subscriptions.customer_id),
       subscription_id      = EXCLUDED.subscription_id,
       status               = EXCLUDED.status,
       billing_plan         = COALESCE(EXCLUDED.billing_plan, workspace_subscriptions.billing_plan),
       billing_plan_id      = COALESCE(EXCLUDED.billing_plan_id, workspace_subscriptions.billing_plan_id),
       billing_interval     = COALESCE(EXCLUDED.billing_interval, workspace_subscriptions.billing_interval),
       price_id             = EXCLUDED.price_id,
       currency             = COALESCE(EXCLUDED.currency, workspace_subscriptions.currency),
       interval             = COALESCE(EXCLUDED.interval, workspace_subscriptions.interval),
       cancel_at_period_end = EXCLUDED.cancel_at_period_end,
       trial_ends_at        = COALESCE(EXCLUDED.trial_ends_at, workspace_subscriptions.trial_ends_at),
       current_period_start = COALESCE(EXCLUDED.current_period_start, workspace_subscriptions.current_period_start),
       current_period_end   = COALESCE(EXCLUDED.current_period_end, workspace_subscriptions.current_period_end),
       seat_quantity        = EXCLUDED.seat_quantity,
       metadata             = workspace_subscriptions.metadata || EXCLUDED.metadata,
       updated_at           = now()`,
    [
      workspaceId,
      customerId,
      subscription.id,
      subscription.status || "created",
      billingPlan,
      plan?.id || pending?.billing_plan_id || null,
      billingInterval,
      subscription.plan_id || null,
      pending?.currency || plan?.razorpay_currency || null,
      billingInterval,
      !!subscription.cancel_at_cycle_end,
      razorpayTimestampToIso(subscription.start_at),
      razorpayTimestampToIso(subscription.current_start) || new Date().toISOString(),
      currentPeriodEnd,
      {
        ...(subscription.notes || {}),
        razorpay_subscription: subscription,
      },
    ]
  );

  await updateWorkspaceBillingState({
    workspaceId,
    plan,
    status: normalizeRazorpayWorkspaceStatus(subscription),
    customerId,
    subscriptionId: subscription.id,
    currentPeriodStart: razorpayTimestampToIso(subscription.current_start) || new Date().toISOString(),
    currentPeriodEnd,
    provider: "razorpay",
  });

  if (isSubscriptionEntitled(normalizeRazorpayWorkspaceStatus(subscription))) {
    await db.query(
      `UPDATE workspace_users
       SET billing_status = 'active',
           activated_at = now(),
           cycle_start = $2,
           cycle_end = $3
       WHERE workspace_id = $1 AND billing_status = 'trial'`,
      [
        workspaceId,
        razorpayTimestampToIso(subscription.current_start) || new Date().toISOString(),
        currentPeriodEnd,
      ]
    );
  }

  return { workspaceId };
}

async function refundRazorpayTrialSignupVerification({ pending, paymentId, workspaceId }) {
  const existingRefundId = pending.provider_refund_id || pending.refund_id || null;
  if (existingRefundId) return { refundId: existingRefundId, paymentId };

  const refund = await razorpayRequest("post", `/payments/${encodeURIComponent(paymentId)}/refund`, {
    data: {
      amount: pending.verification_amount,
      speed: "optimum",
      receipt: `trial_${String(pending.id).replace(/-/g, "").slice(0, 24)}`,
      notes: {
        purpose: "trial_signup_card_verification_refund",
        workspace_id: workspaceId,
        pending_signup_id: pending.id,
        razorpay_subscription_id: pending.subscription_id,
      },
    },
  });

  return { refundId: refund.id, paymentId };
}

export async function createRazorpayTrialSignupCheckoutSession({
  workspaceName,
  name,
  email,
  password,
  ownerPasswordHash,
  authProvider = "email",
  avatarUrl = null,
  planId = null,
  plan = null,
  interval = "monthly",
  ipHash = null,
  userAgent = null,
  consentAccepted = false,
}) {
  ensureRazorpayConfigured();
  assertTrialSignupConsent(consentAccepted);

  const normalizedEmail = normalizeSignupEmail(email);
  const cleanedWorkspaceName = cleanRequiredString(workspaceName, "Workspace name", { min: 2, max: 120 });
  const cleanedName = cleanRequiredString(name || normalizedEmail.split("@")[0], "Name", { min: 2, max: 120 });
  const provider = authProvider === "google" ? "google" : "email";
  const passwordHash =
    provider === "email"
      ? await bcryptHashForTrialSignup(password, ownerPasswordHash)
      : null;

  const existingUser = await getUserByEmail(normalizedEmail);
  if (existingUser) {
    throw Object.assign(new Error("An account already exists with this email. Please sign in."), { statusCode: 409 });
  }

  const activePending = await findActivePendingTrialSignup({ email: normalizedEmail });
  if (activePending) {
    throw Object.assign(
      new Error("A trial signup checkout is already pending. Please finish or wait for it to expire."),
      { statusCode: 409, checkoutSessionId: activePending.checkout_session_id }
    );
  }

  let dbPlan = null;
  if (planId) dbPlan = await getPlanById(planId);
  else dbPlan = await getPlanBySlug(plan || getTrialSignupPlanSlug());
  if (!dbPlan || !dbPlan.is_active) {
    throw Object.assign(new Error("Selected trial plan is not available."), { statusCode: 404 });
  }
  if ((Number(dbPlan.trial_days) || 0) <= 0) {
    throw Object.assign(new Error("Selected plan does not include a free trial."), { statusCode: 400 });
  }

  const billingInterval = normalizeBillingInterval(interval);
  const currency = getTrialSignupCurrency(dbPlan, "razorpay");
  const verificationAmount = getTrialSignupVerificationAmount(currency, "razorpay");
  let razorpayPlan = null;
  let useOrderFallback = false;
  try {
    razorpayPlan = await ensurePlanRazorpayPlanForCurrency(dbPlan, currency, billingInterval);
  } catch (planErr) {
    if (!shouldUseRazorpayOrderFallback(planErr)) throw planErr;
    useOrderFallback = true;
  }

  const pendingInsert = await db.query(
    `INSERT INTO trial_signup_checkout_sessions (
       provider, status, workspace_name, owner_name, owner_email,
       owner_password_hash, auth_provider, avatar_url, billing_plan_id,
       billing_plan, billing_interval, verification_amount, currency,
       provider_plan_id, consent_ip_hash, consent_user_agent, metadata, created_at, updated_at
     )
     VALUES (
       'razorpay', 'created', $1, $2, $3,
       $4, $5, $6, $7,
       $8, $9, $10, $11,
       $12, $13, $14, $15, now(), now()
     )
     RETURNING id`,
    [
      cleanedWorkspaceName,
      cleanedName,
      normalizedEmail,
      passwordHash,
      provider,
      avatarUrl,
      dbPlan.id,
      dbPlan.slug,
      billingInterval,
      verificationAmount,
      currency,
      razorpayPlan?.planId || null,
      ipHash,
      userAgent,
      {
        planName: dbPlan.name,
        trialDays: dbPlan.trial_days,
        razorpayPlanCreated: razorpayPlan?.created || false,
        razorpayOrderFallback: useOrderFallback,
      },
    ]
  );

  const pendingId = pendingInsert.rows[0].id;
  if (useOrderFallback) {
    const order = await razorpayRequest("post", "/orders", {
      data: {
        amount: verificationAmount,
        currency: String(currency).toUpperCase(),
        receipt: `trial_${String(pendingId).replace(/-/g, "").slice(0, 24)}`,
        notes: {
          pending_signup_id: pendingId,
          billing_plan: dbPlan.slug,
          billing_plan_id: dbPlan.id,
          billing_interval: billingInterval,
          owner_email: normalizedEmail,
          workspace_name: cleanedWorkspaceName,
          source: "asystence_trial_signup_order_fallback",
        },
      },
    });

    await db.query(
      `UPDATE trial_signup_checkout_sessions
       SET checkout_session_id = $2,
           provider_order_id   = $2,
           status              = $3,
           metadata            = metadata || $4,
           updated_at          = now()
       WHERE id = $1`,
      [
        pendingId,
        order.id,
        order.status || "created",
        { razorpayOrder: order, orderFallbackReason: "subscriptions_api_unavailable_in_test_mode" },
      ]
    );

    return {
      id: order.id,
      checkoutSessionId: order.id,
      orderId: order.id,
      checkoutMode: "order",
      checkoutRequired: true,
      provider: "razorpay",
      keyId: getRazorpayKeyId(),
      plan: dbPlan.slug,
      planName: dbPlan.name,
      interval: billingInterval,
      trialDays: dbPlan.trial_days,
      verificationAmount,
      amount: order.amount,
      currency,
      livemode: isRazorpayLiveMode(),
      prefill: {
        name: cleanedName,
        email: normalizedEmail,
      },
      notes: {
        pending_signup_id: pendingId,
      },
      testOnlyOrderFallback: true,
    };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const startAt = nowSeconds + Math.max(1, Number(dbPlan.trial_days) || 1) * 86400;
  const expireBy = nowSeconds + 24 * 60 * 60;
  const subscription = await razorpayRequest("post", "/subscriptions", {
    data: {
      plan_id: razorpayPlan.planId,
      total_count: getRazorpaySubscriptionTotalCount(billingInterval),
      quantity: 1,
      customer_notify: false,
      start_at: startAt,
      expire_by: expireBy,
      addons: [
        {
          item: {
            name: "Refundable card verification",
            amount: verificationAmount,
            currency: String(currency).toUpperCase(),
            description: "Refunded automatically after trial signup confirmation.",
          },
        },
      ],
      notes: {
        pending_signup_id: pendingId,
        billing_plan: dbPlan.slug,
        billing_plan_id: dbPlan.id,
        billing_interval: billingInterval,
        owner_email: normalizedEmail,
        workspace_name: cleanedWorkspaceName,
        source: "asystence_trial_signup",
      },
    },
  });

  await db.query(
    `UPDATE trial_signup_checkout_sessions
     SET checkout_session_id = $2,
         subscription_id     = $2,
         status              = $3,
         metadata            = metadata || $4,
         updated_at          = now()
     WHERE id = $1`,
    [
      pendingId,
      subscription.id,
      subscription.status || "created",
      { razorpaySubscription: subscription },
    ]
  );

  return {
    id: subscription.id,
    url: subscription.short_url || null,
    shortUrl: subscription.short_url || null,
    checkoutSessionId: subscription.id,
    subscriptionId: subscription.id,
    checkoutRequired: true,
    provider: "razorpay",
    keyId: getRazorpayKeyId(),
    plan: dbPlan.slug,
    planName: dbPlan.name,
    interval: billingInterval,
    trialDays: dbPlan.trial_days,
    verificationAmount,
    currency,
    livemode: isRazorpayLiveMode(),
    prefill: {
      name: cleanedName,
      email: normalizedEmail,
    },
    notes: {
      pending_signup_id: pendingId,
    },
  };
}

export async function provisionRazorpayTrialSignupCheckout({
  subscriptionId,
  paymentId,
  signature,
  pendingSignupId = null,
  trustedWebhook = false,
}) {
  ensureRazorpayConfigured();
  if (!subscriptionId || !paymentId) {
    throw Object.assign(new Error("subscriptionId and paymentId are required."), { statusCode: 400 });
  }

  let pending = await getPendingRazorpayTrialSignupBySubscription(subscriptionId);
  if (!pending) {
    throw Object.assign(new Error("Razorpay signup subscription was not found."), { statusCode: 404 });
  }
  if (pendingSignupId && String(pending.id) !== String(pendingSignupId)) {
    throw Object.assign(new Error("Razorpay signup subscription does not match this signup attempt."), {
      statusCode: 400,
    });
  }

  const alreadyProvisioned = await buildProvisionedTrialSignupResult(pending);
  if (alreadyProvisioned) return alreadyProvisioned;

  if (!trustedWebhook) {
    verifyRazorpaySubscriptionCheckoutSignature({
      subscriptionId: pending.subscription_id,
      paymentId,
      signature,
    });
  }

  const [payment, subscription] = await Promise.all([
    fetchRazorpayPayment(paymentId),
    fetchRazorpaySubscription(subscriptionId),
  ]);

  if (payment.status !== "captured") {
    throw Object.assign(new Error("Razorpay verification payment has not been captured yet."), {
      statusCode: 409,
    });
  }
  if (payment.currency && String(payment.currency).toLowerCase() !== String(pending.currency).toLowerCase()) {
    throw Object.assign(new Error("Razorpay verification payment currency mismatch."), { statusCode: 400 });
  }
  if (Number(payment.amount) < Number(pending.verification_amount)) {
    throw Object.assign(new Error("Razorpay verification payment amount mismatch."), { statusCode: 400 });
  }
  if (subscription.id !== pending.subscription_id) {
    throw Object.assign(new Error("Razorpay subscription mismatch."), { statusCode: 400 });
  }
  if (!["authenticated", "active"].includes(subscription.status)) {
    throw Object.assign(new Error(`Razorpay subscription is ${subscription.status}.`), { statusCode: 409 });
  }

  const claim = await db.query(
    `UPDATE trial_signup_checkout_sessions
     SET status = 'provisioning',
         provider_payment_id = COALESCE($2, provider_payment_id),
         payment_intent_id = COALESCE($2, payment_intent_id),
         provider_signature = COALESCE($3, provider_signature),
         customer_id = COALESCE($4, customer_id),
         metadata = metadata || $5,
         updated_at = now()
     WHERE id = $1
       AND workspace_id IS NULL
       AND owner_user_id IS NULL
       AND status <> 'provisioning'
     RETURNING *`,
    [
      pending.id,
      paymentId,
      signature || null,
      subscription.customer_id || payment.customer_id || null,
      { razorpayPayment: payment, razorpaySubscription: subscription },
    ]
  );

  if (!claim.rows[0]) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await wait(500);
      const latest = await getPendingTrialSignupById(pending.id);
      const provisioned = await buildProvisionedTrialSignupResult(latest);
      if (provisioned) return provisioned;
    }
    throw Object.assign(
      new Error("Signup checkout is still being completed. Please try again in a few seconds."),
      { statusCode: 409 }
    );
  }
  pending = claim.rows[0];

  const result = await createSelfServeTrialWorkspace({
    workspaceName: pending.workspace_name,
    ownerName: pending.owner_name,
    ownerEmail: pending.owner_email,
    ownerPasswordHash: pending.owner_password_hash || null,
    ipHash: pending.consent_ip_hash || null,
    avatarUrl: pending.avatar_url || null,
    skipTrialIpCheck: true,
  });

  const customerId = subscription.customer_id || payment.customer_id || null;
  if (customerId) {
    await upsertPaymentCustomer({
      workspaceId: result.workspace.id,
      provider: "razorpay",
      customerId: String(customerId),
      email: subscription.customer_email || payment.email || pending.owner_email,
      currency: pending.currency,
      metadata: {
        pending_signup_id: pending.id,
        razorpay_subscription_id: subscription.id,
        auth_provider: pending.auth_provider,
      },
    });
  }

  await upsertSubscriptionFromRazorpay(
    {
      ...subscription,
      notes: {
        ...(subscription.notes || {}),
        workspace_id: result.workspace.id,
        user_id: result.user.id,
        pending_signup_id: pending.id,
        billing_plan: pending.billing_plan,
        billing_plan_id: pending.billing_plan_id,
        billing_interval: pending.billing_interval,
      },
    },
    result.workspace.id,
    pending
  );

  await db.query(
    `INSERT INTO payment_checkout_sessions (
       workspace_id, user_id, provider, checkout_session_id, customer_id,
       subscription_id, price_id, billing_plan, status, session_type,
       seat_quantity, success_url, cancel_url, metadata, completed_at, created_at, updated_at
     )
     VALUES ($1,$2,'razorpay',$3,$4,$5,$6,$7,$8,$9,1,NULL,NULL,$10,now(),now(),now())
     ON CONFLICT (provider, checkout_session_id)
     DO UPDATE SET
       workspace_id     = EXCLUDED.workspace_id,
       user_id          = EXCLUDED.user_id,
       customer_id      = COALESCE(EXCLUDED.customer_id, payment_checkout_sessions.customer_id),
       subscription_id  = EXCLUDED.subscription_id,
       price_id         = COALESCE(EXCLUDED.price_id, payment_checkout_sessions.price_id),
       billing_plan     = EXCLUDED.billing_plan,
       status           = EXCLUDED.status,
       session_type     = EXCLUDED.session_type,
       completed_at     = COALESCE(payment_checkout_sessions.completed_at, now()),
       metadata         = payment_checkout_sessions.metadata || EXCLUDED.metadata,
       updated_at       = now()`,
    [
      result.workspace.id,
      result.user.id,
      subscription.id,
      customerId ? String(customerId) : null,
      subscription.id,
      subscription.plan_id || pending.provider_plan_id || null,
      pending.billing_plan,
      subscription.status || "authenticated",
      TRIAL_SIGNUP_SESSION_TYPE,
      {
        razorpayPayment: payment,
        razorpaySubscription: subscription,
      },
    ]
  );

  let refundResult = { refundId: null, paymentId };
  let completionStatus = "provisioned_refund_pending";
  let completionMetadata = { provisionedFromRazorpay: true };

  await db.query(
    `UPDATE trial_signup_checkout_sessions
     SET status = 'provisioned_refund_pending',
         workspace_id = $2,
         owner_user_id = $3,
         owner_password_hash = NULL,
         customer_id = COALESCE($4, customer_id),
         provider_payment_id = COALESCE($5, provider_payment_id),
         payment_intent_id = COALESCE($5, payment_intent_id),
         metadata = metadata || $6,
         completed_at = COALESCE(completed_at, now()),
         updated_at = now()
     WHERE id = $1`,
    [
      pending.id,
      result.workspace.id,
      result.user.id,
      customerId ? String(customerId) : null,
      paymentId,
      completionMetadata,
    ]
  );

  try {
    refundResult = await refundRazorpayTrialSignupVerification({
      pending: { ...pending, provider_payment_id: paymentId },
      paymentId,
      workspaceId: result.workspace.id,
    });
    completionStatus = refundResult.refundId ? "provisioned" : "provisioned_refund_pending";
  } catch (refundErr) {
    completionStatus = "provisioned_refund_failed";
    completionMetadata = {
      ...completionMetadata,
      refundError: refundErr.message,
    };
    console.error("[billing] Razorpay trial signup verification refund failed:", refundErr.message);
  }

  await db.query(
    `UPDATE trial_signup_checkout_sessions
     SET status = $8,
         workspace_id = $2,
         owner_user_id = $3,
         owner_password_hash = NULL,
         customer_id = COALESCE($4, customer_id),
         provider_payment_id = COALESCE($5, provider_payment_id),
         payment_intent_id = COALESCE($5, payment_intent_id),
         provider_refund_id = COALESCE($6, provider_refund_id),
         refund_id = COALESCE($6, refund_id),
         metadata = metadata || $7,
         completed_at = COALESCE(completed_at, now()),
         updated_at = now()
     WHERE id = $1`,
    [
      pending.id,
      result.workspace.id,
      result.user.id,
      customerId ? String(customerId) : null,
      paymentId,
      refundResult.refundId,
      completionMetadata,
      completionStatus,
    ]
  );

  return {
    workspaceId: result.workspace.id,
    workspace: result.workspace,
    user: result.user,
    token: result.token,
    refundId: refundResult.refundId,
    verificationAmount: pending.verification_amount,
    currency: pending.currency,
  };
}

export async function provisionRazorpayTrialSignupOrderCheckout({
  orderId,
  paymentId,
  signature,
  pendingSignupId = null,
}) {
  ensureRazorpayConfigured();
  if (!orderId || !paymentId) {
    throw Object.assign(new Error("orderId and paymentId are required."), { statusCode: 400 });
  }

  let pending = await getPendingRazorpayTrialSignupByOrder(orderId);
  if (!pending) {
    throw Object.assign(new Error("Razorpay signup order was not found."), { statusCode: 404 });
  }
  if (pendingSignupId && String(pending.id) !== String(pendingSignupId)) {
    throw Object.assign(new Error("Razorpay signup order does not match this signup attempt."), {
      statusCode: 400,
    });
  }

  const alreadyProvisioned = await buildProvisionedTrialSignupResult(pending);
  if (alreadyProvisioned) return alreadyProvisioned;

  verifyRazorpayOrderCheckoutSignature({ orderId, paymentId, signature });
  const payment = await fetchRazorpayPayment(paymentId);

  if (payment.order_id && payment.order_id !== orderId) {
    throw Object.assign(new Error("Razorpay order mismatch."), { statusCode: 400 });
  }
  if (payment.status !== "captured") {
    throw Object.assign(new Error("Razorpay verification payment has not been captured yet."), {
      statusCode: 409,
    });
  }
  if (payment.currency && String(payment.currency).toLowerCase() !== String(pending.currency).toLowerCase()) {
    throw Object.assign(new Error("Razorpay verification payment currency mismatch."), { statusCode: 400 });
  }
  if (Number(payment.amount) < Number(pending.verification_amount)) {
    throw Object.assign(new Error("Razorpay verification payment amount mismatch."), { statusCode: 400 });
  }

  const claim = await db.query(
    `UPDATE trial_signup_checkout_sessions
     SET status = 'provisioning',
         provider_payment_id = COALESCE($2, provider_payment_id),
         payment_intent_id = COALESCE($2, payment_intent_id),
         provider_signature = COALESCE($3, provider_signature),
         customer_id = COALESCE($4, customer_id),
         metadata = metadata || $5,
         updated_at = now()
     WHERE id = $1
       AND workspace_id IS NULL
       AND owner_user_id IS NULL
       AND status <> 'provisioning'
     RETURNING *`,
    [
      pending.id,
      paymentId,
      signature || null,
      payment.customer_id || null,
      { razorpayPayment: payment, testOnlyOrderFallback: true },
    ]
  );

  if (!claim.rows[0]) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await wait(500);
      const latest = await getPendingTrialSignupById(pending.id);
      const provisioned = await buildProvisionedTrialSignupResult(latest);
      if (provisioned) return provisioned;
    }
    throw Object.assign(
      new Error("Signup checkout is still being completed. Please try again in a few seconds."),
      { statusCode: 409 }
    );
  }
  pending = claim.rows[0];

  const result = await createSelfServeTrialWorkspace({
    workspaceName: pending.workspace_name,
    ownerName: pending.owner_name,
    ownerEmail: pending.owner_email,
    ownerPasswordHash: pending.owner_password_hash || null,
    ipHash: pending.consent_ip_hash || null,
    avatarUrl: pending.avatar_url || null,
    skipTrialIpCheck: true,
  });

  await db.query(
    `INSERT INTO payment_checkout_sessions (
       workspace_id, user_id, provider, checkout_session_id, customer_id,
       subscription_id, price_id, billing_plan, status, session_type,
       seat_quantity, success_url, cancel_url, metadata, completed_at, created_at, updated_at
     )
     VALUES ($1,$2,'razorpay',$3,$4,NULL,NULL,$5,$6,$7,1,NULL,NULL,$8,now(),now(),now())
     ON CONFLICT (provider, checkout_session_id)
     DO UPDATE SET
       workspace_id     = EXCLUDED.workspace_id,
       user_id          = EXCLUDED.user_id,
       customer_id      = COALESCE(EXCLUDED.customer_id, payment_checkout_sessions.customer_id),
       billing_plan     = EXCLUDED.billing_plan,
       status           = EXCLUDED.status,
       session_type     = EXCLUDED.session_type,
       completed_at     = COALESCE(payment_checkout_sessions.completed_at, now()),
       metadata         = payment_checkout_sessions.metadata || EXCLUDED.metadata,
       updated_at       = now()`,
    [
      result.workspace.id,
      result.user.id,
      orderId,
      payment.customer_id ? String(payment.customer_id) : null,
      pending.billing_plan,
      payment.status || "captured",
      TRIAL_SIGNUP_SESSION_TYPE,
      {
        razorpayPayment: payment,
        testOnlyOrderFallback: true,
      },
    ]
  );

  let refundResult = { refundId: null, paymentId };
  let completionStatus = "provisioned_refund_pending";
  let completionMetadata = { provisionedFromRazorpayOrderFallback: true };

  await db.query(
    `UPDATE trial_signup_checkout_sessions
     SET status = 'provisioned_refund_pending',
         workspace_id = $2,
         owner_user_id = $3,
         owner_password_hash = NULL,
         provider_payment_id = COALESCE($4, provider_payment_id),
         payment_intent_id = COALESCE($4, payment_intent_id),
         metadata = metadata || $5,
         completed_at = COALESCE(completed_at, now()),
         updated_at = now()
     WHERE id = $1`,
    [
      pending.id,
      result.workspace.id,
      result.user.id,
      paymentId,
      completionMetadata,
    ]
  );

  try {
    refundResult = await refundRazorpayTrialSignupVerification({
      pending: { ...pending, provider_payment_id: paymentId },
      paymentId,
      workspaceId: result.workspace.id,
    });
    completionStatus = refundResult.refundId ? "provisioned" : "provisioned_refund_pending";
  } catch (refundErr) {
    completionStatus = "provisioned_refund_failed";
    completionMetadata = {
      ...completionMetadata,
      refundError: refundErr.message,
    };
    console.error("[billing] Razorpay order fallback verification refund failed:", refundErr.message);
  }

  await db.query(
    `UPDATE trial_signup_checkout_sessions
     SET status = $7,
         workspace_id = $2,
         owner_user_id = $3,
         owner_password_hash = NULL,
         provider_payment_id = COALESCE($4, provider_payment_id),
         payment_intent_id = COALESCE($4, payment_intent_id),
         provider_refund_id = COALESCE($5, provider_refund_id),
         refund_id = COALESCE($5, refund_id),
         metadata = metadata || $6,
         completed_at = COALESCE(completed_at, now()),
         updated_at = now()
     WHERE id = $1`,
    [
      pending.id,
      result.workspace.id,
      result.user.id,
      paymentId,
      refundResult.refundId,
      completionMetadata,
      completionStatus,
    ]
  );

  return {
    workspaceId: result.workspace.id,
    workspace: result.workspace,
    user: result.user,
    token: result.token,
    refundId: refundResult.refundId,
    verificationAmount: pending.verification_amount,
    currency: pending.currency,
  };
}

export async function completeRazorpayTrialSignupCheckoutSession({
  subscriptionId,
  orderId,
  paymentId,
  signature,
  pendingSignupId = null,
}) {
  const provisioned = orderId
    ? await provisionRazorpayTrialSignupOrderCheckout({
        orderId,
        paymentId,
        signature,
        pendingSignupId,
      })
    : await provisionRazorpayTrialSignupCheckout({
        subscriptionId,
        paymentId,
        signature,
        pendingSignupId,
      });
  const user = provisioned.user || (await getUserById(provisioned.userId));
  const token = provisioned.token || generateToken(user);
  return {
    token,
    user,
    workspace: provisioned.workspace || { id: provisioned.workspaceId },
    refundId: provisioned.refundId,
    verificationAmount: provisioned.verificationAmount,
    currency: provisioned.currency,
  };
}

export async function verifyRazorpayWorkspaceSubscriptionPayment({
  workspaceId,
  userId,
  subscriptionId,
  paymentId,
  signature,
}) {
  ensureRazorpayConfigured();
  if (!workspaceId || !subscriptionId || !paymentId || !signature) {
    throw Object.assign(new Error("Razorpay payment verification details are required."), { statusCode: 400 });
  }

  const checkoutRes = await db.query(
    `SELECT *
     FROM payment_checkout_sessions
     WHERE workspace_id = $1
       AND provider = 'razorpay'
       AND checkout_session_id = $2
       AND session_type = 'subscription'
     LIMIT 1`,
    [workspaceId, subscriptionId]
  );
  const checkout = checkoutRes.rows[0] || null;
  if (!checkout) {
    throw Object.assign(new Error("Razorpay subscription checkout was not found."), { statusCode: 404 });
  }

  verifyRazorpaySubscriptionCheckoutSignature({ subscriptionId, paymentId, signature });

  const [payment, subscription] = await Promise.all([
    fetchRazorpayPayment(paymentId),
    fetchRazorpaySubscription(subscriptionId),
  ]);

  if (payment.status !== "captured") {
    throw Object.assign(new Error("Razorpay payment has not been captured yet."), { statusCode: 409 });
  }
  if (!["authenticated", "active"].includes(subscription.status)) {
    throw Object.assign(new Error(`Razorpay subscription is ${subscription.status}.`), { statusCode: 409 });
  }

  const customerId = subscription.customer_id || payment.customer_id || null;
  if (customerId) {
    await upsertPaymentCustomer({
      workspaceId,
      provider: "razorpay",
      customerId: String(customerId),
      email: subscription.customer_email || payment.email || null,
      currency: subscription.currency || payment.currency || checkout.metadata?.currency || null,
      metadata: {
        razorpay_subscription_id: subscription.id,
        user_id: userId || "",
      },
    });
  }

  const dbPlan =
    checkout.billing_plan
      ? await getPlanBySlug(checkout.billing_plan)
      : await getPlanByRazorpayPlanId(subscription.plan_id);
  await upsertSubscriptionFromRazorpay(
    {
      ...subscription,
      notes: {
        ...(subscription.notes || {}),
        workspace_id: workspaceId,
        user_id: userId || "",
        billing_plan: dbPlan?.slug || checkout.billing_plan || null,
        billing_plan_id: dbPlan?.id || null,
        billing_interval: checkout.metadata?.billingInterval || checkout.metadata?.billing_interval || null,
      },
    },
    workspaceId,
    {
      billing_plan: dbPlan?.slug || checkout.billing_plan || null,
      billing_plan_id: dbPlan?.id || null,
      billing_interval: checkout.metadata?.billingInterval || checkout.metadata?.billing_interval || null,
      currency: checkout.metadata?.currency || payment.currency || null,
    }
  );

  let refund = null;
  const verificationAmount = Number(checkout.metadata?.verificationAmount || 0);
  if (verificationAmount > 0 && Number(payment.amount) >= verificationAmount) {
    try {
      refund = await razorpayRequest("post", `/payments/${encodeURIComponent(paymentId)}/refund`, {
        data: {
          amount: verificationAmount,
          speed: "optimum",
          receipt: `sub_${String(checkout.id).replace(/-/g, "").slice(0, 24)}`,
          notes: {
            purpose: "workspace_subscription_card_verification_refund",
            workspace_id: workspaceId,
            razorpay_subscription_id: subscriptionId,
          },
        },
      });
    } catch (refundErr) {
      console.error("[billing] Razorpay subscription verification refund failed:", refundErr.message);
    }
  }

  await db.query(
    `UPDATE payment_checkout_sessions
     SET customer_id = COALESCE($2, customer_id),
         subscription_id = $3,
         status = $4,
         completed_at = COALESCE(completed_at, now()),
         metadata = metadata || $5,
         updated_at = now()
     WHERE workspace_id = $1
       AND provider = 'razorpay'
       AND checkout_session_id = $3`,
    [
      workspaceId,
      customerId ? String(customerId) : null,
      subscriptionId,
      subscription.status || "authenticated",
      {
        razorpayPayment: payment,
        razorpaySubscription: subscription,
        razorpayRefund: refund,
      },
    ]
  );

  return {
    verified: true,
    provider: "razorpay",
    subscriptionId,
    status: subscription.status,
    refundId: refund?.id || null,
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
  const subRes = await db.query(
    `SELECT provider, subscription_id, current_period_end
     FROM workspace_subscriptions
     WHERE workspace_id = $1
       AND provider IN ('razorpay', 'stripe')
     ORDER BY CASE provider WHEN 'razorpay' THEN 0 ELSE 1 END
     LIMIT 1`,
    [workspaceId]
  );

  const subscriptionId = subRes.rows[0]?.subscription_id || null;
  if (!subscriptionId) {
    const err = new Error("No active subscription found for this workspace");
    err.statusCode = 404;
    throw err;
  }
  const provider = subRes.rows[0].provider;

  if (provider === "razorpay") {
    const subscription = await razorpayRequest(
      "post",
      `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
      { data: { cancel_at_cycle_end: true } }
    );

    await db.query(
      `UPDATE workspace_subscriptions
       SET cancel_at_period_end = true,
           status = COALESCE($2, status),
           current_period_end = COALESCE($3, current_period_end),
           metadata = metadata || $4,
           updated_at = now()
       WHERE workspace_id = $1 AND provider = 'razorpay'`,
      [
        workspaceId,
        subscription.status || null,
        razorpayTimestampToIso(subscription.current_end || subscription.end_at),
        { razorpaySubscription: subscription },
      ]
    );

    return {
      cancelled: true,
      provider: "razorpay",
      effectiveDate: razorpayTimestampToIso(subscription.current_end || subscription.end_at),
    };
  }

  ensureStripeConfigured();

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
    provider:      "stripe",
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

  if (sessionType === TRIAL_SIGNUP_SESSION_TYPE) {
    await provisionTrialSignupCheckoutSession(session);
    return;
  }

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
  if ((session.metadata?.session_type || "") === TRIAL_SIGNUP_SESSION_TYPE) {
    await db.query(
      `UPDATE trial_signup_checkout_sessions
       SET status = 'expired',
           owner_password_hash = NULL,
           updated_at = now()
       WHERE provider = 'stripe' AND checkout_session_id = $1`,
      [session.id]
    );
    return;
  }
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

function verifyRazorpayWebhookSignature(rawBody, signatureHeader) {
  const secret = getRazorpayWebhookSecret();
  if (!secret) {
    const err = new Error("Razorpay webhook secret is not configured.");
    err.statusCode = 503;
    throw err;
  }
  if (!signatureHeader) {
    const err = new Error("Missing Razorpay webhook signature.");
    err.statusCode = 400;
    throw err;
  }

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(String(signatureHeader), "hex");
  if (
    expectedBuffer.length !== actualBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    const err = new Error("Invalid Razorpay webhook signature.");
    err.statusCode = 400;
    throw err;
  }

  return JSON.parse(rawBody.toString("utf8"));
}

async function persistRazorpayWebhookEvent(event, eventId) {
  const resolvedEventId =
    eventId ||
    event.id ||
    crypto.createHash("sha256").update(JSON.stringify(event)).digest("hex");
  const eventType = event.event || event.type || "unknown";

  const inserted = await db.query(
    `INSERT INTO payment_webhook_events (
       provider, provider_event_id, event_type, api_version, livemode, payload, created_at
     )
     VALUES ('razorpay', $1, $2, NULL, $3, $4, now())
     ON CONFLICT (provider, provider_event_id) DO NOTHING
     RETURNING id, processed_at, processing_error`,
    [resolvedEventId, eventType, isRazorpayLiveMode(), event]
  );

  if (inserted.rowCount > 0) {
    return { shouldProcess: true, duplicate: false, eventId: resolvedEventId, eventType };
  }

  const existing = await db.query(
    `SELECT processed_at, processing_error
     FROM payment_webhook_events
     WHERE provider = 'razorpay' AND provider_event_id = $1
     LIMIT 1`,
    [resolvedEventId]
  );
  const row = existing.rows[0];
  return {
    shouldProcess: !row?.processed_at || !!row?.processing_error,
    duplicate: true,
    eventId: resolvedEventId,
    eventType,
  };
}

async function markRazorpayWebhookEventProcessed(eventId) {
  await db.query(
    `UPDATE payment_webhook_events
     SET processed_at = now(), processing_error = null
     WHERE provider = 'razorpay' AND provider_event_id = $1`,
    [eventId]
  );
}

async function markRazorpayWebhookEventFailed(eventId, processingError) {
  await db.query(
    `UPDATE payment_webhook_events
     SET processed_at = null, processing_error = $2
     WHERE provider = 'razorpay' AND provider_event_id = $1`,
    [eventId, processingError]
  );
}

function getRazorpayPaymentEntity(event) {
  return event.payload?.payment?.entity || null;
}

function getRazorpaySubscriptionEntity(event) {
  return event.payload?.subscription?.entity || null;
}

async function handleRazorpayPaymentCaptured(event) {
  const payment = getRazorpayPaymentEntity(event);
  if (!payment?.id) return;

  const subscriptionId =
    payment.subscription_id ||
    payment.notes?.razorpay_subscription_id ||
    payment.notes?.subscription_id ||
    null;
  if (!subscriptionId) return;

  await db.query(
    `UPDATE trial_signup_checkout_sessions
     SET provider_payment_id = COALESCE($2, provider_payment_id),
         payment_intent_id = COALESCE($2, payment_intent_id),
         status = CASE
           WHEN status IN ('created', 'authenticated') THEN 'payment_captured'
           ELSE status
         END,
         metadata = metadata || $3,
         updated_at = now()
     WHERE provider = 'razorpay'
       AND subscription_id = $1`,
    [subscriptionId, payment.id, { razorpayPaymentCaptured: payment }]
  );

  const pending = await getPendingRazorpayTrialSignupBySubscription(subscriptionId);
  if (pending && !pending.workspace_id && pending.status !== "provisioning") {
    await provisionRazorpayTrialSignupCheckout({
      subscriptionId,
      paymentId: payment.id,
      trustedWebhook: true,
    });
  }
}

async function handleRazorpaySubscriptionEvent(event) {
  const subscription = getRazorpaySubscriptionEntity(event);
  if (!subscription?.id) return;

  const pending =
    (subscription.notes?.pending_signup_id
      ? await getPendingTrialSignupById(subscription.notes.pending_signup_id)
      : null) ||
    (await getPendingRazorpayTrialSignupBySubscription(subscription.id));

  const existing = await db.query(
    `SELECT workspace_id
     FROM workspace_subscriptions
     WHERE provider = 'razorpay' AND subscription_id = $1
     LIMIT 1`,
    [subscription.id]
  );

  const workspaceId =
    subscription.notes?.workspace_id ||
    pending?.workspace_id ||
    existing.rows[0]?.workspace_id ||
    null;

  if (pending) {
    await db.query(
      `UPDATE trial_signup_checkout_sessions
       SET status = CASE
             WHEN status IN ('created', 'open', 'payment_captured') THEN $2
             ELSE status
           END,
           customer_id = COALESCE($3, customer_id),
           metadata = metadata || $4,
           updated_at = now()
       WHERE id = $1`,
      [
        pending.id,
        subscription.status || "created",
        subscription.customer_id || null,
        { razorpaySubscriptionEvent: subscription },
      ]
    );
  }

  if (workspaceId) {
    await upsertSubscriptionFromRazorpay(subscription, workspaceId, pending);
  }

  if (workspaceId && subscription.status === "cancelled") {
    const starterPlan = await getPlanBySlug("starter");
    const starterLimit = starterPlan?.member_limit || 10;
    await db.query(
      `UPDATE workspaces
       SET billing_status = 'active',
           billing_plan = 'starter',
           plan = 'starter',
           member_limit = $2,
           max_members = $2,
           billing_updated_at = now()
       WHERE id = $1`,
      [workspaceId, starterLimit]
    );
  }
}

export async function processRazorpayWebhook(rawBody, signatureHeader, eventIdHeader = null) {
  const event = verifyRazorpayWebhookSignature(rawBody, signatureHeader);
  const persisted = await persistRazorpayWebhookEvent(event, eventIdHeader);

  if (!persisted.shouldProcess) {
    return { duplicate: true, eventId: persisted.eventId, type: persisted.eventType };
  }

  try {
    switch (event.event) {
      case "payment.captured":
        await handleRazorpayPaymentCaptured(event);
        break;
      case "subscription.authenticated":
      case "subscription.activated":
      case "subscription.charged":
      case "subscription.completed":
      case "subscription.cancelled":
      case "subscription.pending":
      case "subscription.halted":
        await handleRazorpaySubscriptionEvent(event);
        break;
      default:
        break;
    }

    await markRazorpayWebhookEventProcessed(persisted.eventId);
    return { received: true, eventId: persisted.eventId, type: persisted.eventType };
  } catch (error) {
    await markRazorpayWebhookEventFailed(persisted.eventId, error.message);
    throw error;
  }
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
