// repositories/billingPlans.repository.js
import pool from "../db.js";

// ── Read ──────────────────────────────────────────────────────────────────────

export async function listPlans({ includeInactive = false } = {}) {
  const where = includeInactive ? "" : "WHERE bp.is_active = true";
  const res = await pool.query(`
    SELECT
      bp.*,
      COUNT(DISTINCT w.id) FILTER (
        WHERE w.billing_status = 'active'
           OR (w.billing_plan = bp.slug AND w.billing_status IS NULL)
      )::int AS subscriber_count
    FROM billing_plans bp
    LEFT JOIN workspaces w
      ON (w.billing_plan = bp.slug OR w.plan = bp.slug)
    ${where}
    GROUP BY bp.id
    ORDER BY bp.display_order ASC, bp.created_at ASC
  `);
  return res.rows;
}

export async function getPlanById(id) {
  const res = await pool.query(
    `SELECT * FROM billing_plans WHERE id = $1 LIMIT 1`,
    [id]
  );
  return res.rows[0] || null;
}

export async function getPlanBySlug(slug) {
  const res = await pool.query(
    `SELECT * FROM billing_plans WHERE slug = $1 AND is_active = true LIMIT 1`,
    [slug]
  );
  return res.rows[0] || null;
}

// ── Write ─────────────────────────────────────────────────────────────────────

export async function createPlan({
  name,
  slug,
  tagline,
  description,
  price_monthly_paise,
  price_yearly_paise,
  yearly_discount_pct = 0,
  member_limit,
  max_projects,
  max_integrations,
  storage_limit_gb,
  features = [],
  support_level = "community",
  trial_days = 7,
  grace_period_days = 3,
  is_popular = false,
  is_custom = false,
  display_order = 0,
}) {
  const res = await pool.query(
    `INSERT INTO billing_plans (
       name, slug, tagline, description,
       price_monthly_paise, price_yearly_paise, yearly_discount_pct,
       member_limit, max_projects, max_integrations, storage_limit_gb,
       features, support_level, trial_days, grace_period_days,
       is_popular, is_custom, display_order
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING *`,
    [
      name, slug, tagline || null, description || null,
      price_monthly_paise, price_yearly_paise, yearly_discount_pct,
      member_limit,
      max_projects || null, max_integrations || null, storage_limit_gb || null,
      JSON.stringify(features),
      support_level, trial_days, grace_period_days,
      is_popular, is_custom, display_order,
    ]
  );
  return res.rows[0];
}

export async function updatePlan(id, data) {
  const allowed = [
    "name", "tagline", "description",
    "price_monthly_paise", "price_yearly_paise", "yearly_discount_pct",
    "member_limit", "max_projects", "max_integrations", "storage_limit_gb",
    "features", "support_level", "trial_days", "grace_period_days",
    "is_active", "is_popular", "is_custom", "display_order",
  ];

  const sets = [];
  const vals = [];
  let i = 1;

  for (const key of allowed) {
    if (data[key] !== undefined) {
      sets.push(`${key} = $${i++}`);
      vals.push(key === "features" ? JSON.stringify(data[key]) : data[key]);
    }
  }

  if (!sets.length) throw new Error("Nothing to update");

  sets.push(`updated_at = now()`);
  vals.push(id);

  const res = await pool.query(
    `UPDATE billing_plans SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    vals
  );
  return res.rows[0];
}

export async function saveRazorpayPlanIds(id, { monthly, yearly }) {
  const res = await pool.query(
    `UPDATE billing_plans
     SET razorpay_monthly_plan_id = COALESCE($2, razorpay_monthly_plan_id),
         razorpay_yearly_plan_id  = COALESCE($3, razorpay_yearly_plan_id),
         updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, monthly || null, yearly || null]
  );
  return res.rows[0];
}

export async function deactivatePlan(id) {
  const res = await pool.query(
    `UPDATE billing_plans SET is_active = false, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id]
  );
  return res.rows[0];
}

// ── Subscription helpers ──────────────────────────────────────────────────────

export async function upsertWorkspaceSubscription({
  workspaceId,
  billingPlanId,
  razorpaySubscriptionId,
  razorpayCustomerId,
  mandateId,
  status,
  billingInterval,
  trialEndsAt,
  nextBillingAt,
  currentPeriodStart,
  currentPeriodEnd,
}) {
  const res = await pool.query(
    `INSERT INTO workspace_subscriptions (
       workspace_id, provider, billing_plan_id,
       subscription_id, razorpay_customer_id, mandate_id,
       status, billing_interval,
       trial_ends_at, next_billing_at,
       current_period_start, current_period_end,
       auth_amount_paise, created_at, updated_at
     )
     VALUES ($1,'razorpay',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,100,now(),now())
     ON CONFLICT (workspace_id, provider)
     DO UPDATE SET
       billing_plan_id     = EXCLUDED.billing_plan_id,
       subscription_id     = EXCLUDED.subscription_id,
       razorpay_customer_id = EXCLUDED.razorpay_customer_id,
       mandate_id          = COALESCE(EXCLUDED.mandate_id, workspace_subscriptions.mandate_id),
       status              = EXCLUDED.status,
       billing_interval    = EXCLUDED.billing_interval,
       trial_ends_at       = EXCLUDED.trial_ends_at,
       next_billing_at     = EXCLUDED.next_billing_at,
       current_period_start = EXCLUDED.current_period_start,
       current_period_end  = EXCLUDED.current_period_end,
       updated_at          = now()
     RETURNING *`,
    [
      workspaceId, billingPlanId || null,
      razorpaySubscriptionId, razorpayCustomerId || null, mandateId || null,
      status, billingInterval || "monthly",
      trialEndsAt || null, nextBillingAt || null,
      currentPeriodStart || null, currentPeriodEnd || null,
    ]
  );
  return res.rows[0];
}

export async function getWorkspaceSubscription(workspaceId) {
  const res = await pool.query(
    `SELECT ws.*, bp.name AS plan_name, bp.slug AS plan_slug,
            bp.price_monthly_paise, bp.price_yearly_paise,
            bp.member_limit, bp.features, bp.support_level
     FROM workspace_subscriptions ws
     LEFT JOIN billing_plans bp ON bp.id = ws.billing_plan_id
     WHERE ws.workspace_id = $1 AND ws.provider = 'razorpay'
     LIMIT 1`,
    [workspaceId]
  );
  return res.rows[0] || null;
}

export async function markAuthRefunded(workspaceId) {
  await pool.query(
    `UPDATE workspace_subscriptions
     SET auth_refunded = true, updated_at = now()
     WHERE workspace_id = $1 AND provider = 'razorpay'`,
    [workspaceId]
  );
}

export async function recordPayment(workspaceId, { paymentId, failureCount = 0 }) {
  await pool.query(
    `UPDATE workspace_subscriptions
     SET last_payment_id = $2,
         last_payment_at = now(),
         payment_failure_count = $3,
         updated_at = now()
     WHERE workspace_id = $1 AND provider = 'razorpay'`,
    [workspaceId, paymentId, failureCount]
  );
}
