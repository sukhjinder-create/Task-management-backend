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
    `SELECT *
     FROM billing_plans
     WHERE is_active = true
       AND ($1 = stripe_price_monthly_id OR $1 = stripe_price_yearly_id)
     LIMIT 1`,
    [priceId]
  );
  return res.rows[0] || null;
}

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
      name,
      slug,
      tagline || null,
      description || null,
      price_monthly_paise,
      price_yearly_paise,
      yearly_discount_pct,
      member_limit,
      max_projects || null,
      max_integrations || null,
      storage_limit_gb || null,
      JSON.stringify(features),
      support_level,
      trial_days,
      grace_period_days,
      is_popular,
      is_custom,
      display_order,
    ]
  );
  return res.rows[0];
}

export async function updatePlan(id, data) {
  const allowed = [
    "name",
    "tagline",
    "description",
    "price_monthly_paise",
    "price_yearly_paise",
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

  if (!sets.length) throw new Error("Nothing to update");

  sets.push("updated_at = now()");
  vals.push(id);

  const res = await pool.query(
    `UPDATE billing_plans SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    vals
  );
  return res.rows[0];
}

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
