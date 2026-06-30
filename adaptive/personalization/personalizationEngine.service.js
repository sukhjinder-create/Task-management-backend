import pool from "../../db.js";
import { clamp } from "../shared/runtimeUtils.js";

export async function getPreferenceProfile({ workspaceId, scopeType, scopeId = null, profileKey }) {
  const { rows } = await pool.query(
    `
    SELECT * FROM adaptive_preference_profiles
    WHERE workspace_id = $1
      AND scope_type = $2
      AND scope_id IS NOT DISTINCT FROM $3::uuid
      AND profile_key = $4
    LIMIT 1
    `,
    [workspaceId, scopeType, scopeId, profileKey]
  );
  return rows[0] || null;
}

export async function refreshRecommendationProfile({ workspaceId, scopeType, scopeId = null }) {
  const { rows } = await pool.query(
    `
    SELECT
      COUNT(*) FILTER (WHERE signal_key = 'recommendation.accepted')::int AS accepted,
      COUNT(*) FILTER (WHERE signal_key = 'recommendation.rejected')::int AS rejected,
      COUNT(*) FILTER (WHERE signal_key = 'recommendation.ignored')::int AS ignored,
      COUNT(*) FILTER (WHERE signal_key = 'recommendation.edited')::int AS edited,
      MAX(created_at) AS last_signal_at
    FROM adaptive_learning_signals
    WHERE workspace_id = $1
      AND scope_type = $2
      AND scope_id IS NOT DISTINCT FROM $3::uuid
      AND status = 'active'
      AND signal_key IN (
        'recommendation.accepted', 'recommendation.rejected',
        'recommendation.ignored', 'recommendation.edited'
      )
    `,
    [workspaceId, scopeType, scopeId]
  );
  const counts = rows[0] || {};
  const total = Number(counts.accepted || 0) + Number(counts.rejected || 0)
    + Number(counts.ignored || 0) + Number(counts.edited || 0);
  const acceptanceRate = total ? (Number(counts.accepted || 0) + (Number(counts.edited || 0) * 0.5)) / total : 0.5;
  const confidence = clamp(total / 20, 0, 1);
  const value = {
    accepted: Number(counts.accepted || 0),
    rejected: Number(counts.rejected || 0),
    ignored: Number(counts.ignored || 0),
    edited: Number(counts.edited || 0),
    acceptanceRate: Math.round(acceptanceRate * 1000) / 1000,
  };
  const explanation = total
    ? `Derived from ${total} reversible recommendation feedback signals in this scope.`
    : "No feedback history; neutral behavior prior retained.";

  await pool.query(
    `
    INSERT INTO adaptive_preference_profiles (
      workspace_id, scope_type, scope_id, profile_key, profile_value,
      confidence, sample_count, explanation, last_signal_at
    ) VALUES ($1,$2,$3,'recommendation_behavior',$4::jsonb,$5,$6,$7,$8)
    ON CONFLICT DO NOTHING
    `,
    [workspaceId, scopeType, scopeId, JSON.stringify(value), confidence, total, explanation, counts.last_signal_at]
  );
  const { rows: updated } = await pool.query(
    `
    UPDATE adaptive_preference_profiles
    SET profile_value = $1::jsonb,
        confidence = $2,
        sample_count = $3,
        explanation = $4,
        last_signal_at = $5,
        version = version + 1,
        updated_at = NOW()
    WHERE workspace_id = $6
      AND scope_type = $7
      AND scope_id IS NOT DISTINCT FROM $8::uuid
      AND profile_key = 'recommendation_behavior'
    RETURNING *
    `,
    [JSON.stringify(value), confidence, total, explanation, counts.last_signal_at, workspaceId, scopeType, scopeId]
  );
  return updated[0] || null;
}

export async function recommendationAcceptancePrior({ workspaceId, userId = null }) {
  const profile = userId
    ? await getPreferenceProfile({ workspaceId, scopeType: "user", scopeId: userId, profileKey: "recommendation_behavior" })
    : null;
  const workspaceProfile = await getPreferenceProfile({
    workspaceId,
    scopeType: "workspace",
    scopeId: null,
    profileKey: "recommendation_behavior",
  });
  const selected = profile?.sample_count >= 3 ? profile : workspaceProfile;
  return {
    probability: clamp(selected?.profile_value?.acceptanceRate ?? 0.65, 0.05, 0.95),
    source: selected ? `${selected.scope_type}_profile_v${selected.version}` : "neutral_prior",
    explanation: selected?.explanation || "No sufficient scoped feedback; using a conservative prior.",
  };
}
