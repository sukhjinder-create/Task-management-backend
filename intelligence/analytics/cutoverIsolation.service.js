export const CUTOVER_ISOLATION_SOURCE = "legacy_isolated_non_core";

export function buildCutoverIsolation({
  surface,
  reason,
  replacement = "enterprise_intelligence",
}) {
  return {
    surface,
    source: CUTOVER_ISOLATION_SOURCE,
    intelligenceAuthority: "not_authoritative_for_enterprise_cutover",
    cutoverStatus: "excluded_from_enterprise_intelligence_cutover",
    legacyReachable: true,
    dashboardEligible: false,
    replacement,
    reason,
  };
}

export function withLegacyIsolation(payload, options) {
  const isolation = buildCutoverIsolation(options);

  if (Array.isArray(payload)) {
    return payload.map((item) => (
      item && typeof item === "object"
        ? {
          ...item,
          source: CUTOVER_ISOLATION_SOURCE,
          legacyIsolated: true,
          cutover: isolation,
        }
        : item
    ));
  }

  return {
    ...(payload || {}),
    source: CUTOVER_ISOLATION_SOURCE,
    legacyIsolated: true,
    cutover: isolation,
  };
}

export default {
  CUTOVER_ISOLATION_SOURCE,
  buildCutoverIsolation,
  withLegacyIsolation,
};
