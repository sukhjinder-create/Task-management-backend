import crypto from "crypto";
import axios from "axios";
import qs from "qs";
import db from "../db.js";

const STRIPE_API_BASE = "https://api.stripe.com";
const DEFAULT_FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

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

function normalizePlanLabel(key) {
  return key.replace(/_/g, " ");
}

function getPlanCatalog() {
  const catalog = {
    basic: {
      monthly: process.env.STRIPE_PRICE_BASIC_MONTHLY || null,
      yearly: process.env.STRIPE_PRICE_BASIC_YEARLY || null,
    },
    pro: {
      monthly: process.env.STRIPE_PRICE_PRO_MONTHLY || null,
      yearly: process.env.STRIPE_PRICE_PRO_YEARLY || null,
    },
    enterprise: {
      monthly: process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY || null,
      yearly: process.env.STRIPE_PRICE_ENTERPRISE_YEARLY || null,
    },
  };

  return Object.entries(catalog).reduce((acc, [plan, intervals]) => {
    const filteredIntervals = Object.entries(intervals).reduce((obj, [interval, priceId]) => {
      if (priceId) obj[interval] = priceId;
      return obj;
    }, {});

    if (Object.keys(filteredIntervals).length > 0) {
      acc[plan] = filteredIntervals;
    }
    return acc;
  }, {});
}

function getReversePriceLookup(planCatalog) {
  const reverse = new Map();
  for (const [plan, intervals] of Object.entries(planCatalog)) {
    for (const [interval, priceId] of Object.entries(intervals)) {
      reverse.set(priceId, { plan, interval });
    }
  }
  return reverse;
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

async function upsertPaymentCustomer({
  workspaceId,
  customerId,
  email,
  currency,
  metadata = {},
}) {
  await db.query(
    `INSERT INTO payment_customers (workspace_id, provider, customer_id, email, currency, metadata, created_at, updated_at)
     VALUES ($1, 'stripe', $2, $3, $4, $5, now(), now())
     ON CONFLICT (workspace_id, provider)
     DO UPDATE SET
       customer_id = EXCLUDED.customer_id,
       email = COALESCE(EXCLUDED.email, payment_customers.email),
       currency = COALESCE(EXCLUDED.currency, payment_customers.currency),
       metadata = payment_customers.metadata || EXCLUDED.metadata,
       updated_at = now()`,
    [workspaceId, customerId, email || null, currency || null, metadata]
  );

  await db.query(
    `UPDATE workspaces
     SET billing_provider = 'stripe',
         billing_customer_id = $2,
         billing_updated_at = now()
     WHERE id = $1`,
    [workspaceId, customerId]
  );
}

function stripeTimestampToIso(value) {
  if (!value) return null;
  return new Date(value * 1000).toISOString();
}

// Member limits that correspond to each plan name.
// Keep in sync with WorkspaceBilling.jsx PLAN_META.
const PLAN_MEMBER_LIMITS = {
  basic:      10,
  pro:        50,
  enterprise: 200,
};

async function updateWorkspaceBillingState({
  workspaceId,
  billingPlan,
  status,
  customerId,
  subscriptionId,
  currentPeriodEnd,
}) {
  // Derive the member cap for this plan so enforcement columns stay in sync.
  const memberLimit = billingPlan ? (PLAN_MEMBER_LIMITS[billingPlan] ?? null) : null;

  await db.query(
    `UPDATE workspaces
     SET billing_plan    = COALESCE($2, billing_plan),
         billing_status  = $3,
         billing_provider = 'stripe',
         billing_customer_id        = COALESCE($4, billing_customer_id),
         billing_subscription_id    = COALESCE($5, billing_subscription_id),
         billing_current_period_end = COALESCE($6, billing_current_period_end),
         billing_updated_at = now(),
         -- Keep the "old" columns in sync so the superadmin page and
         -- member-limit enforcement both see the new plan immediately.
         plan         = COALESCE($2, plan),
         member_limit = COALESCE($7, member_limit),
         max_members  = COALESCE($7, max_members)
     WHERE id = $1`,
    [
      workspaceId,
      billingPlan || null,
      status || null,
      customerId || null,
      subscriptionId || null,
      currentPeriodEnd || null,
      memberLimit,
    ]
  );
}

async function upsertSubscriptionFromStripe(subscription, explicitWorkspaceId = null) {
  const item = subscription.items?.data?.[0] || null;
  const price = item?.price || null;
  const planCatalog = getPlanCatalog();
  const reverseLookup = getReversePriceLookup(planCatalog);
  const mappedPlan = reverseLookup.get(price?.id || "") || null;

  let workspaceId =
    explicitWorkspaceId ||
    subscription.metadata?.workspace_id ||
    null;

  if (!workspaceId && subscription.customer) {
    const customerRes = await db.query(
      `SELECT workspace_id
       FROM payment_customers
       WHERE provider = 'stripe' AND customer_id = $1
       LIMIT 1`,
      [String(subscription.customer)]
    );
    workspaceId = customerRes.rows[0]?.workspace_id || null;
  }

  if (!workspaceId) {
    throw new Error(`Unable to resolve workspace for Stripe subscription ${subscription.id}`);
  }

  await db.query(
    `INSERT INTO workspace_subscriptions (
       workspace_id, provider, customer_id, subscription_id, status, billing_plan,
       price_id, product_id, currency, interval, cancel_at_period_end, trial_ends_at,
       current_period_start, current_period_end, metadata, created_at, updated_at
     )
     VALUES (
       $1, 'stripe', $2, $3, $4, $5,
       $6, $7, $8, $9, $10, $11,
       $12, $13, $14, now(), now()
     )
     ON CONFLICT (workspace_id, provider)
     DO UPDATE SET
       customer_id = EXCLUDED.customer_id,
       subscription_id = EXCLUDED.subscription_id,
       status = EXCLUDED.status,
       billing_plan = COALESCE(EXCLUDED.billing_plan, workspace_subscriptions.billing_plan),
       price_id = EXCLUDED.price_id,
       product_id = EXCLUDED.product_id,
       currency = EXCLUDED.currency,
       interval = EXCLUDED.interval,
       cancel_at_period_end = EXCLUDED.cancel_at_period_end,
       trial_ends_at = EXCLUDED.trial_ends_at,
       current_period_start = EXCLUDED.current_period_start,
       current_period_end = EXCLUDED.current_period_end,
       metadata = workspace_subscriptions.metadata || EXCLUDED.metadata,
       updated_at = now()`,
    [
      workspaceId,
      subscription.customer ? String(subscription.customer) : null,
      subscription.id,
      subscription.status,
      subscription.metadata?.billing_plan || mappedPlan?.plan || null,
      price?.id || null,
      price?.product ? String(price.product) : null,
      price?.currency || null,
      price?.recurring?.interval || mappedPlan?.interval || null,
      !!subscription.cancel_at_period_end,
      stripeTimestampToIso(subscription.trial_end),
      stripeTimestampToIso(subscription.current_period_start),
      stripeTimestampToIso(subscription.current_period_end),
      subscription.metadata || {},
    ]
  );

  await updateWorkspaceBillingState({
    workspaceId,
    billingPlan: subscription.metadata?.billing_plan || mappedPlan?.plan || null,
    status: subscription.status,
    customerId: subscription.customer ? String(subscription.customer) : null,
    subscriptionId: subscription.id,
    currentPeriodEnd: stripeTimestampToIso(subscription.current_period_end),
  });

  return { workspaceId };
}

export function getPublicBillingConfig() {
  const planCatalog = getPlanCatalog();

  return {
    provider: "stripe",
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
    checkoutEnabled: !!getStripeSecretKey(),
    plans: Object.entries(planCatalog).map(([plan, intervals]) => ({
      plan,
      label: normalizePlanLabel(plan),
      intervals: Object.entries(intervals).map(([interval, priceId]) => ({
        interval,
        priceId,
      })),
    })),
  };
}

export async function getWorkspaceBillingSummary(workspaceId) {
  const [workspaceRes, subscriptionRes, sessionsRes] = await Promise.all([
    db.query(
      `SELECT id, name, billing_plan, billing_status, billing_provider,
              billing_customer_id, billing_subscription_id,
              billing_current_period_end, billing_updated_at
       FROM workspaces
       WHERE id = $1
       LIMIT 1`,
      [workspaceId]
    ),
    db.query(
      `SELECT *
       FROM workspace_subscriptions
       WHERE workspace_id = $1 AND provider = 'stripe'
       LIMIT 1`,
      [workspaceId]
    ),
    db.query(
      `SELECT id, checkout_session_id, billing_plan, price_id, status, created_at, completed_at
       FROM payment_checkout_sessions
       WHERE workspace_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [workspaceId]
    ),
  ]);

  return {
    config: getPublicBillingConfig(),
    workspace: workspaceRes.rows[0] || null,
    subscription: subscriptionRes.rows[0] || null,
    recentCheckoutSessions: sessionsRes.rows,
  };
}

export async function createCheckoutSession({
  workspace,
  user,
  plan,
  interval = "monthly",
  successUrl,
  cancelUrl,
}) {
  const planCatalog = getPlanCatalog();
  const priceId = planCatalog?.[plan]?.[interval] || null;

  if (!priceId) {
    const err = new Error(`Plan '${plan}' with interval '${interval}' is not configured.`);
    err.statusCode = 400;
    throw err;
  }

  const customer = await getOrCreateStripeCustomer({ workspace, user });
  const payload = qs.stringify(
    {
      mode: "subscription",
      success_url: resolveSuccessUrl(successUrl),
      cancel_url: resolveCancelUrl(cancelUrl),
      customer: customer.customerId,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": 1,
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      client_reference_id: workspace.id,
      "metadata[workspace_id]": workspace.id,
      "metadata[user_id]": user.id,
      "metadata[billing_plan]": plan,
      "subscription_data[metadata][workspace_id]": workspace.id,
      "subscription_data[metadata][user_id]": user.id,
      "subscription_data[metadata][billing_plan]": plan,
    },
    { encode: true }
  );

  const session = await stripeRequest("post", "/v1/checkout/sessions", {
    data: payload,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  await db.query(
    `INSERT INTO payment_checkout_sessions (
       workspace_id, user_id, provider, checkout_session_id, customer_id,
       subscription_id, price_id, billing_plan, status, success_url, cancel_url, metadata,
       created_at, updated_at
     )
     VALUES (
       $1, $2, 'stripe', $3, $4,
       $5, $6, $7, $8, $9, $10, $11,
       now(), now()
     )
     ON CONFLICT (provider, checkout_session_id)
     DO UPDATE SET
       customer_id = EXCLUDED.customer_id,
       subscription_id = COALESCE(EXCLUDED.subscription_id, payment_checkout_sessions.subscription_id),
       price_id = EXCLUDED.price_id,
       billing_plan = EXCLUDED.billing_plan,
       status = EXCLUDED.status,
       success_url = EXCLUDED.success_url,
       cancel_url = EXCLUDED.cancel_url,
       metadata = payment_checkout_sessions.metadata || EXCLUDED.metadata,
       updated_at = now()`,
    [
      workspace.id,
      user.id,
      session.id,
      customer.customerId,
      session.subscription ? String(session.subscription) : null,
      priceId,
      plan,
      session.status || "open",
      resolveSuccessUrl(successUrl),
      resolveCancelUrl(cancelUrl),
      session,
    ]
  );

  return {
    id: session.id,
    url: session.url,
    plan,
    interval,
    priceId,
  };
}

export async function createBillingPortalSession({
  workspaceId,
  returnUrl,
}) {
  const customerRes = await db.query(
    `SELECT customer_id
     FROM payment_customers
     WHERE workspace_id = $1 AND provider = 'stripe'
     LIMIT 1`,
    [workspaceId]
  );

  const customerId = customerRes.rows[0]?.customer_id || null;
  if (!customerId) {
    const err = new Error("No Stripe customer found for this workspace yet.");
    err.statusCode = 404;
    throw err;
  }

  const payload = qs.stringify(
    {
      customer: customerId,
      return_url: resolvePortalReturnUrl(returnUrl),
    },
    { encode: true }
  );

  const session = await stripeRequest("post", "/v1/billing_portal/sessions", {
    data: payload,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  return {
    url: session.url,
  };
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
      email: existingRes.rows[0].email || user.email || null,
    };
  }

  const payload = qs.stringify(
    {
      email: user.email || undefined,
      name: workspace.name,
      "metadata[workspace_id]": workspace.id,
      "metadata[workspace_name]": workspace.name,
      "metadata[user_id]": user.id,
    },
    { encode: true }
  );

  const customer = await stripeRequest("post", "/v1/customers", {
    data: payload,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  await upsertPaymentCustomer({
    workspaceId: workspace.id,
    customerId: customer.id,
    email: customer.email || user.email || null,
    currency: customer.currency || null,
    metadata: customer.metadata || {},
  });

  return {
    customerId: customer.id,
    email: customer.email || user.email || null,
  };
}

export function verifyStripeWebhookSignature(rawBody, signatureHeader) {
  const webhookSecret = getStripeWebhookSecret();
  if (!webhookSecret) {
    const err = new Error("Stripe webhook secret is not configured.");
    err.statusCode = 503;
    throw err;
  }

  if (!rawBody || !signatureHeader) {
    const err = new Error("Missing Stripe webhook payload or signature.");
    err.statusCode = 400;
    throw err;
  }

  const parts = signatureHeader.split(",").map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = parts
    .filter((part) => part.startsWith("v1="))
    .map((part) => part.slice(3));

  if (!timestamp || signatures.length === 0) {
    const err = new Error("Invalid Stripe signature header.");
    err.statusCode = 400;
    throw err;
  }

  const payload = `${timestamp}.${rawBody.toString("utf8")}`;
  const expected = crypto
    .createHmac("sha256", webhookSecret)
    .update(payload, "utf8")
    .digest("hex");

  const isValid = signatures.some((signature) => {
    const a = Buffer.from(signature, "hex");
    const b = Buffer.from(expected, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });

  if (!isValid) {
    const err = new Error("Stripe webhook signature verification failed.");
    err.statusCode = 400;
    throw err;
  }

  return JSON.parse(rawBody.toString("utf8"));
}

async function markWebhookEventProcessed(eventId, processingError = null) {
  await db.query(
    `UPDATE payment_webhook_events
     SET processed_at = now(),
         processing_error = $2
     WHERE provider = 'stripe' AND provider_event_id = $1`,
    [eventId, processingError]
  );
}

async function persistWebhookEvent(event) {
  const inserted = await db.query(
    `INSERT INTO payment_webhook_events (
       provider, provider_event_id, event_type, api_version,
       livemode, payload, created_at
     )
     VALUES ('stripe', $1, $2, $3, $4, $5, now())
     ON CONFLICT (provider, provider_event_id) DO NOTHING
     RETURNING id`,
    [event.id, event.type, event.api_version || null, !!event.livemode, event]
  );

  return inserted.rowCount > 0;
}

async function handleCheckoutSessionCompleted(event) {
  const session = event.data?.object;
  if (!session?.id) return;

  const workspaceId =
    session.metadata?.workspace_id ||
    session.client_reference_id ||
    null;

  await db.query(
    `UPDATE payment_checkout_sessions
     SET status = $2,
         customer_id = COALESCE($3, customer_id),
         subscription_id = COALESCE($4, subscription_id),
         completed_at = CASE WHEN $2 = 'complete' THEN now() ELSE completed_at END,
         metadata = metadata || $5,
         updated_at = now()
     WHERE provider = 'stripe' AND checkout_session_id = $1`,
    [
      session.id,
      session.status || "complete",
      session.customer ? String(session.customer) : null,
      session.subscription ? String(session.subscription) : null,
      session,
    ]
  );

  if (workspaceId && session.customer) {
    await upsertPaymentCustomer({
      workspaceId,
      customerId: String(session.customer),
      email: session.customer_details?.email || null,
      currency: session.currency || null,
      metadata: session.metadata || {},
    });
  }

  if (session.subscription) {
    const subscription = await stripeRequest(
      "get",
      `/v1/subscriptions/${session.subscription}?expand[]=items.data.price`
    );
    await upsertSubscriptionFromStripe(subscription, workspaceId);
  }
}

async function handleSubscriptionEvent(event) {
  const subscription = event.data?.object;
  if (!subscription?.id) return;
  await upsertSubscriptionFromStripe(subscription);
}

async function handleSubscriptionDeleted(event) {
  const subscription = event.data?.object;
  if (!subscription?.id) return;

  const res = await db.query(
    `SELECT workspace_id
     FROM workspace_subscriptions
     WHERE provider = 'stripe' AND subscription_id = $1
     LIMIT 1`,
    [subscription.id]
  );

  const workspaceId =
    subscription.metadata?.workspace_id ||
    res.rows[0]?.workspace_id ||
    null;

  if (!workspaceId) return;

  await db.query(
    `UPDATE workspace_subscriptions
     SET status = 'canceled',
         cancel_at_period_end = false,
         current_period_end = COALESCE($2, current_period_end),
         updated_at = now()
     WHERE workspace_id = $1 AND provider = 'stripe'`,
    [workspaceId, stripeTimestampToIso(subscription.current_period_end)]
  );

  await updateWorkspaceBillingState({
    workspaceId,
    billingPlan: "free",
    status: "canceled",
    customerId: subscription.customer ? String(subscription.customer) : null,
    subscriptionId: subscription.id,
    currentPeriodEnd: stripeTimestampToIso(subscription.current_period_end),
  });
}

export async function processStripeWebhook(rawBody, signatureHeader) {
  const event = verifyStripeWebhookSignature(rawBody, signatureHeader);
  const isNew = await persistWebhookEvent(event);

  if (!isNew) {
    return { duplicate: true, eventId: event.id, type: event.type };
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutSessionCompleted(event);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
        await handleSubscriptionEvent(event);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event);
        break;
      default:
        break;
    }

    await markWebhookEventProcessed(event.id, null);
    return { received: true, eventId: event.id, type: event.type };
  } catch (error) {
    await markWebhookEventProcessed(event.id, error.message);
    throw error;
  }
}
