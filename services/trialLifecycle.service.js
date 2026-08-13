import db from "../db.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const SELF_SERVE_TRIAL_DAYS = 7;
export const TRIAL_FALLBACK_PLAN_SLUG = String(
  process.env.TRIAL_FALLBACK_PLAN_SLUG || "starter"
).trim().toLowerCase();

function validDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function normalizeBillingInterval(interval) {
  return interval === "yearly" ? "yearly" : "monthly";
}

export function buildNoCardTrialMetadata({
  metadata = null,
  selectedPlan,
  interval = "monthly",
  currency = null,
} = {}) {
  const root = plainObject(metadata);
  const onboarding = plainObject(root.onboarding);

  return {
    ...root,
    onboarding: {
      ...onboarding,
      source: "self_serve",
      schema_version: 1,
      trial: {
        selected_plan_id: selectedPlan?.id || null,
        selected_plan_slug: selectedPlan?.slug || null,
        selected_plan_name: selectedPlan?.name || null,
        billing_interval: normalizeBillingInterval(interval),
        currency: currency ? String(currency).trim().toLowerCase() : null,
        duration_days: SELF_SERVE_TRIAL_DAYS,
        started_without_payment: true,
      },
    },
  };
}

export function getTrialIntent(workspace) {
  const trial = plainObject(plainObject(workspace?.metadata).onboarding?.trial);
  return {
    selectedPlanId: trial.selected_plan_id || null,
    selectedPlanSlug: trial.selected_plan_slug || null,
    selectedPlanName: trial.selected_plan_name || null,
    billingInterval: normalizeBillingInterval(trial.billing_interval),
    currency: trial.currency || null,
    durationDays: Number(trial.duration_days) || SELF_SERVE_TRIAL_DAYS,
    startedWithoutPayment: trial.started_without_payment === true,
  };
}

export function describeTrialLifecycle(
  workspace,
  now = new Date(),
  fallbackPlanSlug = TRIAL_FALLBACK_PLAN_SLUG
) {
  const trialEndsAt = validDate(workspace?.trial_ends_at);
  const currentPlan = workspace?.billing_plan || workspace?.plan || null;
  const onTrial = !!trialEndsAt && trialEndsAt.getTime() > now.getTime();
  const trialCompleted = !!trialEndsAt && !onTrial;
  const intent = getTrialIntent(workspace);
  const isFallbackPlan = String(currentPlan || "").toLowerCase() === fallbackPlanSlug;
  const paymentSetupRequired =
    trialCompleted &&
    intent.startedWithoutPayment &&
    (!currentPlan || isFallbackPlan);

  return {
    onTrial,
    trialCompleted,
    trialEndsAt: trialEndsAt ? trialEndsAt.toISOString() : null,
    currentPlan,
    fallbackPlan: fallbackPlanSlug,
    paymentSetupRequired,
    trialDowngraded: paymentSetupRequired && isFallbackPlan,
    intent,
  };
}

export function getProviderTrialDays(workspace, plan) {
  // A workspace-level trial is authoritative. Once it exists, provider checkout
  // must never mint another trial and silently extend the original seven days.
  if (validDate(workspace?.trial_ends_at)) return 0;
  return Math.max(0, Number(plan?.trial_days) || 0);
}

export function assertWorkspaceTrialAllowsPaymentSetup(workspace, now = new Date()) {
  const trialEndsAt = validDate(workspace?.trial_ends_at);
  if (!trialEndsAt || trialEndsAt.getTime() <= now.getTime()) return;

  const err = new Error("Payment setup becomes available when the free trial ends.");
  err.statusCode = 409;
  err.code = "TRIAL_STILL_ACTIVE";
  err.availableAt = trialEndsAt.toISOString();
  throw err;
}

export async function reconcileExpiredWorkspaceTrial(
  workspaceId,
  { database = db, fallbackPlanSlug = TRIAL_FALLBACK_PLAN_SLUG, now = new Date() } = {}
) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const workspaceRes = await client.query(
      `SELECT * FROM workspaces WHERE id = $1 LIMIT 1 FOR UPDATE`,
      [workspaceId]
    );
    const workspace = workspaceRes.rows[0] || null;
    const state = describeTrialLifecycle(workspace, now, fallbackPlanSlug);

    if (!workspace || !state.trialCompleted || state.currentPlan) {
      await client.query("COMMIT");
      return { workspace, downgraded: false, state };
    }

    const fallbackRes = await client.query(
      `SELECT slug, name, member_limit
         FROM billing_plans
        WHERE slug = $1
          AND is_active = true
          AND COALESCE(price_monthly_minor, 0) = 0
          AND COALESCE(price_yearly_minor, 0) = 0
        LIMIT 1`,
      [fallbackPlanSlug]
    );
    const fallback = fallbackRes.rows[0];
    if (!fallback) {
      throw new Error(`Active free fallback plan '${fallbackPlanSlug}' was not found.`);
    }

    const updatedRes = await client.query(
      `UPDATE workspaces
          SET billing_plan      = $2,
              plan              = $2,
              billing_status    = 'active',
              member_limit      = $3,
              max_members       = $3,
              billing_updated_at = now(),
              updated_at        = now()
        WHERE id = $1
        RETURNING *`,
      [workspaceId, fallback.slug, fallback.member_limit]
    );

    // Downgrading the workspace must not lock existing trial members out of
    // their data. The Starter member limit still governs future additions.
    await client.query(
      `UPDATE workspace_users
          SET billing_status = 'active',
              activated_at   = COALESCE(activated_at, now())
        WHERE workspace_id = $1
          AND billing_status = 'trial'`,
      [workspaceId]
    );

    await client.query("COMMIT");
    const updatedWorkspace = updatedRes.rows[0];
    return {
      workspace: updatedWorkspace,
      downgraded: true,
      state: describeTrialLifecycle(updatedWorkspace, now, fallbackPlanSlug),
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function reconcileExpiredWorkspaceTrials({ database = db, limit = 100 } = {}) {
  const batchLimit = Math.max(1, Math.min(Number(limit) || 100, 1000));
  const { rows } = await database.query(
    `SELECT id
       FROM workspaces
      WHERE trial_ends_at IS NOT NULL
        AND trial_ends_at <= now()
        AND billing_plan IS NULL
      ORDER BY trial_ends_at ASC
      LIMIT $1`,
    [batchLimit]
  );

  let downgraded = 0;
  const failures = [];
  for (const row of rows) {
    try {
      const result = await reconcileExpiredWorkspaceTrial(row.id, { database });
      if (result.downgraded) downgraded += 1;
    } catch (err) {
      failures.push({ workspaceId: row.id, error: err.message });
    }
  }

  return { scanned: rows.length, downgraded, failures };
}

export function trialEndFrom(start = new Date()) {
  return new Date(start.getTime() + SELF_SERVE_TRIAL_DAYS * DAY_MS);
}
