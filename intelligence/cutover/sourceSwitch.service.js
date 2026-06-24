import {
  CUTOVER_MODES,
  resolveEnterpriseIntelligenceCutoverPolicy,
  setCutoverHeaders,
  withCutoverMetadata,
} from "./enterpriseIntelligenceCutover.policy.js";

function scoreFromPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  return (
    payload.score ??
    payload.healthScore ??
    payload.scoreCard?.unifiedScore ??
    payload.orgScore?.averageScore ??
    null
  );
}

function chartCount(payload) {
  return Array.isArray(payload?.visualizations?.charts)
    ? payload.visualizations.charts.length
    : null;
}

function summarize(payload) {
  return {
    score: scoreFromPayload(payload),
    chartCount: chartCount(payload),
    hasCutoverMetadata: Boolean(payload?.cutover),
    source: payload?.source || null,
  };
}

export function recordCutoverObservation({ workspaceId, surface, policy, selectedSource, payload, shadowPayload = null, error = null }) {
  const event = {
    workspaceId,
    surface,
    mode: policy.mode,
    policySource: policy.policySource,
    selectedSource,
    selected: summarize(payload),
    shadow: shadowPayload ? summarize(shadowPayload) : null,
    error: error ? { message: error.message, code: error.code || null } : null,
  };
  const logger = error ? console.warn : console.info;
  logger("[enterprise-intelligence-cutover]", event);
}

export async function resolveCutoverResponse({
  workspaceId,
  surface,
  res = null,
  unified,
  legacy = null,
  shadow = null,
  metadata = {},
}) {
  const policy = await resolveEnterpriseIntelligenceCutoverPolicy({ workspaceId, surface });
  setCutoverHeaders(res, policy);

  if (policy.mode === CUTOVER_MODES.LEGACY) {
    if (!legacy) {
      const payload = await unified();
      recordCutoverObservation({ workspaceId, surface, policy, selectedSource: "enterprise_intelligence", payload });
      return withCutoverMetadata(payload, { ...policy, selectedSource: "enterprise_intelligence" }, {
        ...metadata,
        rollbackSupported: false,
        legacyFallbackAvailable: false,
      });
    }
    const payload = await legacy();
    recordCutoverObservation({ workspaceId, surface, policy, selectedSource: "legacy_scoring_rollback", payload });
    return withCutoverMetadata(payload, policy, {
      ...metadata,
      legacyFallbackAvailable: true,
    });
  }

  if (policy.mode === CUTOVER_MODES.SHADOW) {
    const primary = legacy ? await legacy() : await unified();
    const shadowRunner = shadow || unified;
    let shadowPayload = null;
    try {
      shadowPayload = await shadowRunner();
    } catch (err) {
      recordCutoverObservation({
        workspaceId,
        surface,
        policy,
        selectedSource: legacy ? "legacy_scoring_rollback" : "enterprise_intelligence",
        payload: primary,
        error: err,
      });
    }
    recordCutoverObservation({
      workspaceId,
      surface,
      policy,
      selectedSource: legacy ? "legacy_scoring_rollback" : "enterprise_intelligence",
      payload: primary,
      shadowPayload,
    });
    return withCutoverMetadata(primary, policy, {
      ...metadata,
      shadowCompared: Boolean(shadowPayload),
      userFacingSource: legacy ? "legacy_scoring_rollback" : "enterprise_intelligence",
      shadowSource: shadowPayload ? "enterprise_intelligence" : null,
    });
  }

  const payload = await unified();
  recordCutoverObservation({ workspaceId, surface, policy, selectedSource: "enterprise_intelligence", payload });
  return withCutoverMetadata(payload, policy, {
    ...metadata,
    legacyFallbackAvailable: Boolean(legacy),
  });
}

export default {
  resolveCutoverResponse,
  recordCutoverObservation,
};
