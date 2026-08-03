// repositories/billingPlans.repository.js
import pool from "../db.js";

export async function listPlans({ includeInactive = false } = {}) {
  const where = includeInactive ? "" : "WHERE bp.is_active = true";
  const res = await pool.query(`
    SELECT
      bp.*,
      COUNT(DISTINCT w.id)::int AS subscriber_count
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

export async function getPlanByStripePriceId(priceId) {
  if (!priceId) return null;

  const res = await pool.query(
    `SELECT bp.*
       FROM billing_plans bp
      WHERE bp.is_active = true
        AND (
          $1 = bp.stripe_price_monthly_id
          OR $1 = bp.stripe_price_yearly_id
          OR EXISTS (
            SELECT 1 FROM billing_plan_provider_prices pp
             WHERE pp.plan_id = bp.id
               AND pp.provider = 'stripe'
               AND pp.provider_price_id = $1
          )
        )
      LIMIT 1`,
    [priceId]
  );
  return res.rows[0] || null;
}

export async function getPlanByRazorpayPlanId(planId) {
  if (!planId) return null;

  const res = await pool.query(
    `SELECT bp.*
       FROM billing_plans bp
      WHERE bp.is_active = true
        AND (
          $1 = bp.razorpay_plan_monthly_id
          OR $1 = bp.razorpay_plan_yearly_id
          OR EXISTS (
            SELECT 1 FROM billing_plan_provider_prices pp
             WHERE pp.plan_id = bp.id
               AND pp.provider = 'razorpay'
               AND pp.provider_price_id = $1
          )
        )
      LIMIT 1`,
    [planId]
  );
  return res.rows[0] || null;
}

export async function createPlan({
  name,
  slug,
  tagline,
  description,
  price_monthly_minor,
  price_yearly_minor,
  base_currency = "usd",
  yearly_discount_pct = 0,
  member_limit,
  max_projects,
  max_integrations,
  storage_limit_gb,
  features = [],
  support_level = "community",
  trial_days = 7,
  grace_period_days = 3,
  is_active = true,
  is_popular = false,
  is_custom = false,
  display_order = 0,
}) {
  const res = await pool.query(
    `INSERT INTO billing_plans (
       name, slug, tagline, description,
       price_monthly_minor, price_yearly_minor, base_currency, yearly_discount_pct,
       member_limit, max_projects, max_integrations, storage_limit_gb,
       features, support_level, trial_days, grace_period_days,
       is_active, is_popular, is_custom, display_order
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     RETURNING *`,
    [
      name,
      slug,
      tagline || null,
      description || null,
      price_monthly_minor,
      price_yearly_minor,
      String(base_currency || "usd").toLowerCase(),
      yearly_discount_pct,
      member_limit,
      max_projects || null,
      max_integrations || null,
      storage_limit_gb || null,
      JSON.stringify(features),
      support_level,
      trial_days,
      grace_period_days,
      is_active,
      is_popular,
      is_custom,
      display_order,
    ]
  );
  return res.rows[0];
}

export async function updatePlan(id, data, { resetProviderPrices = false } = {}) {
  const allowed = [
    "name",
    "tagline",
    "description",
    "price_monthly_minor",
    "price_yearly_minor",
    "base_currency",
    "yearly_discount_pct",
    "member_limit",
    "max_projects",
    "max_integrations",
    "storage_limit_gb",
    "features",
    "support_level",
    "trial_days",
    "grace_period_days",
    "is_active",
    "is_popular",
    "is_custom",
    "display_order",
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

  if (resetProviderPrices) {
    sets.push("stripe_price_monthly_id = NULL");
    sets.push("stripe_price_yearly_id = NULL");
    sets.push("razorpay_plan_monthly_id = NULL");
    sets.push("razorpay_plan_yearly_id = NULL");
    sets.push("repriced_at = now()");
  }

  if (!sets.length) throw new Error("Nothing to update");

  sets.push("updated_at = now()");
  vals.push(id);

  const res = await pool.query(
    `UPDATE billing_plans SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    vals
  );

  if (resetProviderPrices) {
    // Provider objects are immutable and now hold a stale amount. Retire them so
    // the next checkout mints fresh ones; existing subscriptions keep billing on
    // the provider object they were created with.
    await pool.query(
      `UPDATE billing_plan_provider_prices
          SET is_active = false, updated_at = now()
        WHERE plan_id = $1 AND is_active = true`,
      [id]
    );
    // FX-derived local prices were computed from the old base price.
    await pool.query(
      `DELETE FROM billing_plan_prices WHERE plan_id = $1 AND source = 'fx'`,
      [id]
    );
  }

  return res.rows[0];
}

// ── Published price book ─────────────────────────────────────────────────────
//
// Money columns are BIGINT (high-denomination currencies overflow int4) and the
// pg driver hands those back as strings. Normalise here so no caller ever does
// arithmetic on "179900".

function toNumber(value) {
  if (value === null || value === undefined) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

function normalizePlanPrice(row) {
  if (!row) return row;
  return {
    ...row,
    price_monthly_minor: toNumber(row.price_monthly_minor),
    price_yearly_minor: toNumber(row.price_yearly_minor),
    fx_rate: toNumber(row.fx_rate),
  };
}

function normalizeProviderPrice(row) {
  if (!row) return row;
  return { ...row, unit_amount_minor: toNumber(row.unit_amount_minor) };
}

export async function listPlanPrices(planId) {
  const res = await pool.query(
    `SELECT * FROM billing_plan_prices
      WHERE plan_id = $1 AND is_active = true
      ORDER BY currency ASC`,
    [planId]
  );
  return res.rows.map(normalizePlanPrice);
}

export async function listAllPlanPrices() {
  const res = await pool.query(
    `SELECT * FROM billing_plan_prices WHERE is_active = true`
  );
  return res.rows.map(normalizePlanPrice);
}

export async function getPlanPrice(planId, currency) {
  const res = await pool.query(
    `SELECT * FROM billing_plan_prices
      WHERE plan_id = $1 AND currency = $2 AND is_active = true
      LIMIT 1`,
    [planId, String(currency).toLowerCase()]
  );
  return normalizePlanPrice(res.rows[0]) || null;
}

/**
 * Publish a local price. `manual` rows are authoritative and are never replaced
 * by an FX-derived value; that is what makes an admin-set €18 stick.
 */
export async function upsertPlanPrice({
  planId,
  currency,
  price_monthly_minor,
  price_yearly_minor,
  source = "fx",
  fx_rate = null,
  fx_rate_at = null,
}) {
  const res = await pool.query(
    `INSERT INTO billing_plan_prices
       (plan_id, currency, price_monthly_minor, price_yearly_minor, source, fx_rate, fx_rate_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (plan_id, currency)
     DO UPDATE SET
       price_monthly_minor = CASE
         WHEN billing_plan_prices.source = 'manual' AND EXCLUDED.source <> 'manual'
           THEN billing_plan_prices.price_monthly_minor
         ELSE EXCLUDED.price_monthly_minor END,
       price_yearly_minor = CASE
         WHEN billing_plan_prices.source = 'manual' AND EXCLUDED.source <> 'manual'
           THEN billing_plan_prices.price_yearly_minor
         ELSE EXCLUDED.price_yearly_minor END,
       source     = CASE
         WHEN billing_plan_prices.source = 'manual' AND EXCLUDED.source <> 'manual'
           THEN billing_plan_prices.source
         ELSE EXCLUDED.source END,
       fx_rate    = EXCLUDED.fx_rate,
       fx_rate_at = EXCLUDED.fx_rate_at,
       is_active  = true,
       updated_at = now()
     RETURNING *`,
    [
      planId,
      String(currency).toLowerCase(),
      price_monthly_minor,
      price_yearly_minor,
      source,
      fx_rate,
      fx_rate_at,
    ]
  );
  return normalizePlanPrice(res.rows[0]);
}

export async function deletePlanPrice(planId, currency) {
  await pool.query(
    `DELETE FROM billing_plan_prices WHERE plan_id = $1 AND currency = $2`,
    [planId, String(currency).toLowerCase()]
  );
}

// ── Provider price / plan IDs, keyed by currency ─────────────────────────────

export async function getProviderPrice({ planId, provider, currency, interval }) {
  const res = await pool.query(
    `SELECT * FROM billing_plan_provider_prices
      WHERE plan_id = $1 AND provider = $2 AND currency = $3 AND "interval" = $4
        AND is_active = true
      LIMIT 1`,
    [planId, provider, String(currency).toLowerCase(), interval]
  );
  return normalizeProviderPrice(res.rows[0]) || null;
}

export async function saveProviderPrice({
  planId,
  provider,
  currency,
  interval,
  providerPriceId,
  providerProductId = null,
  unitAmountMinor,
}) {
  const res = await pool.query(
    `INSERT INTO billing_plan_provider_prices
       (plan_id, provider, currency, "interval", provider_price_id, provider_product_id, unit_amount_minor)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (plan_id, provider, currency, "interval")
     DO UPDATE SET
       provider_price_id   = EXCLUDED.provider_price_id,
       provider_product_id = COALESCE(EXCLUDED.provider_product_id, billing_plan_provider_prices.provider_product_id),
       unit_amount_minor   = EXCLUDED.unit_amount_minor,
       is_active           = true,
       updated_at          = now()
     RETURNING *`,
    [
      planId,
      provider,
      String(currency).toLowerCase(),
      interval,
      providerPriceId,
      providerProductId,
      unitAmountMinor,
    ]
  );
  return normalizeProviderPrice(res.rows[0]);
}

export async function listProviderPrices(planId, provider = null) {
  const res = await pool.query(
    `SELECT * FROM billing_plan_provider_prices
      WHERE plan_id = $1
        AND ($2::text IS NULL OR provider = $2)
        AND is_active = true
      ORDER BY provider, currency, "interval"`,
    [planId, provider]
  );
  return res.rows.map(normalizeProviderPrice);
}

// ── Legacy single-currency provider columns ──────────────────────────────────
// Still written for the plan's primary currency so older reads keep working.

export async function saveStripePriceIds(id, { productId, monthly, yearly, currency } = {}) {
  const res = await pool.query(
    `UPDATE billing_plans
     SET stripe_product_id       = COALESCE($2, stripe_product_id),
         stripe_price_monthly_id = COALESCE($3, stripe_price_monthly_id),
         stripe_price_yearly_id  = COALESCE($4, stripe_price_yearly_id),
         stripe_currency         = COALESCE($5, stripe_currency),
         updated_at              = now()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      productId || null,
      monthly || null,
      yearly || null,
      currency ? String(currency).toLowerCase() : null,
    ]
  );
  return res.rows[0];
}

export async function saveRazorpayPlanIds(id, { monthly, yearly, currency } = {}) {
  const res = await pool.query(
    `UPDATE billing_plans
     SET razorpay_plan_monthly_id = COALESCE($2, razorpay_plan_monthly_id),
         razorpay_plan_yearly_id  = COALESCE($3, razorpay_plan_yearly_id),
         razorpay_currency        = COALESCE($4, razorpay_currency),
         updated_at               = now()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      monthly || null,
      yearly || null,
      currency ? String(currency).toLowerCase() : null,
    ]
  );
  return res.rows[0];
}

export async function deactivatePlan(id) {
  const res = await pool.query(
    `UPDATE billing_plans
     SET is_active = false, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  return res.rows[0];
}

export async function hardDeletePlan(id) {
  const check = await pool.query(
    `SELECT w.id, w.name
     FROM workspaces w
     JOIN billing_plans bp ON bp.id = $1
     WHERE w.billing_plan = bp.slug OR w.plan = bp.slug
     LIMIT 10`,
    [id]
  );

  if (check.rows.length > 0) {
    const names = check.rows.map((row) => `"${row.name}"`).join(", ");
    const err = new Error(`Plan is in use by ${check.rows.length} workspace(s): ${names}`);
    err.statusCode = 409;
    throw err;
  }

  await pool.query(`DELETE FROM billing_plans WHERE id = $1`, [id]);
}
