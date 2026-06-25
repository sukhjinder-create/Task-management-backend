import { adaptiveScore, compactJson, weightedAdaptiveScore } from "../engine/scorePrimitives.js";

export const SCORING_CONFIG_VERSION = "enterprise-scoring-weights-v1";
export const MIN_WEIGHT = 0.01;
export const MAX_WEIGHT = 0.99;
export const ADMIN_SCORING_CONFIG_GROUP_KEYS = ["userFinalBalance"];

export const SCORING_WEIGHT_GROUP_DEFINITIONS = {
  userFinalBalance: {
    label: "User Score Balance",
    description: "Balances the user's core execution domains against Professional Discipline.",
    type: "pair",
    scoreSurface: "user_intelligence.score",
    slots: {
      core: {
        label: "Core Domains",
        description: "Execution Reliability, Delivery Effectiveness, Collaboration Health, and Work Sustainability.",
      },
      professionalDiscipline: {
        label: "Professional Discipline",
        description: "Attendance, review completion, update hygiene, and workflow compliance.",
      },
    },
    weights: {
      core: 0.82,
      professionalDiscipline: 0.18,
    },
  },
  userCoreDomains: {
    label: "User Core Domain Emphasis",
    description: "Controls the relative emphasis inside the user's core intelligence block.",
    type: "multi",
    scoreSurface: "user_intelligence.score",
    slots: {
      executionReliability: { label: "Execution Reliability" },
      deliveryEffectiveness: { label: "Delivery Effectiveness" },
      collaborationHealth: { label: "Collaboration Health" },
      workSustainability: { label: "Work Sustainability" },
    },
    weights: {
      executionReliability: 0.25,
      deliveryEffectiveness: 0.25,
      collaborationHealth: 0.25,
      workSustainability: 0.25,
    },
  },
  projectIndexes: {
    label: "Project Intelligence Emphasis",
    description: "Controls how project delivery, velocity, scope, dependency, confidence, momentum, and participation indexes form project intelligence.",
    type: "multi",
    scoreSurface: "project_intelligence.score",
    slots: {
      deliveryHealth: { label: "Delivery Health" },
      velocityHealth: { label: "Velocity Health" },
      scopeStability: { label: "Scope Stability" },
      dependencyRisk: { label: "Dependency Risk" },
      completionConfidence: { label: "Completion Confidence" },
      executionMomentum: { label: "Execution Momentum" },
      participationHealth: { label: "Participation Health" },
    },
    weights: {
      deliveryHealth: 1 / 7,
      velocityHealth: 1 / 7,
      scopeStability: 1 / 7,
      dependencyRisk: 1 / 7,
      completionConfidence: 1 / 7,
      executionMomentum: 1 / 7,
      participationHealth: 1 / 7,
    },
  },
  teamIndexes: {
    label: "Team Intelligence Emphasis",
    description: "Controls how team delivery, collaboration, predictability, workload, blocker, and risk indexes form team intelligence.",
    type: "multi",
    scoreSurface: "team_intelligence.score",
    slots: {
      teamPerformanceIndex: { label: "Team Performance" },
      deliveryReliabilityIndex: { label: "Delivery Reliability" },
      collaborationIndex: { label: "Collaboration" },
      executionPredictability: { label: "Execution Predictability" },
      workloadBalanceIndex: { label: "Workload Balance" },
      blockerResolutionHealth: { label: "Blocker Resolution" },
      teamRiskIndex: { label: "Team Risk" },
    },
    weights: {
      teamPerformanceIndex: 1 / 7,
      deliveryReliabilityIndex: 1 / 7,
      collaborationIndex: 1 / 7,
      executionPredictability: 1 / 7,
      workloadBalanceIndex: 1 / 7,
      blockerResolutionHealth: 1 / 7,
      teamRiskIndex: 1 / 7,
    },
  },
  workspaceIndexes: {
    label: "Workspace Health Emphasis",
    description: "Controls how workspace health, productivity, risk, delivery confidence, alignment, execution reality, attendance readiness, and capacity sustainability form workspace intelligence.",
    type: "multi",
    scoreSurface: "workspace_intelligence.score",
    slots: {
      workspaceHealthIndex: { label: "Workspace Health" },
      productivityIndex: { label: "Productivity" },
      strategicRiskIndex: { label: "Strategic Risk" },
      deliveryConfidenceIndex: { label: "Delivery Confidence" },
      organizationalAlignmentIndex: { label: "Organizational Alignment" },
      executionRealityIndex: { label: "Execution Reality" },
      attendanceReadinessIndex: { label: "Attendance Readiness" },
      capacitySustainabilityIndex: { label: "Capacity Sustainability" },
    },
    weights: {
      workspaceHealthIndex: 0.125,
      productivityIndex: 0.125,
      strategicRiskIndex: 0.125,
      deliveryConfidenceIndex: 0.125,
      organizationalAlignmentIndex: 0.125,
      executionRealityIndex: 0.125,
      attendanceReadinessIndex: 0.125,
      capacitySustainabilityIndex: 0.125,
    },
  },
};

function roundWeight(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

function clampWeight(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return MIN_WEIGHT;
  return Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, number));
}

function definitionKeys(definition) {
  return Object.keys(definition.slots || definition.weights || {});
}

function normalizePairWeights({ definition, inputWeights = {}, baseWeights = {}, changedKey = null }) {
  const keys = definitionKeys(definition);
  const [firstKey, secondKey] = keys;
  const providedKeys = keys.filter((key) => Object.prototype.hasOwnProperty.call(inputWeights, key));
  const selectedKey = changedKey && keys.includes(changedKey)
    ? changedKey
    : providedKeys.length === 1
      ? providedKeys[0]
      : null;

  if (selectedKey) {
    const otherKey = keys.find((key) => key !== selectedKey);
    const selected = clampWeight(inputWeights[selectedKey]);
    return {
      [selectedKey]: roundWeight(selected),
      [otherKey]: roundWeight(1 - selected),
    };
  }

  const firstRaw = Number(inputWeights[firstKey] ?? baseWeights[firstKey] ?? definition.weights[firstKey]);
  const secondRaw = Number(inputWeights[secondKey] ?? baseWeights[secondKey] ?? definition.weights[secondKey]);
  const total = firstRaw + secondRaw;
  const first = total > 0 ? clampWeight(firstRaw / total) : definition.weights[firstKey];
  return {
    [firstKey]: roundWeight(first),
    [secondKey]: roundWeight(1 - first),
  };
}

function normalizeMultiWeights({ definition, inputWeights = {}, baseWeights = {} }) {
  const keys = definitionKeys(definition);
  const merged = Object.fromEntries(keys.map((key) => [
    key,
    clampWeight(inputWeights[key] ?? baseWeights[key] ?? definition.weights[key]),
  ]));
  const minTotal = MIN_WEIGHT * keys.length;
  const available = Math.max(0, 1 - minTotal);
  const extras = Object.fromEntries(keys.map((key) => [key, Math.max(0, merged[key] - MIN_WEIGHT)]));
  const extraTotal = Object.values(extras).reduce((sum, value) => sum + value, 0);
  const normalized = {};

  if (extraTotal <= 0) {
    const equal = 1 / keys.length;
    keys.forEach((key) => {
      normalized[key] = roundWeight(equal);
    });
  } else {
    keys.forEach((key) => {
      normalized[key] = roundWeight(MIN_WEIGHT + ((extras[key] / extraTotal) * available));
    });
  }

  const total = keys.reduce((sum, key) => sum + normalized[key], 0);
  const remainder = roundWeight(1 - total);
  if (Math.abs(remainder) >= 0.0001) {
    const targetKey = [...keys].sort((a, b) => normalized[b] - normalized[a])[0];
    normalized[targetKey] = roundWeight(normalized[targetKey] + remainder);
  }

  return normalized;
}

function normalizeGroup(groupKey, groupInput = {}, baseGroup = null) {
  const definition = SCORING_WEIGHT_GROUP_DEFINITIONS[groupKey];
  const inputWeights = groupInput?.weights || groupInput || {};
  const baseWeights = baseGroup?.weights || definition.weights;
  const weights = definition.type === "pair"
    ? normalizePairWeights({
      definition,
      inputWeights,
      baseWeights,
      changedKey: groupInput?.changedKey || groupInput?.updatedKey || null,
    })
    : normalizeMultiWeights({ definition, inputWeights, baseWeights });

  return {
    key: groupKey,
    label: definition.label,
    description: definition.description,
    type: definition.type,
    scoreSurface: definition.scoreSurface,
    constraints: {
      min: MIN_WEIGHT,
      max: MAX_WEIGHT,
      normalizedTotal: 1,
      pairAutoComplements: definition.type === "pair",
    },
    slots: definition.slots,
    weights,
    total: roundWeight(Object.values(weights).reduce((sum, value) => sum + value, 0)),
  };
}

export function defaultScoringConfig() {
  const groups = Object.fromEntries(
    Object.keys(SCORING_WEIGHT_GROUP_DEFINITIONS).map((groupKey) => [
      groupKey,
      normalizeGroup(groupKey),
    ])
  );
  return {
    source: "enterprise_intelligence_scoring_config",
    version: SCORING_CONFIG_VERSION,
    normalized: true,
    constraints: {
      min: MIN_WEIGHT,
      max: MAX_WEIGHT,
      normalizedTotal: 1,
    },
    groups,
  };
}

export function normalizeScoringConfig(input = {}, base = null) {
  const safeInput = compactJson(input) || {};
  const safeBase = base?.groups ? base : defaultScoringConfig();
  const inputGroups = safeInput.groups || {};
  const groups = Object.fromEntries(
    Object.keys(SCORING_WEIGHT_GROUP_DEFINITIONS).map((groupKey) => [
      groupKey,
      normalizeGroup(groupKey, inputGroups[groupKey] || {}, safeBase.groups?.[groupKey]),
    ])
  );
  return {
    ...defaultScoringConfig(),
    workspaceId: safeInput.workspaceId || safeBase.workspaceId || null,
    updatedAt: safeInput.updatedAt || safeBase.updatedAt || null,
    updatedBy: safeInput.updatedBy || safeBase.updatedBy || null,
    groups,
  };
}

export function adminScoringConfigSurface(config = {}) {
  const normalized = config?.groups ? normalizeScoringConfig(config) : defaultScoringConfig();
  const groups = Object.fromEntries(
    ADMIN_SCORING_CONFIG_GROUP_KEYS
      .map((groupKey) => [groupKey, normalized.groups?.[groupKey]])
      .filter(([, group]) => Boolean(group))
  );

  return {
    ...normalized,
    source: "enterprise_intelligence_scoring_config_admin_surface",
    productSurface: "workspace_admin_user_score_balance",
    editableGroupKeys: ADMIN_SCORING_CONFIG_GROUP_KEYS,
    hiddenGroupKeys: Object.keys(normalized.groups || {})
      .filter((groupKey) => !ADMIN_SCORING_CONFIG_GROUP_KEYS.includes(groupKey)),
    groups,
  };
}

export function getScoringGroupWeights(config, groupKey) {
  const normalized = config?.groups ? normalizeScoringConfig(config) : defaultScoringConfig();
  return normalized.groups?.[groupKey]?.weights || SCORING_WEIGHT_GROUP_DEFINITIONS[groupKey]?.weights || {};
}

export function scoreWithScoringConfig(signals = [], config, groupKey, options = {}) {
  const weights = getScoringGroupWeights(config, groupKey);
  const weightedSignals = signals.map((signal) => ({
    ...signal,
    weight: weights[signal.key] ?? signal.weight ?? 1,
  }));
  return weightedAdaptiveScore(weightedSignals, options);
}

export function scoreObjectWithScoringConfig(values = {}, config, groupKey, options = {}) {
  const signals = Object.entries(values).map(([key, value]) => ({ key, value }));
  return scoreWithScoringConfig(signals, config, groupKey, options);
}

export function appliedScoreModel(config, groupKeys = []) {
  const normalized = config?.groups ? normalizeScoringConfig(config) : defaultScoringConfig();
  const selectedGroups = Object.fromEntries(
    groupKeys.map((groupKey) => [groupKey, normalized.groups[groupKey]]).filter(([, group]) => Boolean(group))
  );
  return {
    source: normalized.source,
    version: normalized.version,
    workspaceId: normalized.workspaceId || null,
    updatedAt: normalized.updatedAt || null,
    updatedBy: normalized.updatedBy || null,
    groups: selectedGroups,
  };
}

export default {
  SCORING_CONFIG_VERSION,
  MIN_WEIGHT,
  MAX_WEIGHT,
  ADMIN_SCORING_CONFIG_GROUP_KEYS,
  SCORING_WEIGHT_GROUP_DEFINITIONS,
  defaultScoringConfig,
  normalizeScoringConfig,
  adminScoringConfigSurface,
  getScoringGroupWeights,
  scoreWithScoringConfig,
  scoreObjectWithScoringConfig,
  appliedScoreModel,
};
