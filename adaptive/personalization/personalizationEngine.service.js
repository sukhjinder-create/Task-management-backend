import pool from "../../db.js";
import { clamp } from "../shared/runtimeUtils.js";

const SCOPE_HIERARCHY = Object.freeze([
  "user",
  "team",
  "project",
  "department",
  "workspace",
  "enterprise",
]);

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

function positiveWeight(signalKey) {
  if (signalKey === "recommendation.accepted") return 1;
  if (signalKey === "recommendation.edited") return 0.55;
  if (signalKey === "execution.succeeded") return 0.75;
  if (signalKey === "prediction.accuracy") return 0.25;
  return 0;
}

function negativeWeight(signalKey) {
  if (signalKey === "recommendation.rejected") return 1;
  if (signalKey === "recommendation.ignored") return 0.65;
  if (signalKey === "execution.failed") return 0.8;
  return 0;
}

function collectMapEntry(map, key) {
  if (!key) return null;
  if (!map.has(key)) map.set(key, { positive: 0, negative: 0, samples: 0 });
  return map.get(key);
}

function rankEntries(map) {
  return Array.from(map.entries())
    .map(([key, value]) => ({
      key,
      samples: value.samples,
      score: value.samples ? Math.round(((value.positive - value.negative) / value.samples) * 1000) / 1000 : 0,
      positive: Math.round(value.positive * 1000) / 1000,
      negative: Math.round(value.negative * 1000) / 1000,
    }))
    .sort((left, right) => right.score - left.score || right.samples - left.samples || left.key.localeCompare(right.key));
}

async function upsertProfile({
  workspaceId,
  scopeType,
  scopeId,
  profileKey,
  value,
  confidence,
  sampleCount,
  explanation,
  lastSignalAt,
}) {
  await pool.query(
    `
    INSERT INTO adaptive_preference_profiles (
      workspace_id, scope_type, scope_id, profile_key, profile_value,
      confidence, sample_count, explanation, last_signal_at
    ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)
    ON CONFLICT DO NOTHING
    `,
    [workspaceId, scopeType, scopeId, profileKey, JSON.stringify(value), confidence, sampleCount, explanation, lastSignalAt]
  );
  const { rows } = await pool.query(
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
      AND profile_key = $9
    RETURNING *
    `,
    [JSON.stringify(value), confidence, sampleCount, explanation, lastSignalAt, workspaceId, scopeType, scopeId, profileKey]
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

  return upsertProfile({
    workspaceId,
    scopeType,
    scopeId,
    profileKey: "recommendation_behavior",
    value,
    confidence,
    sampleCount: total,
    explanation,
    lastSignalAt: counts.last_signal_at,
  });
}

async function loadScopedProfiles({
  workspaceId,
  userId = null,
  teamId = null,
  projectId = null,
  departmentId = null,
  enterpriseId = null,
  profileKey,
}) {
  const scopes = [
    ["user", userId],
    ["team", teamId],
    ["project", projectId],
    ["department", departmentId],
    ["workspace", null],
    ["enterprise", enterpriseId],
  ];
  const profiles = await Promise.all(scopes.map(([scopeType, scopeId]) => (
    scopeId || scopeType === "workspace"
      ? getPreferenceProfile({ workspaceId, scopeType, scopeId, profileKey })
      : null
  )));
  return { scopes, profiles };
}

export async function refreshAdaptiveStrategyProfile({ workspaceId, scopeType, scopeId = null }) {
  if (!SCOPE_HIERARCHY.includes(scopeType)) throw new Error(`Unsupported adaptive strategy scope: ${scopeType}`);
  const { rows } = await pool.query(
    `
    SELECT
      l.signal_key,
      l.signal_value,
      l.created_at,
      a.capability_key,
      a.action_type,
      a.approval_mode,
      a.risk_level,
      a.payload,
      a.confidence,
      a.prediction_confidence,
      a.outcome_confidence,
      a.personalization_scope,
      a.personalization_source,
      a.status AS action_status
    FROM adaptive_learning_signals l
    LEFT JOIN operations_ai_actions a
      ON a.id = l.action_id AND a.workspace_id = l.workspace_id
    WHERE l.workspace_id = $1
      AND l.scope_type = $2
      AND l.scope_id IS NOT DISTINCT FROM $3::uuid
      AND l.status = 'active'
      AND l.signal_key IN (
        'recommendation.accepted', 'recommendation.rejected',
        'recommendation.ignored', 'recommendation.edited',
        'execution.succeeded', 'execution.failed', 'prediction.accuracy',
        'memory.pattern.discovered'
      )
    ORDER BY l.created_at DESC
    LIMIT 500
    `,
    [workspaceId, scopeType, scopeId]
  );

  const capabilities = new Map();
  const timings = new Map();
  const approvals = new Map();
  const workflows = new Map();
  let notificationPositive = 0;
  let notificationNegative = 0;
  let lastSignalAt = null;

  for (const row of rows) {
    lastSignalAt ||= row.created_at;
    const patternDirection = row.signal_value?.direction;
    const positive = row.signal_key === "memory.pattern.discovered" && patternDirection === "prefer"
      ? 0.6
      : positiveWeight(row.signal_key);
    const negative = row.signal_key === "memory.pattern.discovered" && ["avoid", "improve"].includes(patternDirection)
      ? 0.6
      : negativeWeight(row.signal_key);
    const capabilityKey = row.capability_key || row.signal_value?.capabilityKey || row.signal_value?.planningDecision?.selectedCapability;
    const capability = collectMapEntry(capabilities, capabilityKey);
    if (capability) {
      capability.positive += positive;
      capability.negative += negative;
      capability.samples += 1;
    }
    const timingKey = row.signal_value?.timing || row.signal_value?.recommendedTiming || row.payload?.metadata?.timing || "unspecified";
    const timing = collectMapEntry(timings, timingKey);
    if (timing) {
      timing.positive += positive;
      timing.negative += negative;
      timing.samples += 1;
    }
    const approvalKey = row.approval_mode || row.signal_value?.approvalMode || "approval_required";
    const approval = collectMapEntry(approvals, approvalKey);
    if (approval) {
      approval.positive += positive;
      approval.negative += negative;
      approval.samples += 1;
    }
    const workflowKey = row.signal_value?.workflowKey || row.signal_value?.workflowPattern || row.payload?.plan?.strategy;
    const workflow = collectMapEntry(workflows, workflowKey);
    if (workflow) {
      workflow.positive += positive;
      workflow.negative += negative;
      workflow.samples += 1;
    }
    if (capabilityKey === "notification.send" || row.action_type?.startsWith("notify")) {
      notificationPositive += positive;
      notificationNegative += negative;
    }
  }

  const capabilityScores = rankEntries(capabilities);
  const timingScores = rankEntries(timings).filter((item) => item.key !== "unspecified");
  const approvalScores = rankEntries(approvals);
  const workflowScores = rankEntries(workflows);
  const preferredCapabilities = capabilityScores.filter((item) => item.samples >= 2 && item.score >= 0.25).slice(0, 5).map((item) => item.key);
  const avoidedCapabilities = capabilityScores.filter((item) => item.samples >= 2 && item.score <= -0.25).slice(0, 5).map((item) => item.key);
  const preferredTiming = timingScores.find((item) => item.samples >= 2 && item.score > 0)?.key || null;
  const approvalWinner = approvalScores.find((item) => item.samples >= 2 && item.score > 0)?.key || null;
  const notificationScore = notificationPositive + notificationNegative
    ? (notificationPositive - notificationNegative) / (notificationPositive + notificationNegative)
    : 0;
  const sampleCount = rows.length;
  const value = {
    preferredCapabilities,
    avoidedCapabilities,
    capabilityScores,
    timingScores,
    preferredTiming,
    approvalBias: approvalWinner === "manual_only" ? "prefer_manual_review"
      : approvalWinner === "automatic" ? "prefer_auto_when_safe"
        : approvalWinner === "approval_required" ? "prefer_approval_gate" : "policy_default",
    approvalScores,
    notificationCadence: notificationScore <= -0.35 ? "digest_or_critical_only"
      : notificationScore >= 0.35 ? "immediate_for_relevant_work" : "policy_default",
    workflowPatterns: {
      preferred: workflowScores.filter((item) => item.samples >= 2 && item.score > 0).slice(0, 3).map((item) => item.key),
      avoided: workflowScores.filter((item) => item.samples >= 2 && item.score < 0).slice(0, 3).map((item) => item.key),
      scores: workflowScores,
    },
    planningBias: {
      preferValidationForSecurity: preferredCapabilities.includes("testing_agent.run_task"),
      preferKnowledgeCapture: preferredCapabilities.includes("workspace_memory.create"),
      avoidNotifications: avoidedCapabilities.includes("notification.send") || notificationScore <= -0.35,
    },
  };
  const confidence = clamp(sampleCount / 30, 0, 1);
  const explanation = sampleCount
    ? `Derived from ${sampleCount} reversible execution, feedback, and prediction signals in this scope.`
    : "No scoped adaptive strategy signals; runtime keeps neutral strategy.";
  return upsertProfile({
    workspaceId,
    scopeType,
    scopeId,
    profileKey: "adaptive_strategy",
    value,
    confidence,
    sampleCount,
    explanation,
    lastSignalAt,
  });
}

export async function recommendationAcceptancePrior({
  workspaceId,
  userId = null,
  teamId = null,
  projectId = null,
  departmentId = null,
  enterpriseId = null,
}) {
  const { scopes, profiles } = await loadScopedProfiles({
    workspaceId,
    userId,
    teamId,
    projectId,
    departmentId,
    enterpriseId,
    profileKey: "recommendation_behavior",
  });
  const selected = profiles.find((profile) => Number(profile?.sample_count || 0) >= 3)
    || profiles.find(Boolean)
    || null;
  return {
    probability: clamp(selected?.profile_value?.acceptanceRate ?? 0.65, 0.05, 0.95),
    source: selected ? `${selected.scope_type}_profile_v${selected.version}` : "neutral_prior",
    explanation: selected?.explanation || "No sufficient scoped feedback; using a conservative prior.",
    scopeType: selected?.scope_type || "default",
    scopeId: selected?.scope_id || null,
    sampleCount: Number(selected?.sample_count || 0),
    hierarchy: scopes.map(([scopeType]) => scopeType),
  };
}

export async function adaptiveStrategyPrior({
  workspaceId,
  userId = null,
  teamId = null,
  projectId = null,
  departmentId = null,
  enterpriseId = null,
}) {
  const { scopes, profiles } = await loadScopedProfiles({
    workspaceId,
    userId,
    teamId,
    projectId,
    departmentId,
    enterpriseId,
    profileKey: "adaptive_strategy",
  });
  const selected = profiles.find((profile) => Number(profile?.sample_count || 0) >= 3)
    || profiles.find(Boolean)
    || null;
  const value = selected?.profile_value || {};
  return {
    source: selected ? `${selected.scope_type}_adaptive_strategy_v${selected.version}` : "neutral_strategy",
    scopeType: selected?.scope_type || "default",
    scopeId: selected?.scope_id || null,
    sampleCount: Number(selected?.sample_count || 0),
    confidence: Number(selected?.confidence || 0),
    explanation: selected?.explanation || "No sufficient scoped adaptive strategy; using neutral planning policy.",
    preferredCapabilities: value.preferredCapabilities || [],
    avoidedCapabilities: value.avoidedCapabilities || [],
    preferredTiming: value.preferredTiming || null,
    approvalBias: value.approvalBias || "policy_default",
    notificationCadence: value.notificationCadence || "policy_default",
    workflowPatterns: value.workflowPatterns || { preferred: [], avoided: [], scores: [] },
    planningBias: value.planningBias || {},
    hierarchy: scopes.map(([scopeType]) => scopeType),
  };
}
